import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { ModelInfo, PermissionLevel } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { limitFailure, ProviderFailure } from "../providers/client.ts"
import { parseVersion } from "./claude.ts"
import { runtimeEnv } from "./env.ts"
import { planFromTodos } from "./plan.ts"
import { execute } from "./proc.ts"
import { killProgram, spawnProgram } from "./programs.ts"
import { loginFailure, startFailure, type VersionProbe, versionProbe } from "./readiness.ts"
import type { Login, RuntimeRun } from "./types.ts"

const env = () => runtimeEnv(process.env, undefined, "opencode")

/**
 * Every call of the app uses `--standalone`. Without it the program hands the call to a server
 * that stays in the background, and that server keeps the settings it started with, so the
 * permission level of a turn would not reach it.
 */
const STANDALONE = "--standalone"

export const opencodeProbe = async (bin: string): Promise<VersionProbe> => {
  const done = await execute(bin, ["--version"], { env: env(), timeoutMs: 30_000 })
  return versionProbe(done, parseVersion(`${done.stdout}\n${done.stderr}`))
}

/**
 * Reads the output of `opencode models`: one model on each line, as `provider/model`. A line that
 * has another shape (a notice, an error) is not a model. The list does not tell the thinking
 * levels of a model, so the app offers none.
 */
export const parseOpencodeModels = (stdout: string): ModelInfo[] => {
  const seen = new Set<string>()
  const models: ModelInfo[] = []
  for (const line of stdout.split("\n")) {
    const id = line.trim()
    if (!/^[\w.-]+\/\S+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: id, efforts: [] })
  }
  return models
}

/**
 * opencode keeps its own providers, and the user adds them inside the program (`opencode auth
 * login`, or its configuration). It has no sign-in state of its own: the program is ready when it
 * can list at least one model. It always lists its free models, so a program that starts is
 * almost always ready; the user picks the model, and with it the provider that bills the turn.
 */
export const opencodeLogin = async (bin: string): Promise<Login> => {
  const done = await execute(bin, ["models", STANDALONE], { env: env(), timeoutMs: 60_000 })
  const fail = loginFailure(done)
  if (fail) return { signedIn: false, method: null, user: null, plan: null, fail }
  const models = done.code === 0 ? parseOpencodeModels(done.stdout) : []
  return {
    signedIn: models.length > 0,
    // Each model has its own billing, which the user chose in opencode.
    method: models.length > 0 ? "subscription" : null,
    user: null,
    plan: null,
    models,
  }
}

/**
 * opencode asks before a step only when someone can answer, and a run from the app cannot. So the
 * permission level becomes a list of rules, and a tool that a rule denies is not offered to the
 * model. "Ask for everything" can look but not change. "Ask for risky steps" can also edit and
 * write files, but has no shell, which is where the risk is. "Full access" has every tool, and
 * the program is told to approve what its rules would ask about. No level lets the model start a
 * helper agent below its own level, or ask the user a question that nobody can answer.
 * `useTools` false means that the program may only answer.
 */
export const opencodePermission = (
  level: PermissionLevel,
  useTools: boolean,
): Record<string, string> => {
  if (!useTools) return { "*": "deny" }
  if (level === "read_only" || level === "ask_all")
    return { bash: "deny", edit: "deny", task: "deny", question: "deny" }
  if (level === "ask_risky") return { bash: "deny", task: "deny", question: "deny" }
  return { question: "deny" }
}

/**
 * The settings of one turn, as the text for the variable that the program reads on top of the
 * settings of the user. The providers of the user stay: they are in its own files. `systemFile` is
 * a file with the instructions of the agent, which the program adds to its own.
 */
export const opencodeConfig = (run: RuntimeRun, systemFile: string | null): string =>
  JSON.stringify({
    permission: opencodePermission(run.permission, run.useTools),
    ...(systemFile ? { instructions: [systemFile] } : {}),
  })

export const opencodeArgs = (run: RuntimeRun): string[] => [
  "run",
  STANDALONE,
  "--format",
  "json",
  "--thinking",
  // A title stops the extra call that the program makes to name a session.
  "--title",
  "ROBot",
  // A model with no provider in its name is the default of the program.
  ...(run.model.includes("/") ? ["--model", run.model] : []),
  ...(run.useTools && run.permission === "full" ? ["--auto"] : []),
]

/**
 * The variables for a turn. The rules of the user and of the project (instruction files, the
 * folders of other agent tools, skills) are not for the agents of this app. The sessions of the
 * app go to a database of their own, which the app deletes, so that they never fill the history
 * of the user in opencode.
 */
export const opencodeTurnEnv = (
  run: RuntimeRun,
  scratch: string,
  systemFile: string | null,
): NodeJS.ProcessEnv => ({
  ...env(),
  OPENCODE_CONFIG_CONTENT: opencodeConfig(run, systemFile),
  OPENCODE_DB: join(scratch, "opencode.db"),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
})

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" ? (value as Json) : {}
const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? value : 0)

export interface OpencodeState {
  input: number
  output: number
  /** The input read from the cache, or null while the program has not reported it. */
  cached: number | null
  /** The error that the program reported. */
  error: { readonly type: string; readonly status: number; readonly message: string } | null
}

export const newOpencodeState = (): OpencodeState => ({
  input: 0,
  output: 0,
  cached: null,
  error: null,
})

/** Turns one line of `opencode run --format json` into events for the reply. */
export const mapOpencodeEvent = (message: unknown, state: OpencodeState): AgentEvent[] => {
  const msg = obj(message)
  const part = obj(msg.part)
  switch (msg.type) {
    case "text":
      return str(part.text) ? [{ type: "text", text: str(part.text) }] : []
    case "reasoning":
      return str(part.text) ? [{ type: "thinking", text: str(part.text) }] : []
    case "tool_use": {
      // The program reports a step when it has ended, so the card shows it as it runs and ends.
      const step = obj(part.state)
      const call = {
        id: str(part.id),
        name: str(part.tool),
        input: JSON.stringify(step.input ?? {}),
      }
      const running: AgentEvent = { type: "tool", state: "running", call }
      // The tool todowrite is the list of steps of the program (spec 006): each call holds the
      // whole list. The app reads it for "Keep going" (spec 005).
      const steps = call.name === "todowrite" ? planFromTodos(obj(step.input).todos) : null
      const plan: AgentEvent[] = steps ? [{ type: "plan", steps }] : []
      if (step.status === "completed")
        return [running, ...plan, { type: "tool", state: "done", call, output: str(step.output) }]
      if (step.status === "error")
        return [running, { type: "tool", state: "failed", call, output: str(step.error) }]
      return [running, ...plan]
    }
    case "step_finish": {
      const tokens = obj(part.tokens)
      const cache = obj(tokens.cache)
      state.input += num(tokens.input) + num(cache.read) + num(cache.write)
      state.output += num(tokens.output)
      if (typeof cache.read === "number") state.cached = (state.cached ?? 0) + cache.read
      return []
    }
    case "error": {
      const error = obj(msg.error)
      state.error = {
        type: str(error.type),
        status: num(error.status),
        message: str(error.message) || "The model turn failed.",
      }
      return []
    }
    default:
      return []
  }
}

const LIMIT = /extra usage|plan limit|usage limit|rate.?limit|quota|too many requests|overloaded/i
const SIGNED_OUT = /unauthor|log ?in|credentials|api key|authentication|no models?/i

/** The failure for a turn that ended with an error, from the report of the program. */
export const opencodeFailure = (error: {
  readonly type?: string
  readonly status?: number
  readonly message: string
}): ProviderFailure => {
  const { type = "", status = 0, message } = error
  if (status === 429 || /rate-?limit/i.test(type) || LIMIT.test(message))
    return limitFailure(message)
  if (status === 401 || status === 403 || /auth/i.test(type) || SIGNED_OUT.test(message))
    return new ProviderFailure("runtime_signed_out", message)
  return new ProviderFailure("provider_error", message || "The program ended with an error.")
}

const TAIL = 2000

export async function* runOpencode(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  mkdirSync(run.workspace, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), "robot-opencode-"))
  let systemFile: string | null = null
  if (run.system.trim()) {
    // A file, so that the program never takes the text for something else.
    systemFile = join(scratch, "system.md")
    writeFileSync(systemFile, run.system, { mode: 0o600 })
  }
  const child = spawnProgram(run.bin, opencodeArgs(run), {
    cwd: run.workspace,
    env: opencodeTurnEnv(run, scratch, systemFile),
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
  // The prompt goes in through the input and not through an argument: it can be long.
  child.stdin.end(run.prompt)

  const state = newOpencodeState()
  try {
    for await (const line of lines) {
      if (!line.startsWith("{")) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      for (const event of mapOpencodeEvent(message, state)) yield event
    }
    if (run.signal.aborted) return
    if (state.error !== null) throw opencodeFailure(state.error)
    const code = await exited
    const started = startFailure(startError, code)
    if (started) throw started
    if (code !== 0)
      throw opencodeFailure({ message: stderr.trim() || `The program ended with code ${code}.` })
    yield {
      type: "usage",
      input: state.input,
      output: state.output,
      ...(state.cached !== null ? { cached: state.cached } : {}),
    }
  } finally {
    run.signal.removeEventListener("abort", stop)
    if (child.exitCode === null) {
      const timer = setTimeout(() => killProgram(child, "SIGKILL"), 2000)
      await exited
      clearTimeout(timer)
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}
