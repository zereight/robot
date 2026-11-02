import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { RuntimeLimit } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import { parseVersion } from "./claude.ts"
import { runtimeEnv } from "./env.ts"
import { execute } from "./proc.ts"
import type { ApprovalRequest, Login, RuntimeRun } from "./types.ts"

const env = () => runtimeEnv(process.env, undefined, "muse")

export const museVersion = async (bin: string): Promise<string | null> => {
  const done = await execute(bin, ["--version"], { env: env(), timeoutMs: 20_000 })
  return done.code === 0 ? parseVersion(done.stdout) : null
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" ? (value as Json) : {}
const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? value : 0)

const limitOf = (
  name: string,
  value: unknown,
  percent: "usedPercent" | "used_percent",
  at: string,
) => {
  const window = obj(value)
  if (window[percent] === undefined) return []
  const resets = window[at]
  const limit: RuntimeLimit = {
    window: name,
    used: Math.min(1, Math.max(0, num(window[percent]) / 100)),
    resetsAt: typeof resets === "number" ? resets : null,
  }
  return [limit]
}

/** Reads the answer of `muse usage --json`: the allowance of the account, with no model turn. */
export const parseMuseUsage = (stdout: string, code: number | null): Login => {
  const none: Login = { signedIn: false, method: null, user: null, plan: null }
  if (code !== 0) return none
  try {
    const usage = JSON.parse(stdout) as Json
    const allowance = obj(usage.allowance)
    if (usage.allowance === null || usage.allowance === undefined) {
      // A key in the environment or in the store wins over the account, and has no allowance.
      if (usage.reason === "api_key") return { ...none, signedIn: true, method: "api_key" }
      // The account is signed in, but the server has no usage data yet. A new window does this.
      if (usage.reason === "server_sent_no_usage")
        return { ...none, signedIn: true, method: "subscription" }
      return none
    }
    return {
      signedIn: true,
      method: "subscription",
      user: null,
      plan: str(allowance.tier) || null,
      limits: [
        ...limitOf("window", allowance.window, "usedPercent", "resetsAtMs"),
        ...limitOf("weekly", allowance.weekly, "usedPercent", "resetsAtMs"),
      ],
    }
  } catch {
    return none
  }
}

export const museLogin = async (bin: string): Promise<Login> => {
  const done = await execute(bin, ["usage", "--json"], { env: env(), timeoutMs: 30_000 })
  return parseMuseUsage(done.stdout, done.code)
}

// ---- sign in ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape codes of a terminal
const ANSI = /\x1b\[[0-9;]*m/g

/** The page and the code that a device sign-in prints for the user. */
export const parseSignInPrompt = (text: string): { url: string | null; code: string | null } => {
  const lines = text.replace(ANSI, "").split(/\r?\n/)
  const url = /https:\/\/[^\s]+/.exec(text.replace(ANSI, ""))?.[0]?.replace(/[.,;)]+$/, "") ?? null
  let code: string | null = null
  for (const [i, line] of lines.entries()) {
    if (!/\bcode\b/i.test(line) || /https?:\/\//.test(line)) continue
    const next = (lines[i + 1] ?? "").trim()
    if (next) {
      code = next
      break
    }
  }
  return { url, code }
}

/** Hosts that may be opened for a sign-in of Muse Code. */
export const MUSE_SIGN_IN_HOSTS = ["meta.com", "facebook.com", "meta.ai"]

/** Starts the device sign-in. `onPrompt` gets the page and the code as soon as they are printed. */
export const museSignIn = (
  bin: string,
  signal: AbortSignal,
  onPrompt: (prompt: { url: string | null; code: string | null }) => void,
) => {
  let text = ""
  let told = ""
  return execute(bin, ["login"], {
    env: env(),
    timeoutMs: 10 * 60_000,
    signal,
    onData: (chunk) => {
      text += chunk
      const prompt = parseSignInPrompt(text)
      const key = `${prompt.url}|${prompt.code}`
      if ((prompt.url || prompt.code) && key !== told) {
        told = key
        onPrompt(prompt)
      }
    },
  })
}

// ---- the stream of a turn --------------------------------------------------------------

export interface MuseState {
  hasText: boolean
  done: boolean
  /** Why the run ended without completing, when it did not. */
  failed: string | null
}

export const newMuseState = (): MuseState => ({ hasText: false, done: false, failed: null })

export type MuseMapped =
  | { readonly kind: "event"; readonly event: AgentEvent }
  | { readonly kind: "limits"; readonly limits: readonly RuntimeLimit[] }

const toolInput = (name: string, text: string, facts: Json) => {
  try {
    const body = JSON.parse(text) as Json
    if (typeof body.command === "string") return { command: body.command }
  } catch {}
  return str(facts.path) ? { path: str(facts.path) } : { tool: name }
}

/** Turns one line of `muse exec --json` into what the app does with it. */
export const mapMuseLine = (message: unknown, state: MuseState): MuseMapped[] => {
  const line = obj(message)
  const payload = obj(line.payload)
  const type = str(line.payload_type)
  if (type === "run.output.delta" && str(payload.text)) {
    state.hasText = true
    return [{ kind: "event", event: { type: "text", text: str(payload.text) } }]
  }
  if (type === "tool.result") {
    const facts = obj(payload.correlation_facts)
    const edit = obj(payload.edit_facts)
    const name = str(facts.tool_name) || str(edit.tool_name) || "tool"
    const text = str(payload.text)
    const failed = facts.outcome !== undefined && facts.outcome !== "success"
    return [
      {
        kind: "event",
        event: {
          type: "tool",
          state: failed ? "failed" : "done",
          call: {
            id: str(payload.call_id),
            name,
            input: JSON.stringify(toolInput(name, text, edit)),
          },
          output: text,
        },
      },
    ]
  }
  if (type === "run.usage") {
    const out: MuseMapped[] = []
    const models = Array.isArray(payload.models) ? payload.models.map(obj) : []
    out.push({
      kind: "event",
      event: {
        type: "usage",
        input: models.reduce((n, m) => n + num(m.input_tokens), 0),
        output: models.reduce((n, m) => n + num(m.output_tokens), 0),
      },
    })
    const allowance = obj(payload.allowance)
    const limits = [
      ...limitOf("window", allowance.window, "used_percent", "resets_at_ms"),
      ...limitOf("weekly", allowance.weekly, "used_percent", "resets_at_ms"),
    ]
    if (limits.length > 0) out.push({ kind: "limits", limits })
    return out
  }
  if (type.startsWith("run.terminal")) {
    const terminal = str(payload.terminal)
    if (terminal === "completed") {
      state.done = true
      // A run that only wrote its answer at the end still shows it.
      return !state.hasText && str(payload.text)
        ? [{ kind: "event", event: { type: "text", text: str(payload.text) } }]
        : []
    }
    state.failed =
      str(payload.reason) || str(payload.text) || `The run ended: ${terminal || "unknown"}.`
  }
  return []
}

export const museFailure = (text: string): ProviderFailure => {
  if (/allowance|usage limit|rate.?limit|quota|too many requests|\b429\b/i.test(text))
    return new ProviderFailure("provider_limit", text)
  if (/not logged in|log ?in|sign ?in|unauthor|credential|token|\b401\b/i.test(text))
    return new ProviderFailure("runtime_signed_out", text)
  return new ProviderFailure("provider_error", text || "The program ended with an error.")
}

/**
 * The flags of a headless run, which cannot ask the user. Only a run that has no tools, or that
 * the level lets do everything, is headless; any other run goes through the session host.
 */
export const museSafety = (run: RuntimeRun): string[] => {
  if (!run.useTools) return ["--disable-write", "--disable-shell", "--disable-web-tools"]
  if (run.permission === "ask_all") return ["--disable-write", "--disable-shell"]
  if (run.permission === "full") return ["--disable-approval", "--disable-sandbox"]
  // The sandbox of the program stays on: it can write in the workspace, and cannot reach out.
  return []
}

export const museArgs = (run: RuntimeRun, promptFile: string): string[] => {
  const args = [
    "exec",
    "--json",
    // Nothing of this run stays in the session store of the user, and nothing of the user's
    // other agent tools (rules, skills of Claude Code and the like) comes in.
    "--no-session-log",
    "--no-foreign-personal-context",
    "--disable-reminders",
    "--disable-request-user-input",
    "--workspace",
    run.workspace,
    "--prompt-file",
    promptFile,
    ...museSafety(run),
  ]
  if (run.model !== "default") args.push("--model", run.model)
  if (run.effort) args.push("--reasoning-effort", run.effort)
  return args
}

export const musePrompt = (run: RuntimeRun) => {
  const head = run.system.trim()
  return head ? `${head}\n\n---\n\n${run.prompt}` : run.prompt
}

const TAIL = 2000

/** A run that may need the user's answer goes through the session host. The others stay headless. */
export const museAsks = (run: RuntimeRun) => run.useTools && run.permission !== "full"

export async function* runMuse(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  yield* museAsks(run) ? runMuseHost(run) : runMuseExec(run)
}

async function* runMuseExec(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  mkdirSync(run.workspace, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), "robot-muse-"))
  const promptFile = join(scratch, "prompt.txt")
  writeFileSync(promptFile, musePrompt(run), { mode: 0o600 })
  const child = spawn(run.bin, museArgs(run, promptFile), {
    cwd: run.workspace,
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
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

  const state = newMuseState()
  try {
    for await (const line of lines) {
      // The program also prints notes on its own: only the lines of JSON are events.
      if (!line.startsWith("{")) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      for (const mapped of mapMuseLine(message, state)) {
        if (mapped.kind === "event") yield mapped.event
        else run.onLimits(mapped.limits)
      }
    }
    if (run.signal.aborted) return
    if (state.failed !== null) throw museFailure(state.failed)
    if (!state.done) {
      const code = await exited
      throw museFailure(
        startError?.message ?? (stderr.trim() || `The program ended with code ${code}.`),
      )
    }
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

// ---- a turn through the session host ----------------------------------------------------
//
// `muse serve` speaks JSON-RPC, one message on each line. Unlike `muse exec`, it asks the client
// to decide a step that the sandbox and the judge of the program do not allow. The app shows that
// request as an approval card and sends the answer back.

/** A time-ordered id. The host wants a new one for each command. */
export const commandId = (now = Date.now()): string => {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The host takes no flag for the files of other agent tools. The program has a switch in the
 * environment for them, which the host reads once at the start. Reminder agents have no switch
 * for the host, so they run after the reply; the app ends the host as soon as the reply is done.
 */
const hostEnv = (): NodeJS.ProcessEnv => ({
  ...env(),
  MUSE_EXPERIMENTAL_FOREIGN_PERSONAL_CONTEXT_KILL: "1",
})

/** The flags of the host. Its approval mode is chosen on the wire, not here. */
export const museHostArgs = (run: RuntimeRun): string[] => [
  "serve",
  // Nothing of this run stays in the session store of the user.
  "--no-session-log",
  "--disable-request-user-input",
  ...(run.permission === "ask_all" ? ["--disable-write", "--disable-shell"] : []),
]

/**
 * What the card says about a step that the host asks about. The sandbox and the judge of the
 * program have already passed on the step, so the user has to decide it: every one of these is
 * risky for the app, and shows its card at "Ask for risky steps" too. The "always allow" key is
 * not wider than the step on the card: the same command text, the same path, the same host. A
 * step of a kind that the app does not know keeps its arguments in the key, so that a yes for
 * one call is never a yes for the tool.
 */
export const describeMuseApproval = (params: unknown): ApprovalRequest => {
  const request = obj(params)
  const subject = obj(request.subject)
  // The card sits on the tool call of the transcript, which the host names by its item.
  const callId = str(request.itemId) || str(request.toolCallId)
  const kind = str(subject.kind)
  if (kind === "shell") {
    const command = str(subject.command)
    return { callId, risky: true, key: `run_command:${command.trim()}`, summary: command }
  }
  if (kind === "fileAccess") {
    const path = str(subject.path) || "."
    const base = subject.access === "write" ? "write_file" : "read_file"
    return {
      callId,
      risky: true,
      key: `${base}:${path}`,
      summary: `${str(request.toolName) || base}: ${path}`,
    }
  }
  const host = str(subject.host)
  const name = str(request.toolName) || kind || "tool"
  if (kind === "network" && host) {
    const protocol = str(subject.protocol)
    const port = subject.port ? `:${num(subject.port)}` : ""
    return {
      callId,
      risky: true,
      key: `network:${host}`,
      summary: `${protocol ? `${protocol}://` : ""}${host}${port}`,
    }
  }
  const args = str(request.rawArgs)
  return {
    callId,
    risky: true,
    key: `${kind || "tool"}:${name}:${args}`,
    summary: `${name}: ${args}`.slice(0, 500),
  }
}

/** The choice of the host that matches the answer of the user. Null when it offers none. */
export const pickMuseChoice = (choices: unknown, allowed: boolean) => {
  const list = (Array.isArray(choices) ? choices : []).map(obj)
  // Only "once" is asked for: a wider grant of the program is not what the user chose.
  const order = allowed ? ["approved", "approvedForSession"] : ["denied", "abort"]
  for (const decision of order) {
    const found = list.find((c) => c.decision === decision && str(c.choiceId))
    if (found)
      return { choiceId: str(found.choiceId), acceptsFeedback: found.acceptsFeedback === true }
  }
  return null
}

export interface MuseHostState {
  /** An agent message has put text in the reply. */
  hasText: boolean
  /** A new message opened, so a break comes before its text. */
  breakDue: boolean
  /** The kind of each item that opened, so that a delta knows what it adds to. */
  kinds: Map<string, string>
  /** The messages whose text came as deltas. */
  streamed: Set<string>
  input: number
  output: number
  done: boolean
  failed: string | null
}

export const newMuseHostState = (): MuseHostState => ({
  hasText: false,
  breakDue: false,
  kinds: new Map(),
  streamed: new Set(),
  input: 0,
  output: 0,
  done: false,
  failed: null,
})

const argsInput = (name: string, args: string) => {
  let path = ""
  try {
    const body = obj(JSON.parse(args))
    path = str(body.file_path) || str(body.path)
  } catch {}
  return toolInput(name, args, { path })
}

const text = (state: MuseHostState, chunk: string): MuseMapped[] => {
  if (!chunk) return []
  const lead = state.breakDue && state.hasText ? "\n\n" : ""
  state.breakDue = false
  state.hasText = true
  return [{ kind: "event", event: { type: "text", text: `${lead}${chunk}` } }]
}

/** Turns one notification of the host into what the app does with it. */
export const mapMuseNotification = (
  method: string,
  params: unknown,
  state: MuseHostState,
): MuseMapped[] => {
  const body = obj(params)
  switch (method) {
    case "item/started": {
      const item = obj(body.item)
      const kind = str(item.kind)
      state.kinds.set(str(item.itemId), kind)
      if (kind === "agentMessage") {
        state.breakDue = state.hasText
        return text(state, str(item.text))
      }
      if (kind !== "toolCall") return []
      const name = str(item.tool) || "tool"
      return [
        {
          kind: "event",
          event: {
            type: "tool",
            state: "running",
            call: {
              id: str(item.itemId),
              name,
              input: JSON.stringify(argsInput(name, str(item.args))),
            },
          },
        },
      ]
    }
    case "item/delta": {
      const id = str(body.itemId)
      if (state.kinds.get(id) !== "agentMessage" || (str(body.field) || "text") !== "text")
        return []
      state.streamed.add(id)
      return text(state, str(body.delta))
    }
    case "item/completed": {
      const item = obj(body.item)
      const id = str(item.itemId)
      const kind = str(item.kind)
      if (kind === "agentMessage") {
        // A reply that came whole, with no deltas, still shows.
        if (state.streamed.has(id)) return []
        state.breakDue = state.hasText
        return text(state, str(item.text))
      }
      if (kind !== "toolCall") return []
      const name = str(item.tool) || "tool"
      return [
        {
          kind: "event",
          event: {
            type: "tool",
            state: item.status === "completed" ? "done" : "failed",
            call: {
              id,
              name,
              input: JSON.stringify(argsInput(name, str(item.args))),
            },
            output: str(item.visibleOutput) || str(item.failureReason),
          },
        },
      ]
    }
    case "session/tokenUsage": {
      const usage = obj(body.usage)
      state.input += num(usage.inputTokens)
      state.output += num(usage.outputTokens)
      return []
    }
    case "usage/changed": {
      const limits = [
        ...limitOf("window", body.window, "usedPercent", "resetsAtMs"),
        ...limitOf("weekly", body.weekly, "usedPercent", "resetsAtMs"),
      ]
      return limits.length > 0 ? [{ kind: "limits", limits }] : []
    }
    // The reply is done here. Reminder agents may still run after it, and the app does not wait.
    case "turn/foregroundCompleted":
      state.done = true
      return [{ kind: "event", event: { type: "usage", input: state.input, output: state.output } }]
    case "turn/completed": {
      if (state.done) return []
      const terminal = str(body.terminal)
      if (terminal === "completed") {
        state.done = true
        return [
          { kind: "event", event: { type: "usage", input: state.input, output: state.output } },
        ]
      }
      state.failed =
        str(obj(body.error).message) ||
        str(body.reason) ||
        (terminal === "cancelled"
          ? "The run was cancelled."
          : `The run ended: ${terminal || "unknown"}.`)
      return []
    }
    default:
      return []
  }
}

const INIT = 1
const SESSION = 2
const TURN = 3
/** The ids of the answers that the app sends for approvals start here. */
const DECISION = 100

async function* runMuseHost(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  mkdirSync(run.workspace, { recursive: true })
  // The host wants the real path of the folder.
  const root = realpathSync(run.workspace)
  const child = spawn(run.bin, museHostArgs(run), {
    cwd: root,
    env: hostEnv(),
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
  const send = (message: unknown) => {
    if (child.stdin.writable)
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...obj(message) })}\n`)
  }
  const call = (id: number, method: string, params: unknown) => send({ id, method, params })

  const state = newMuseHostState()
  /** The approvals that the user allowed: a later stage of the same step does not ask again. */
  const allowedApprovals = new Set<string>()
  let sessionId = ""
  let decisions = DECISION
  try {
    call(INIT, "initialize", {
      clientInfo: { name: "robot", version: "1" },
      // The host never asks a question: the app has no card for the prompts of this program.
      capabilities: { userInputDialogs: false },
    })
    for await (const line of lines) {
      if (!line.startsWith("{")) continue
      let message: Json
      try {
        message = obj(JSON.parse(line))
      } catch {
        continue
      }
      const method = str(message.method)
      if (method === "approval/request" && typeof message.id === "number") {
        // The reply only says that the request is shown. The answer goes as its own command.
        send({ id: message.id, result: {} })
        const params = obj(message.params)
        const approvalId = str(params.approvalId)
        let allowed = allowedApprovals.has(approvalId)
        if (!allowed) {
          try {
            allowed = await run.approve(describeMuseApproval(params))
          } catch (error) {
            if (run.signal.aborted) return
            throw error
          }
          if (allowed) allowedApprovals.add(approvalId)
        }
        const choice = pickMuseChoice(params.availableChoices, allowed)
        if (!choice)
          throw new ProviderFailure(
            "provider_error",
            "The program gave no choice for a step that needs approval.",
          )
        call(decisions++, "approval/decide", {
          sessionId,
          approvalId,
          choiceId: choice.choiceId,
          commandId: commandId(),
          requirementId: params.currentRequirementId,
          ...(!allowed && choice.acceptsFeedback ? { feedback: "The user denied this step." } : {}),
        })
        continue
      }
      if (method && typeof message.id === "number") {
        // A request that the app cannot answer fails at once, so the host does not wait for it.
        send({ id: message.id, error: { code: -32601, message: "Method not supported." } })
        continue
      }
      if (method) {
        for (const mapped of mapMuseNotification(method, message.params, state)) {
          if (mapped.kind === "event") yield mapped.event
          else run.onLimits(mapped.limits)
        }
        if (state.done || state.failed !== null) break
        continue
      }
      const id = typeof message.id === "number" ? message.id : 0
      if (message.error !== undefined) {
        // The host may refuse an answer for a step that ended on its own meanwhile.
        if (id >= DECISION) continue
        throw museFailure(str(obj(message.error).message) || "The program refused the request.")
      }
      if (id === INIT) {
        send({ method: "initialized" })
        call(SESSION, "session/start", {
          commandId: commandId(),
          workspaceRoot: root,
          workspaceRoots: [root],
          // The program decides what is plain, and asks the user about the rest.
          approvalMode: "onRequest",
          ...(run.model !== "default" ? { modelId: run.model } : {}),
        })
      } else if (id === SESSION) {
        sessionId = str(obj(obj(message.result).session).sessionId)
        call(TURN, "turn/start", {
          commandId: commandId(),
          sessionId,
          input: [{ type: "text", text: musePrompt(run) }],
          ...(run.effort ? { reasoningEffort: run.effort } : {}),
        })
      }
    }
    if (run.signal.aborted) return
    if (state.failed !== null) throw museFailure(state.failed)
    if (!state.done) {
      const code = await exited
      throw museFailure(
        startError?.message ?? (stderr.trim() || `The program ended with code ${code}.`),
      )
    }
  } finally {
    run.signal.removeEventListener("abort", stop)
    child.stdin.end()
    if (child.exitCode === null) {
      // Reminder agents may still run. The reply is done, so the host ends now.
      const timer = setTimeout(stop, 500)
      await exited
      clearTimeout(timer)
    }
  }
}
