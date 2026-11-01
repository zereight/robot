import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import type { RuntimeKind } from "@robot/shared"
import { binaryName, managedDir } from "./locate.ts"

export const CLAUDE_DIST = "https://downloads.claude.ai/claude-code-releases"
export const CODEX_API = "https://api.github.com"

export interface InstallOptions {
  readonly dataDir: string
  readonly signal: AbortSignal
  /** 0 to 1, or null when the size is not known. */
  readonly onProgress: (fraction: number | null) => void
  /** Where the releases are. Tests and mirrors set these. */
  readonly claudeDist?: string
  readonly codexApi?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

const VERSION = /^\d+\.\d+\.\d+[\w.-]*$/
const SHA256 = /^[a-f0-9]{64}$/

class InstallError extends Error {}

const get = async (url: string, signal: AbortSignal, headers: Record<string, string> = {}) => {
  const response = await fetch(url, {
    signal,
    headers: { "user-agent": "ROBot", ...headers },
    redirect: "follow",
  })
  if (!response.ok) throw new InstallError(`${response.status} ${response.statusText} (${url})`)
  return response
}

const isMusl = () => {
  if (process.platform !== "linux") return false
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
  return report?.header?.glibcVersionRuntime === undefined
}

/** The platform name in the release list of Claude Code. */
export const claudePlatform = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = isMusl(),
) => {
  if (arch !== "x64" && arch !== "arm64") throw new InstallError(`Unsupported processor: ${arch}`)
  if (platform === "darwin") return `darwin-${arch}`
  if (platform === "win32") return `win32-${arch}`
  if (platform === "linux") return `linux-${arch}${musl ? "-musl" : ""}`
  throw new InstallError(`Unsupported system: ${platform}`)
}

/** The file name of the Codex release for this computer. */
export const codexAsset = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) => {
  if (arch !== "x64" && arch !== "arm64") throw new InstallError(`Unsupported processor: ${arch}`)
  const cpu = arch === "x64" ? "x86_64" : "aarch64"
  if (platform === "darwin") return `codex-${cpu}-apple-darwin.tar.gz`
  if (platform === "linux") return `codex-${cpu}-unknown-linux-musl.tar.gz`
  if (platform === "win32") return `codex-${cpu}-pc-windows-msvc.exe.tar.gz`
  throw new InstallError(`Unsupported system: ${platform}`)
}

/** Saves a download to a file. Returns its SHA-256 and size. */
const download = async (
  url: string,
  file: string,
  options: { signal: AbortSignal; size: number | null; onProgress: InstallOptions["onProgress"] },
) => {
  const response = await get(url, options.signal)
  const total = options.size ?? (Number(response.headers.get("content-length")) || null)
  if (!response.body) throw new InstallError("The download has no content.")
  const hash = createHash("sha256")
  let seen = 0
  const counted = async function* (body: AsyncIterable<Uint8Array>) {
    for await (const chunk of body) {
      hash.update(chunk)
      seen += chunk.length
      options.onProgress(total ? Math.min(1, seen / total) : null)
      yield chunk
    }
  }
  await pipeline(
    Readable.from(counted(response.body as unknown as AsyncIterable<Uint8Array>)),
    createWriteStream(file),
    { signal: options.signal },
  )
  return { sha256: hash.digest("hex"), size: seen }
}

/** Finds the first normal file in a tar: where its data starts, and its size. */
export const firstTarFile = (file: string): { start: number; size: number; name: string } => {
  const fd = openSync(file, "r")
  try {
    const header = Buffer.alloc(512)
    let offset = 0
    for (;;) {
      if (readSync(fd, header, 0, 512, offset) < 512 || header.every((b) => b === 0))
        throw new InstallError("The archive holds no file.")
      const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "")
      const size = Number.parseInt(
        header.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim(),
        8,
      )
      const type = String.fromCharCode(header[156] ?? 0)
      if (!Number.isFinite(size)) throw new InstallError("The archive is damaged.")
      if (type === "0" || type === "\0") return { start: offset + 512, size, name }
      offset += 512 + Math.ceil(size / 512) * 512
    }
  } finally {
    closeSync(fd)
  }
}

/** Unpacks the first file of a `.tar.gz` to `destination`. Nothing else is written. */
export const unpackFirstFile = async (archive: string, destination: string) => {
  const tar = `${archive}.tar`
  await pipeline(createReadStream(archive), createGunzip(), createWriteStream(tar))
  try {
    const { start, size } = firstTarFile(tar)
    await pipeline(
      createReadStream(tar, { start, end: start + size - 1 }),
      createWriteStream(destination),
    )
  } finally {
    rmSync(tar, { force: true })
  }
}

const finish = (dataDir: string, kind: RuntimeKind, version: string) => {
  const root = managedDir(dataDir, kind)
  const current = join(root, "current.json")
  writeFileSync(`${current}.part`, JSON.stringify({ version }))
  renameSync(`${current}.part`, current)
  // Older copies are not needed any more. A copy that runs right now stays on a failure.
  for (const entry of readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name !== version)
      rmSync(join(root, entry.name), { recursive: true, force: true })
}

const installClaude = async (options: InstallOptions): Promise<string> => {
  const base = (options.claudeDist ?? CLAUDE_DIST).replace(/\/+$/, "")
  const version = (await (await get(`${base}/latest`, options.signal)).text()).trim()
  if (!VERSION.test(version)) throw new InstallError("The release list gave no version.")
  const key = claudePlatform(options.platform, options.arch)
  const manifest = (await (
    await get(`${base}/${version}/manifest.json`, options.signal)
  ).json()) as {
    platforms?: Record<string, { checksum?: string; size?: number; binary?: string }>
  }
  const entry = manifest.platforms?.[key]
  if (!entry?.checksum || !SHA256.test(entry.checksum))
    throw new InstallError(`The release has no program for ${key}.`)
  const name = binaryName("claude_code", options.platform)
  const dir = join(managedDir(options.dataDir, "claude_code"), version)
  mkdirSync(dir, { recursive: true })
  const part = join(dir, `${name}.part`)
  try {
    const got = await download(`${base}/${version}/${key}/${entry.binary ?? name}`, part, {
      signal: options.signal,
      size: typeof entry.size === "number" ? entry.size : null,
      onProgress: options.onProgress,
    })
    if (got.sha256 !== entry.checksum)
      throw new InstallError("The checksum of the download is wrong.")
    chmodSync(part, 0o755)
    renameSync(part, join(dir, name))
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  finish(options.dataDir, "claude_code", version)
  return version
}

const installCodex = async (options: InstallOptions): Promise<string> => {
  const api = (options.codexApi ?? CODEX_API).replace(/\/+$/, "")
  const release = (await (
    await get(`${api}/repos/openai/codex/releases/latest`, options.signal, {
      accept: "application/vnd.github+json",
    })
  ).json()) as {
    tag_name?: string
    assets?: { name?: string; digest?: string; size?: number; browser_download_url?: string }[]
  }
  const version = (release.tag_name ?? "").replace(/^rust-v/, "")
  if (!VERSION.test(version)) throw new InstallError("The release list gave no version.")
  const wanted = codexAsset(options.platform, options.arch)
  const asset = release.assets?.find((a) => a.name === wanted)
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? "")?.[1]
  if (!asset?.browser_download_url || !digest)
    throw new InstallError(`The release has no checked program for ${wanted}.`)
  const name = binaryName("codex", options.platform)
  const dir = join(managedDir(options.dataDir, "codex"), version)
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, wanted)
  const part = join(dir, `${name}.part`)
  try {
    const got = await download(asset.browser_download_url, archive, {
      signal: options.signal,
      size: typeof asset.size === "number" ? asset.size : null,
      onProgress: (f) => options.onProgress(f === null ? null : f * 0.9),
    })
    if (got.sha256 !== digest) throw new InstallError("The checksum of the download is wrong.")
    await unpackFirstFile(archive, part)
    chmodSync(part, 0o755)
    renameSync(part, join(dir, name))
    rmSync(archive, { force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  finish(options.dataDir, "codex", version)
  return version
}

/**
 * Downloads the vendor program into the data folder of the app. The download must match the
 * SHA-256 that the vendor publishes, as the vendor's own installer demands. Returns the version.
 */
export const installRuntime = (kind: RuntimeKind, options: InstallOptions): Promise<string> => {
  if (kind === "claude_code") return installClaude(options)
  if (kind === "codex") return installCodex(options)
  return Promise.reject(new Error("The app does not download this program."))
}

export const hasManagedCopy = (dataDir: string, kind: RuntimeKind) =>
  existsSync(join(managedDir(dataDir, kind), "current.json"))
