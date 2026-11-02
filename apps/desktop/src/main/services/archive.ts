import { createReadStream, createWriteStream, rmSync } from "node:fs"
import { extname } from "node:path"
import { pipeline, Readable } from "node:stream"
import { crc32, createDeflateRaw } from "node:zlib"
import { type AsyncFlateStreamHandler, Zip, type ZipInputFile, ZipPassThrough } from "fflate"

/**
 * Writes a ZIP archive without holding the files in memory and without blocking the main process.
 *
 * - Each file is read from the disk in pieces and written out at once.
 * - A file that is packed already (a picture, a video, a ZIP) is only stored. To deflate it again
 *   costs time and gains nothing.
 * - Any other file is deflated by `node:zlib`. It runs in the thread pool of the system, so the
 *   chats and sync go on while the archive is made, and it is faster than a JavaScript deflate.
 *
 * The archive is the same format as before: any ZIP reader opens it.
 */

export type ArchiveFile = { readonly name: string; readonly store?: boolean } & (
  | { readonly path: string }
  | { readonly data: Uint8Array }
)

/** Formats that are compressed in themselves. Deflating them again gains next to nothing. */
const PACKED = new Set([
  // pictures
  ...[".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".avif"],
  // sound and video
  ...[".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac"],
  ...[".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"],
  // archives, and documents that are archives
  ...[".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst"],
  ...[".docx", ".xlsx", ".pptx", ".pages", ".numbers", ".key", ".epub", ".jar"],
])

/** True when a file of this name is packed already. */
export const isPacked = (name: string) => PACKED.has(extname(name).toLowerCase())

/** The level of the deflate. It was 6 when the archive was made in JavaScript. */
const LEVEL = 6

/** A file of the archive that `node:zlib` deflates. `Zip` accepts any object of this shape. */
class DeflatedFile implements ZipInputFile {
  size = 0
  crc = 0
  compression = 8
  ondata!: AsyncFlateStreamHandler
  constructor(readonly filename: string) {}
}

const bytesOf = (file: ArchiveFile): Readable =>
  "path" in file
    ? createReadStream(file.path)
    : Readable.from([Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength)], {
        objectMode: false,
      })

/**
 * Writes `files` to `target`, in the order given. A failure removes the half-written file and
 * throws the error.
 */
export const writeZip = async (target: string, files: Iterable<ArchiveFile>): Promise<void> => {
  const out = createWriteStream(target)
  let failure: Error | undefined
  out.on("error", (error) => {
    failure ??= error
  })

  const zip = new Zip((error, chunk) => {
    if (error) failure ??= error
    else out.write(chunk)
  })

  // The writer is slower than the reader at times. Wait for it, so the pieces do not pile up.
  const flow = async () => {
    if (failure) throw failure
    if (out.writableNeedDrain)
      await new Promise<void>((resolve) => {
        const done = () => {
          out.off("drain", done)
          out.off("close", done)
          resolve()
        }
        out.on("drain", done)
        out.on("close", done)
      })
    if (failure) throw failure
  }

  try {
    for (const file of files) {
      if (file.store || isPacked(file.name)) {
        const stored = new ZipPassThrough(file.name)
        zip.add(stored)
        for await (const chunk of bytesOf(file)) {
          stored.push(chunk, false)
          await flow()
        }
        stored.push(new Uint8Array(0), true)
      } else {
        const deflated = new DeflatedFile(file.name)
        zip.add(deflated)
        const source = bytesOf(file)
        // The pipeline closes the file and the deflate together when either one fails. The error
        // comes out of the loop below, so this callback has nothing to do.
        const packer = pipeline(source, createDeflateRaw({ level: LEVEL }), () => {})
        source.on("data", (chunk: Buffer) => {
          deflated.size += chunk.length
          deflated.crc = crc32(chunk, deflated.crc)
        })
        for await (const chunk of packer) {
          deflated.ondata(null, chunk, false)
          await flow()
        }
        // The size and the check value are known now. The archive writes them after the data.
        deflated.ondata(null, new Uint8Array(0), true)
      }
      await flow()
    }
    zip.end()
    await flow()
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject)
      out.end(resolve)
    })
    if (failure) throw failure
  } catch (error) {
    out.destroy()
    rmSync(target, { force: true })
    throw error
  }
}
