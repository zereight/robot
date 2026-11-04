import { mkdirSync } from "node:fs"
import { createInterface } from "node:readline"
import type { ModelInfo } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { limitFailure, ProviderFailure } from "../providers/client.ts"
import { parseVersion } from "./claude.ts"
import { runtimeEnv } from "./env.ts"
import { execute } from "./proc.ts"
import { spawnProgram } from "./programs.ts"
import { loginFailure, startFailure, type VersionProbe, versionProbe } from "./readiness.ts"
import type { Login, RuntimeRun } from "./types.ts"

/**
 * Cursor CLI (`cursor-agent`, also `agent`). Facts are from Cursor CLI 2026.10.22 on this
 * computer (`--help`, `--version`, `status --format json`) and the public CLI documents
 * (print, stream-json, ask mode, sandbox, force, trust). The program has no download here:
 * the user installs it. A turn gets one prompt. It does not read a message during the turn.
 *
 * `agent models` prints one model on a line: the id, then " - " and the name, then
 * "(current)" or "(default)" when those apply. A header and a tip line are not models.
 * The list names no effort levels, so the app offers none.
 *
 * `status --format json` has `isAuthenticated` and `userInfo.email`. A key in the
 * environment is the same Cursor account: when the status is signed out and `models`
 * still lists models, the account is connected.
 */

const env = () => runtimeEnv(process.env, undefined, "cursor")

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g")
const MODEL_ID = /^[\w][\w.+-]*$/
const LIMIT = /usage limit|plan limit|spend limit|quota|credit balance|insufficient credit/i
const BUSY = /too many requests|overloaded|rate.?limit/i
const SIGNED_OUT = /not logged in|authentication required|unauthenticated|invalid api key/i

const stripAnsi = (text: string) => text.replace(ANSI, "")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown) => (typeof value === "string" ? value : "")

const namedNumber = (record: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

export const cursorProbe = async (bin: string): Promise<VersionProbe> => {
  const done = await execute(bin, ["--version"], { env: env(), timeoutMs: 30_000 })
  return versionProbe(done, parseVersion(`${done.stdout}\n${done.stderr}`))
}

/** Reads `agent models`. Colours are ignored. A line that is not a model is skipped. */
export const parseCursorModels = (stdout: string): ModelInfo[] => {
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of stripAnsi(stdout).split("\n")) {
    const line = raw.trim()
    if (line === "" || /^available models$/i.test(line) || /^tip:/i.test(line)) continue
    if (/^no models available/i.test(line)) continue
    const named = /^(\S+)\s+-\s+(.*?)(?:\s+\(([^)]*)\))?\s*$/.exec(line)
    const bare = /^(\S+)(?:\s+\(([^)]*)\))?\s*$/.exec(line)
    const id = named?.[1] ?? bare?.[1] ?? ""
    const label = (named?.[2] ?? "").trim()
    if (!MODEL_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: label || id, efforts: [] })
  }
  return models
}

/** Reads `agent status --format json`. Null when the text is not that answer. */
export const parseCursorStatus = (
  stdout: string,
): { readonly signedIn: boolean; readonly user: string | null } | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.isAuthenticated !== "boolean") return null
  if (parsed.isAuthenticated !== true) return { signedIn: false, user: null }
  const info = isRecord(parsed.userInfo) ? parsed.userInfo : null
  const email = info && typeof info.email === "string" ? info.email.trim() : ""
  return { signedIn: true, user: email || null }
}

const signedOut = (fail?: Login["fail"]): Login => ({
  signedIn: false,
  method: null,
  user: null,
  plan: null,
  ...(fail ? { fail } : {}),
})

/**
 * The account is connected when the status says so, or when the model list has a model.
 * The second case is a key in the environment: the status store can be empty and the
 * list still loads. The key is the Cursor account, so the method is the subscription.
 */
export const cursorLogin = async (bin: string): Promise<Login> => {
  const [status, modelsRun] = await Promise.all([
    execute(bin, ["status", "--format", "json"], { env: env(), timeoutMs: 10_000 }),
    execute(bin, ["models"], { env: env(), timeoutMs: 10_000 }),
  ])
  const statusFail = loginFailure(status)
  const modelsFail = loginFailure(modelsRun)
  const parsed = parseCursorStatus(status.stdout)
  const listed = modelsRun.code === 0 ? parseCursorModels(modelsRun.stdout) : []
  if (parsed?.signedIn === true || listed.length > 0)
    return {
      signedIn: true,
      method: "subscription",
      user: parsed?.signedIn === true ? parsed.user : null,
      plan: null,
      models: listed,
    }
  if (statusFail) return signedOut(statusFail)
  if (modelsFail && parsed === null) return signedOut(modelsFail)
  // A status that is not the JSON answer, and no model list, is text the app cannot read.
  if (parsed === null) return signedOut("unreadable")
  return signedOut()
}

/**
 * How the program starts for a permission level. Print mode does not apply a change unless
 * `--force` is set, and it cannot ask the user. "Read only" and "Ask for everything" use
 * ask mode, which the help text calls read-only. "Ask for risky steps" applies changes with
 * the sandbox on. "Full access" applies changes with the sandbox off. A turn that may only
 * answer uses ask mode too.
 */
export const cursorModeArgs = (run: RuntimeRun): string[] => {
  if (!run.useTools) return ["--mode", "ask"]
  switch (run.permission) {
    case "read_only":
    case "ask_all":
      return ["--mode", "ask"]
    case "ask_risky":
    case "ask_unsure":
      return ["--force", "--sandbox", "enabled"]
    case "full":
      return ["--force", "--sandbox", "disabled"]
    default: {
      const unreachable: never = run.permission
      return unreachable
    }
  }
}

const modelArg = (model: string): string[] =>
  model !== "" && model !== "default" && model.length <= 200 && !/[\r\n\0]/.test(model)
    ? ["--model", model]
    : []

/** The text the program reads: the answer-only line, the instructions, then the chat. */
export const cursorPrompt = (run: RuntimeRun): string => {
  const only = run.useTools
    ? ""
    : "Answer in text only. Do not read files, run commands, or change files.\n\n"
  const system = run.system.trim()
    ? `The instructions of the agent:\n\n${run.system.trim()}\n\n---\n\n`
    : ""
  return `${only}${system}${run.prompt}`
}

export const cursorArgs = (run: RuntimeRun): string[] => {
  const prompt = cursorPrompt(run)
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--workspace",
    run.workspace,
    ...cursorModeArgs(run),
    ...modelArg(run.model),
    "--",
    prompt,
  ]
}

export interface CursorState {
  input: number
  output: number
  cached: number | null
  sawText: boolean
  sawUsage: boolean
  error: string | null
}

export const newCursorState = (): CursorState => ({
  input: 0,
  output: 0,
  cached: null,
  sawText: false,
  sawUsage: false,
  error: null,
})

const assistantText = (message: unknown) => {
  if (!isRecord(message) || !Array.isArray(message.content)) return ""
  const parts: string[] = []
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text)
      parts.push(part.text)
  }
  return parts.join("")
}

/**
 * The text to append. With `--stream-partial-output`, a line with `timestamp_ms` and no
 * `model_call_id` is new text. A line with `model_call_id` repeats that text. A line with
 * neither is the flush at the end, and it repeats the text too. Null means skip the line.
 */
const partialText = (message: Record<string, unknown>): string | null => {
  const hasTime = typeof message.timestamp_ms === "number"
  const call = message.model_call_id
  const hasCall = typeof call === "string" && call !== ""
  if (!hasTime || hasCall) return null
  return assistantText(message.message)
}

const jsonText = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return ""
  }
}

const toolOutput = (result: Record<string, unknown> | null) => {
  if (!result) return ""
  if (isRecord(result.success) && typeof result.success.content === "string")
    return result.success.content.slice(0, 4_000)
  if (isRecord(result.error))
    return (str(result.error.message) || jsonText(result.error)).slice(0, 4_000)
  return jsonText(result).slice(0, 4_000)
}

const toolFailed = (result: Record<string, unknown> | null) => {
  if (!result) return false
  if ("error" in result && result.error !== undefined && result.error !== null) return true
  return "failure" in result && result.failure !== undefined && result.failure !== null
}

const firstTool = (
  toolCall: unknown,
): { name: string; input: string; output: string; failed: boolean } | null => {
  if (!isRecord(toolCall)) return null
  for (const [key, value] of Object.entries(toolCall)) {
    if (!isRecord(value)) continue
    if (key === "function") {
      const name = str(value.name) || "tool"
      return { name, input: jsonText(value.arguments), output: "", failed: false }
    }
    if (!key.endsWith("ToolCall")) continue
    const result = isRecord(value.result) ? value.result : null
    return {
      name: key.slice(0, -"ToolCall".length) || "tool",
      input: jsonText(value.args),
      output: toolOutput(result),
      failed: toolFailed(result),
    }
  }
  return null
}

const takeUsage = (message: Record<string, unknown>, state: CursorState) => {
  const usage = isRecord(message.usage) ? message.usage : null
  if (!usage) return
  const input = namedNumber(usage, ["input_tokens", "inputTokens"])
  const output = namedNumber(usage, ["output_tokens", "outputTokens"])
  const cached = namedNumber(usage, ["cache_read_tokens", "cacheReadTokens"])
  if (input === null && output === null && cached === null) return
  state.input = input ?? 0
  state.output = output ?? 0
  if (cached !== null) state.cached = cached
  state.sawUsage = true
}

/** Turns one line of `stream-json` into events. Unknown lines are ignored. */
export const mapCursorEvent = (message: unknown, state: CursorState): AgentEvent[] => {
  if (!isRecord(message)) return []
  if (message.type === "assistant") {
    const text = partialText(message)
    if (!text) return []
    state.sawText = true
    return [{ type: "text", text }]
  }
  if (message.type === "tool_call") {
    const tool = firstTool(message.tool_call)
    if (!tool || (message.subtype !== "started" && message.subtype !== "completed")) return []
    const call = { id: str(message.call_id), name: tool.name, input: tool.input }
    if (message.subtype === "started") return [{ type: "tool", state: "running", call }]
    return [
      {
        type: "tool",
        state: tool.failed ? "failed" : "done",
        call,
        output: tool.output,
      },
    ]
  }
  if (message.type === "result") {
    takeUsage(message, state)
    const text = str(message.result)
    if (message.is_error === true) {
      state.error = text || "The model turn failed."
      return []
    }
    if (!state.sawText && text) {
      state.sawText = true
      return [{ type: "text", text }]
    }
    return []
  }
  return []
}

/** The failure for a turn that ended with an error, from the words of the program. */
export const cursorFailure = (message: string): ProviderFailure => {
  if (LIMIT.test(message)) return limitFailure(message)
  if (BUSY.test(message)) return new ProviderFailure("provider_busy", message)
  if (SIGNED_OUT.test(message)) return new ProviderFailure("runtime_signed_out", message)
  return new ProviderFailure("provider_error", message || "The program ended with an error.")
}

const TAIL = 2000

export async function* runCursor(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  mkdirSync(run.workspace, { recursive: true })
  const child = spawnProgram(run.bin, cursorArgs(run), {
    cwd: run.workspace,
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const output = child.stdout
  const errors = child.stderr
  if (!output || !errors) throw new ProviderFailure("runtime_start", "start")
  let stderr = ""
  errors.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-TAIL)
  })
  let startError: Error | undefined
  child.on("error", (error) => {
    startError = error
  })
  const lines = createInterface({ input: output })
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      lines.close()
      resolve(code)
    }),
  )
  const stop = () => child.kill()
  run.signal.addEventListener("abort", stop, { once: true })

  const state = newCursorState()
  try {
    for await (const line of lines) {
      if (!line.startsWith("{")) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      for (const event of mapCursorEvent(message, state)) yield event
    }
    if (run.signal.aborted) return
    if (state.error !== null) throw cursorFailure(state.error)
    const code = await exited
    const started = startFailure(startError, code)
    if (started) throw started
    if (code !== 0) throw cursorFailure(stderr.trim() || `The program ended with code ${code}.`)
    if (state.sawUsage)
      yield {
        type: "usage",
        input: state.input,
        output: state.output,
        ...(state.cached !== null ? { cached: state.cached } : {}),
      }
  } finally {
    run.signal.removeEventListener("abort", stop)
    if (child.exitCode === null) {
      const timer = setTimeout(stop, 2000)
      await exited
      clearTimeout(timer)
    }
  }
}
