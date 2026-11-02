import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { EFFORTS, type ModelInfo, type PermissionLevel } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import { parseVersion } from "./claude.ts"
import { runtimeEnv } from "./env.ts"
import { execute } from "./proc.ts"
import type { Login, RuntimeRun } from "./types.ts"

const env = () => runtimeEnv(process.env, undefined, "pi")

export const piVersion = async (bin: string): Promise<string | null> => {
  const done = await execute(bin, ["--version"], { env: env(), timeoutMs: 30_000 })
  return done.code === 0 ? parseVersion(`${done.stdout}\n${done.stderr}`) : null
}

/**
 * The thinking levels of pi that the user can pick, from the lowest. "off" is not in the list:
 * it is the lack of an effort level, which the choice "Default" already covers.
 */
export const PI_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

/**
 * Reads the table of `pi --list-models`: provider, model, context, max output, thinking, images.
 * The program lists the models that it can use right now, so the table is also its sign-in state.
 * The table only says if a model thinks. The levels that the model takes come from `piEfforts`;
 * the levels here are what the app uses when pi cannot tell them.
 */
export const parsePiModels = (stdout: string): ModelInfo[] => {
  const models: ModelInfo[] = []
  for (const line of stdout.split("\n").slice(1)) {
    const cells = line.trim().split(/\s+/)
    if (cells.length < 6) continue
    const [provider, model, , , thinking] = cells
    if (!provider || !model) continue
    models.push({
      id: `${provider}/${model}`,
      label: `${provider}/${model}`,
      efforts: thinking === "yes" ? EFFORTS : [],
    })
  }
  return models
}

/**
 * pi has no sign-in of its own state: each model has a provider with its own login or key. The
 * program is ready when it can list at least one model.
 */
export const piLogin = async (bin: string): Promise<Login> => {
  const done = await execute(bin, ["--list-models"], { env: env(), timeoutMs: 60_000 })
  const listed = done.code === 0 ? parsePiModels(done.stdout) : []
  const levels = await piEfforts(
    bin,
    listed.filter((m) => m.efforts.length > 0).map((m) => m.id),
  )
  const models = listed.map((m) => ({ ...m, efforts: levels.get(m.id) ?? m.efforts }))
  return {
    signedIn: models.length > 0,
    // Each model of pi has its own billing, which the user chose in pi.
    method: models.length > 0 ? "subscription" : null,
    user: null,
    plan: null,
    models,
  }
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" ? (value as Json) : {}
const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? value : 0)

/** The levels of the list that pi gave for a model, in the order of `PI_EFFORTS`. */
export const pickEfforts = (levels: unknown): string[] =>
  Array.isArray(levels) ? PI_EFFORTS.filter((level) => levels.includes(level)) : []

const LEVELS_TIMEOUT = 60_000

/**
 * Asks pi which thinking levels each model takes. One program in RPC mode serves all questions:
 * for each model, it takes the model, then tells the levels of that model. A model that pi cannot
 * answer for is not in the result, and the caller keeps what it has.
 */
export const piEfforts = async (
  bin: string,
  ids: readonly string[],
  timeoutMs = LEVELS_TIMEOUT,
): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>()
  if (ids.length === 0) return found
  const child = spawn(
    bin,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-mcp",
      "--no-tools",
    ],
    { env: env(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  )
  child.on("error", () => {})
  child.stdin.on("error", () => {})
  const pending = new Map<string, (answer: Json | null) => void>()
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    if (!line.startsWith("{")) return
    let message: Json
    try {
      message = obj(JSON.parse(line))
    } catch {
      return
    }
    // Other lines are events, for example from the extensions of the user.
    if (message.type !== "response") return
    const answer = pending.get(str(message.id))
    pending.delete(str(message.id))
    answer?.(message)
  })
  // When the program ends, no answer will come.
  child.on("close", () => {
    for (const answer of pending.values()) answer(null)
    pending.clear()
  })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  let count = 0
  const ask = (command: Json) =>
    new Promise<Json | null>((resolve) => {
      if (child.exitCode !== null || child.killed) return resolve(null)
      const id = String(++count)
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`)
    })
  try {
    for (const id of ids) {
      const slash = id.indexOf("/")
      const set = await ask({
        type: "set_model",
        provider: id.slice(0, slash),
        modelId: id.slice(slash + 1),
      })
      if (set === null) break
      if (set.success !== true) continue
      const answer = await ask({ type: "get_available_thinking_levels" })
      if (answer === null) break
      if (answer.success === true) found.set(id, pickEfforts(obj(answer.data).levels))
    }
  } finally {
    clearTimeout(timer)
    lines.close()
    child.kill()
  }
  return found
}

/**
 * pi asks nothing before a step, so the permission level becomes the list of tools. "Ask for
 * everything" can look but not change. "Ask for risky steps" can also edit and write files, but
 * has no shell, which is where the risk is. "Full access" has every tool.
 */
export const piTools = (level: PermissionLevel, useTools: boolean): string[] => {
  if (!useTools) return ["--no-tools"]
  if (level === "ask_all") return ["--tools", "read,grep,find,ls"]
  if (level === "ask_risky") return ["--tools", "read,grep,find,ls,edit,write"]
  return []
}

export const piArgs = (run: RuntimeRun, systemFile: string | null): string[] => {
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    // The files of the user (rules, skills, templates, servers) are not for the agents of this app.
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "--model",
    run.model,
    ...piTools(run.permission, run.useTools),
  ]
  if (run.effort) args.push("--thinking", run.effort)
  if (systemFile) args.push("--append-system-prompt", systemFile)
  return args
}

export interface PiState {
  input: number
  output: number
  /** The error of a model turn that failed. */
  error: string | null
  done: boolean
}

export const newPiState = (): PiState => ({ input: 0, output: 0, error: null, done: false })

const resultText = (result: unknown) => {
  const content = obj(result).content
  return Array.isArray(content)
    ? content
        .map((c) => str(obj(c).text))
        .filter(Boolean)
        .join("\n")
    : ""
}

/** Turns one line of `pi --mode json` into events for the reply. */
export const mapPiEvent = (message: unknown, state: PiState): AgentEvent[] => {
  const msg = obj(message)
  switch (msg.type) {
    case "message_update": {
      const event = obj(msg.assistantMessageEvent)
      if (event.type === "text_delta" && str(event.delta))
        return [{ type: "text", text: str(event.delta) }]
      if (event.type === "thinking_delta" && str(event.delta))
        return [{ type: "thinking", text: str(event.delta) }]
      return []
    }
    case "tool_execution_start":
      return [
        {
          type: "tool",
          state: "running",
          call: {
            id: str(msg.toolCallId),
            name: str(msg.toolName),
            input: JSON.stringify(msg.args ?? {}),
          },
        },
      ]
    case "tool_execution_end":
      return [
        {
          type: "tool",
          state: msg.isError === true ? "failed" : "done",
          call: { id: str(msg.toolCallId), name: str(msg.toolName), input: "{}" },
          output: resultText(msg.result),
        },
      ]
    case "turn_end": {
      const message = obj(msg.message)
      const usage = obj(message.usage)
      state.input += num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite)
      state.output += num(usage.output)
      if (message.stopReason === "error")
        state.error = str(message.errorMessage) || "The model turn failed."
      return []
    }
    case "agent_settled":
      state.done = true
      return []
    default:
      return []
  }
}

export const piFailure = (text: string): ProviderFailure => {
  if (
    /extra usage|plan limit|usage limit|rate.?limit|quota|too many requests|overloaded|\b429\b/i.test(
      text,
    )
  )
    return new ProviderFailure("provider_limit", text)
  if (
    /unauthor|\b401\b|log ?in|credentials|not_ready|api key|authentication|no models?/i.test(text)
  )
    return new ProviderFailure("runtime_signed_out", text)
  return new ProviderFailure("provider_error", text || "The program ended with an error.")
}

const TAIL = 2000

export async function* runPi(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  mkdirSync(run.workspace, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), "robot-pi-"))
  let systemFile: string | null = null
  if (run.system.trim()) {
    // A file, so that the program never takes the text for something else.
    systemFile = join(scratch, "system.md")
    writeFileSync(systemFile, run.system, { mode: 0o600 })
  }
  const child = spawn(run.bin, piArgs(run, systemFile), {
    cwd: run.workspace,
    env: env(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-TAIL)
  })
  let startError: Error | undefined
  child.on("error", (error) => {
    startError = error
  })
  const lines = createInterface({ input: child.stdout })
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      lines.close()
      resolve(code)
    }),
  )
  const stop = () => child.kill()
  run.signal.addEventListener("abort", stop, { once: true })
  child.stdin.on("error", () => {})
  child.stdin.end(run.prompt)

  const state = newPiState()
  try {
    for await (const line of lines) {
      if (!line.startsWith("{")) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      for (const event of mapPiEvent(message, state)) yield event
    }
    if (run.signal.aborted) return
    if (state.error !== null) throw piFailure(state.error)
    if (!state.done) {
      const code = await exited
      throw piFailure(
        startError?.message ?? (stderr.trim() || `The program ended with code ${code}.`),
      )
    }
    yield { type: "usage", input: state.input, output: state.output }
  } finally {
    run.signal.removeEventListener("abort", stop)
    if (child.exitCode === null) {
      const timer = setTimeout(stop, 2000)
      await exited
      clearTimeout(timer)
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}
