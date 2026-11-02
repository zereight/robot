import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  type RoutineFailure,
  resultText,
  WATCH_CHECK_MS,
  WATCH_FILES_MAX,
  WATCH_OUTPUT_MAX,
  type WatchResult,
  type WatchTarget,
  watchArgs,
} from "@robot/shared"

/** The end of one check: the result to keep, or why it failed. */
export type CheckOutcome =
  | { readonly ok: true; readonly result: string }
  | { readonly ok: false; readonly reason: RoutineFailure }

/** Calls a tool of a connection (018) and gives its result as text. */
export type ToolCaller = (
  connection: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<string>

export interface CheckContext {
  /** The workspace folder of the agent: a command runs here, and a relative path starts here. */
  readonly workspace: string
  /** True when a Deny rule (007) matches the check: it is refused. */
  readonly denied?: boolean
  /** Calls a tool of a connection. Absent: no connection can be called. */
  readonly callTool?: ToolCaller
  /** The time limit, 60 seconds by default. Tests make it shorter. */
  readonly limitMs?: number
}

const fail = (code: string, detail = ""): CheckOutcome => ({ ok: false, reason: { code, detail } })
const ok = (r: WatchResult): CheckOutcome => ({ ok: true, result: resultText(r) })

/** Cuts a text to at most `max` bytes of UTF-8. */
export const cutBytes = (text: string, max = WATCH_OUTPUT_MAX) => {
  const bytes = Buffer.from(text, "utf8")
  return bytes.length <= max ? text : bytes.subarray(0, max).toString("utf8")
}

/** The full path of a watch path: `~` is the home folder, a relative path is in the workspace. */
export const watchPath = (path: string, workspace: string) => {
  const p = path.trim()
  if (p === "~") return homedir()
  if (p.startsWith(`~/`) || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(workspace, p)
}

class TimeUp extends Error {}

const hashFile = (path: string, signal: AbortSignal) =>
  new Promise<string>((done, failed) => {
    const hash = createHash("sha256")
    const stream = createReadStream(path)
    const stop = () => stream.destroy(new TimeUp())
    signal.addEventListener("abort", stop, { once: true })
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", (e) => {
      signal.removeEventListener("abort", stop)
      failed(e)
    })
    stream.on("end", () => {
      signal.removeEventListener("abort", stop)
      done(hash.digest("hex"))
    })
  })

/** The names, sizes and change times of the files in a folder and its folders, up to 2000. */
const listFolder = async (root: string, signal: AbortSignal) => {
  const files: Record<string, [number, number]> = {}
  let count = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    for (const entry of entries) {
      if (count >= WATCH_FILES_MAX) return
      if (signal.aborted) throw new TimeUp()
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const s = await stat(full).catch(() => null)
        if (!s) continue
        files[relative(root, full).split(sep).join("/")] = [s.size, Math.floor(s.mtimeMs)]
        count++
      }
    }
  }
  await walk(root)
  return files
}

const checkPath = async (path: string, ctx: CheckContext, signal: AbortSignal) => {
  const full = watchPath(path, ctx.workspace)
  const s = await stat(full).catch(() => null)
  if (!s) return fail("watch_missing", path)
  if (s.isDirectory()) return ok({ type: "folder", files: await listFolder(full, signal) })
  return ok({
    type: "file",
    size: s.size,
    mtime: Math.floor(s.mtimeMs),
    hash: await hashFile(full, signal),
  })
}

const checkCommand = (command: string, ctx: CheckContext, signal: AbortSignal) =>
  new Promise<CheckOutcome>((done) => {
    const child = spawn(command, {
      cwd: ctx.workspace,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const chunks: Buffer[] = []
    let size = 0
    const take = (chunk: Buffer) => {
      if (size >= WATCH_OUTPUT_MAX) return
      chunks.push(chunk)
      size += chunk.length
    }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    let timedOut = false
    const kill = () => {
      timedOut = true
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {}
    }
    signal.addEventListener("abort", kill, { once: true })
    child.on("error", (e) => {
      signal.removeEventListener("abort", kill)
      done(fail("watch_failed", e.message))
    })
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill)
      if (timedOut) return done(fail("watch_timeout"))
      // A code that is not 0 is no failure: it is part of the result (spec 009).
      const text = cutBytes(Buffer.concat(chunks).toString("utf8"))
      done(ok({ type: "output", text, code: code ?? null }))
    })
  })

const checkTool = async (
  target: Extract<WatchTarget, { kind: "tool" }>,
  ctx: CheckContext,
  signal: AbortSignal,
) => {
  const args = watchArgs(target.args)
  if (args === null) return fail("invalid_input")
  if (!ctx.callTool) return fail("watch_no_connection", target.connection)
  try {
    const text = await Promise.race([
      ctx.callTool(target.connection, target.tool, args, signal),
      new Promise<never>((_, failed) =>
        signal.addEventListener("abort", () => failed(new TimeUp()), { once: true }),
      ),
    ])
    return ok({ type: "output", text: cutBytes(text) })
  } catch (e) {
    if (e instanceof TimeUp) return fail("watch_timeout")
    return fail("watch_tool_failed", e instanceof Error ? e.message : String(e))
  }
}

/**
 * One check of a watch (spec 009). It never throws: a missing path, the time limit, a failed tool
 * call and a refusal by a rule end as a failed check.
 */
export const runCheck = async (target: WatchTarget, ctx: CheckContext): Promise<CheckOutcome> => {
  if (ctx.denied) return fail("watch_denied")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.limitMs ?? WATCH_CHECK_MS)
  try {
    if (target.kind === "path") return await checkPath(target.path, ctx, controller.signal)
    if (target.kind === "command") return await checkCommand(target.command, ctx, controller.signal)
    return await checkTool(target, ctx, controller.signal)
  } catch (e) {
    if (e instanceof TimeUp || controller.signal.aborted) return fail("watch_timeout")
    return fail("watch_failed", e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}
