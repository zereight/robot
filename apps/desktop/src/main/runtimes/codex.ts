import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { createInterface } from "node:readline"
import type { PermissionLevel } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { limitFailure, ProviderFailure } from "../providers/client.ts"
import { codexBridgeArgs, type Staged, stage } from "./bridge.ts"
import { parseVersion } from "./claude.ts"
import { runtimeEnv } from "./env.ts"
import { planFromItems } from "./plan.ts"
import { execute } from "./proc.ts"
import { killProgram, spawnProgram } from "./programs.ts"
import { loginFailure, startFailure, type VersionProbe, versionProbe } from "./readiness.ts"
import type { Login, RuntimeRun } from "./types.ts"

/** Reads the answer of `codex login status`. The text can come on either output. */
export const parseCodexStatus = (output: string, code: number | null): Login => {
  const none: Login = { signedIn: false, method: null, user: null, plan: null }
  if (code !== 0 || !/logged in/i.test(output) || /not logged in/i.test(output)) return none
  return {
    signedIn: true,
    method: /chatgpt/i.test(output) ? "subscription" : "api_key",
    user: null,
    plan: null,
  }
}

export const codexLogin = async (bin: string): Promise<Login> => {
  const done = await execute(bin, ["login", "status"], { env: runtimeEnv(), timeoutMs: 15_000 })
  const fail = loginFailure(done)
  if (fail) return { signedIn: false, method: null, user: null, plan: null, fail }
  return parseCodexStatus(`${done.stdout}\n${done.stderr}`, done.code)
}

export const codexProbe = async (bin: string): Promise<VersionProbe> => {
  const done = await execute(bin, ["--version"], { env: runtimeEnv(), timeoutMs: 15_000 })
  return versionProbe(done, parseVersion(done.stdout))
}

/** Opens the sign-in with ChatGPT in the browser, and ends when the vendor program ends. */
export const codexSignIn = (bin: string, signal: AbortSignal) =>
  execute(bin, ["login"], { env: runtimeEnv(), timeoutMs: 5 * 60_000, signal })

/**
 * A non-interactive Codex run cannot ask the user, so the permission level becomes the sandbox of
 * the run: nothing may change, the workspace may change, or nothing is held back.
 */
export const sandboxFor = (level: PermissionLevel, useTools: boolean) =>
  !useTools || level === "read_only" || level === "ask_all"
    ? "read-only"
    : level === "full"
      ? "danger-full-access"
      : "workspace-write"

/** `staged` holds how the program reaches the tools of the app (see bridge.ts). */
export const codexArgs = (run: RuntimeRun, staged?: Staged): string[] => {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    run.workspace,
    "-s",
    sandboxFor(run.permission, run.useTools),
  ]
  if (run.model !== "default") args.push("-m", run.model)
  if (run.effort) args.push("-c", `model_reasoning_effort="${run.effort}"`)
  // "Read only" is the sandbox, and the sandbox does not limit an MCP server of the user: the
  // servers of `config.toml` run with their own rights. An empty table replaces them for this run
  // (found with Codex 0.31: a server in `config.toml` started without the override, and did not
  // start with it). The tools of the app come after, as they are the app's own.
  if (run.permission === "read_only") args.push("-c", "mcp_servers={}")
  if (staged) args.push(...codexBridgeArgs(staged))
  args.push("-")
  return args
}

export const codexPrompt = (run: RuntimeRun) => {
  const rules = run.useTools ? "" : "Answer in text only. Do not run commands or change files."
  const head = [run.system.trim(), rules].filter(Boolean).join("\n\n")
  return head ? `${head}\n\n---\n\n${run.prompt}` : run.prompt
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" ? (value as Json) : {}
const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? value : 0)

export interface CodexState {
  hasText: boolean
  /** The last error that the program reported. A retry can still follow it. */
  lastError: string
  done: boolean
  failed: string | null
  /**
   * Put before the id of each item. The program numbers its items from the start in each run, and
   * a turn that goes on (spec 005, "Keep going") is a new run of the same reply: the cards of the
   * earlier run must keep their ids. Empty in tests.
   */
  prefix: string
}

export const newCodexState = (): CodexState => ({
  hasText: false,
  lastError: "",
  done: false,
  failed: null,
  prefix: "",
})

const call = (item: Json, name: string, input: unknown, prefix = "") => ({
  id: `${prefix}${str(item.id)}`,
  name,
  input: JSON.stringify(input),
})

/** Turns one line of `codex exec --json` into events for the reply. */
export const mapCodexEvent = (message: unknown, state: CodexState): AgentEvent[] => {
  const msg = obj(message)
  switch (msg.type) {
    case "item.started":
    case "item.completed": {
      const item = obj(msg.item)
      const finished = msg.type === "item.completed"
      switch (item.type) {
        case "agent_message": {
          if (!finished || !str(item.text)) return []
          const text = `${state.hasText ? "\n\n" : ""}${str(item.text)}`
          state.hasText = true
          return [{ type: "text", text }]
        }
        case "reasoning":
          return finished && str(item.text) ? [{ type: "thinking", text: str(item.text) }] : []
        case "command_execution": {
          const c = call(item, "shell", { command: str(item.command) }, state.prefix)
          if (!finished) return [{ type: "tool", state: "running", call: c }]
          const failed =
            item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0)
          return [
            {
              type: "tool",
              state: failed ? "failed" : "done",
              call: c,
              output: str(item.aggregated_output),
            },
          ]
        }
        case "file_change": {
          if (!finished) return []
          const changes = Array.isArray(item.changes) ? item.changes.map(obj) : []
          const paths = changes.map((x) => `${str(x.kind)} ${str(x.path)}`.trim())
          return [
            {
              type: "tool",
              state: item.status === "failed" ? "failed" : "done",
              call: call(item, "file_change", { path: str(changes[0]?.path) }, state.prefix),
              output: paths.join("\n"),
            },
          ]
        }
        case "mcp_tool_call": {
          const c = call(
            item,
            `${str(item.server)}.${str(item.tool)}`,
            item.arguments ?? {},
            state.prefix,
          )
          if (!finished) return [{ type: "tool", state: "running", call: c }]
          const failed = item.status === "failed" || obj(item.error).message !== undefined
          return [
            {
              type: "tool",
              state: failed ? "failed" : "done",
              call: c,
              output: str(obj(item.error).message) || JSON.stringify(item.result ?? ""),
            },
          ]
        }
        case "web_search":
          return finished
            ? [
                {
                  type: "tool",
                  state: "done",
                  call: call(item, "web_search", { query: str(item.query) }, state.prefix),
                  output: "",
                },
              ]
            : []
        case "todo_list": {
          // The list of steps of the program (spec 006): the app reads it for "Keep going".
          const steps = planFromItems(item.items)
          return steps ? [{ type: "plan", steps }] : []
        }
        default:
          return []
      }
    }
    case "item.updated": {
      // The program changes its list while it works; the other items have no update that matters.
      const item = obj(msg.item)
      const steps = item.type === "todo_list" ? planFromItems(item.items) : null
      return steps ? [{ type: "plan", steps }] : []
    }
    case "turn.completed": {
      state.done = true
      const usage = obj(msg.usage)
      return [
        {
          type: "usage",
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          ...(typeof usage.cached_input_tokens === "number"
            ? { cached: usage.cached_input_tokens }
            : {}),
        },
      ]
    }
    case "turn.failed":
      state.failed = str(obj(msg.error).message) || state.lastError || "The turn failed."
      return []
    case "error":
      state.lastError = str(msg.message) || state.lastError
      return []
    default:
      return []
  }
}

export const codexFailure = (text: string): ProviderFailure => {
  if (/usage limit|rate limit|quota|too many requests|\b429\b/i.test(text))
    return limitFailure(text)
  if (/not logged in|log ?in|sign ?in|unauthorized|\b401\b|token.*(expired|invalid)/i.test(text))
    return new ProviderFailure("runtime_signed_out", text)
  return new ProviderFailure("provider_error", text || "The program ended with an error.")
}

const TAIL = 2000

export async function* runCodex(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  mkdirSync(run.workspace, { recursive: true })
  const staged = run.bridge ? stage(run.bridge) : null
  const child = spawnProgram(run.bin, codexArgs(run, staged ?? undefined), {
    cwd: run.workspace,
    env: runtimeEnv(),
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
  const stop = () => killProgram(child)
  run.signal.addEventListener("abort", stop, { once: true })
  child.stdin.on("error", () => {})
  child.stdin.end(codexPrompt(run))

  const state = newCodexState()
  state.prefix = `${randomBytes(3).toString("hex")}:`
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      for (const event of mapCodexEvent(message, state)) yield event
      if (state.done || state.failed !== null) break
    }
    if (run.signal.aborted) return
    if (state.failed !== null) throw codexFailure(state.failed)
    if (!state.done) {
      const code = await exited
      const started = startFailure(startError, code)
      if (started) throw started
      throw codexFailure(state.lastError || stderr.trim() || `The program ended with code ${code}.`)
    }
  } finally {
    run.signal.removeEventListener("abort", stop)
    if (child.exitCode === null) {
      const timer = setTimeout(() => killProgram(child, "SIGKILL"), 2000)
      await exited
      clearTimeout(timer)
    }
    staged?.remove()
  }
}
