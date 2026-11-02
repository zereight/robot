import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import {
  ATTACH_BYTES,
  ATTACH_MAX,
  UPLOAD_PREFIX,
  type UploadAck,
  type UploadChunk,
} from "@robot/shared"

/** A client that sends a file in pieces. The pieces wait here until "send message" uses them. */

const MAX_AGE_MS = 15 * 60 * 1000

interface Pending {
  readonly device: string
  readonly dir: string
  readonly name: string
  size: number
  done: boolean
  readonly started: number
}

export class UploadError extends Error {
  constructor(
    readonly code: "file_too_large" | "too_many_files" | "invalid_input" | "upload_gone",
  ) {
    super(code)
  }
}

/** Keeps a file name plain: no folders, no control characters, not empty. */
export const safeName = (name: string) => {
  const base = basename(name.replace(/\\/g, "/"))
  const plain = [...base]
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .trim()
  return plain && plain !== "." && plain !== ".." ? plain.slice(0, 200) : "file"
}

export class Uploads {
  readonly #root: string
  readonly #pending = new Map<string, Pending>()
  readonly #now: () => number

  constructor(root: string, now: () => number = Date.now) {
    this.#root = root
    this.#now = now
    // Files that a run before this one left are of no use.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  }

  #sweep() {
    const limit = this.#now() - MAX_AGE_MS
    for (const [id, p] of this.#pending) {
      if (p.started < limit) this.discard(id)
    }
  }

  /** Takes one piece. The last piece gives a token. */
  put(device: string, chunk: UploadChunk): UploadAck {
    this.#sweep()
    if (
      typeof chunk.uploadId !== "string" ||
      chunk.uploadId.length === 0 ||
      chunk.uploadId.length > 64
    ) {
      throw new UploadError("invalid_input")
    }
    const key = `${device}:${chunk.uploadId}`
    let pending = this.#pending.get(key)
    if (!pending) {
      if (chunk.offset !== 0) throw new UploadError("upload_gone")
      const open = [...this.#pending.values()].filter((p) => p.device === device).length
      if (open >= ATTACH_MAX) throw new UploadError("too_many_files")
      const dir = join(this.#root, randomUUID())
      mkdirSync(dir, { recursive: true })
      const name = safeName(chunk.name)
      writeFileSync(join(dir, name), "")
      pending = { device, dir, name, size: 0, done: false, started: this.#now() }
      this.#pending.set(key, pending)
    }
    if (pending.done || chunk.offset !== pending.size) throw new UploadError("invalid_input")
    const bytes = Buffer.from(String(chunk.data), "base64")
    if (pending.size + bytes.length > ATTACH_BYTES) {
      this.discard(key)
      throw new UploadError("file_too_large")
    }
    appendFileSync(join(pending.dir, pending.name), bytes)
    pending.size += bytes.length
    if (!chunk.done) return { size: pending.size, token: null }
    pending.done = true
    return { size: pending.size, token: `${UPLOAD_PREFIX}${key}` }
  }

  /** The stored file of a token that this device got, or undefined. */
  resolve(device: string, token: string): string | undefined {
    if (!token.startsWith(UPLOAD_PREFIX)) return undefined
    const key = token.slice(UPLOAD_PREFIX.length)
    const pending = this.#pending.get(key)
    if (!pending?.done || pending.device !== device || !key.startsWith(`${device}:`)) {
      return undefined
    }
    const path = join(pending.dir, pending.name)
    return existsSync(path) && statSync(path).isFile() ? path : undefined
  }

  /** Removes the stored file of a token, after the message used it. */
  discard(tokenOrKey: string) {
    const key = tokenOrKey.startsWith(UPLOAD_PREFIX)
      ? tokenOrKey.slice(UPLOAD_PREFIX.length)
      : tokenOrKey
    const pending = this.#pending.get(key)
    if (!pending) return
    this.#pending.delete(key)
    rmSync(pending.dir, { recursive: true, force: true })
  }

  /** Removes every file of a device, when its link ends or its connection closes. */
  discardDevice(device: string) {
    for (const [key, p] of this.#pending) if (p.device === device) this.discard(key)
  }

  get count() {
    return this.#pending.size
  }
}
