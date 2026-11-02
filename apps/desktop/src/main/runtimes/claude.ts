import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { createInterface } from "node:readline"
import { insideWorkspace, type RuntimeLimit, riskyReason } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import { bridgeToolName, stage } from "./bridge.ts"
import { runtimeEnv } from "./env.ts"
import { execute } from "./proc.ts"
import type { ApprovalRequest, Login, RuntimeRun } from "./types.ts"

export const parseVersion = (text: string): string | null =>
  /(\d+\.\d+\.\d+[\w.-]*)/.exec(text)?.[1] ?? null

/** Reads the answer of `claude auth status`. */
export const parseClaudeStatus = (stdout: string): Login => {
  const none: Login = { signedIn: false, method: null, user: null, plan: null }
  try {
    const status = JSON.parse(stdout) as Record<string, unknown>
    if (status.loggedIn !== true) return none
    const subscription =
      status.authMethod === "claude.ai" &&
      (status.apiProvider === undefined || status.apiProvider === "firstParty")
    return {
      signedIn: true,
      method: subscription ? "subscription" : "api_key",
      user: typeof status.email === "string" ? status.email : null,
      plan: typeof status.subscriptionType === "string" ? status.subscriptionType : null,
    }
  } catch {
    return none
  }
}

export const claudeLogin = async (bin: string): Promise<Login> => {
  const done = await execute(bin, ["auth", "status"], { env: runtimeEnv(), timeoutMs: 15_000 })
  return parseClaudeStatus(done.stdout)
}

export const claudeVersion = async (bin: string): Promise<string | null> => {
  const done = await execute(bin, ["--version"], { env: runtimeEnv(), timeoutMs: 15_000 })
  return done.code === 0 ? parseVersion(done.stdout) : null
}

/** Opens the sign-in of the subscription in the browser, and ends when the vendor program ends. */
export const claudeSignIn = (bin: string, signal: AbortSignal) =>
  execute(bin, ["auth", "login", "--claudeai"], {
    env: runtimeEnv(),
    timeoutMs: 5 * 60_000,
    signal,
  })

// ---- the stream of a turn --------------------------------------------------------------

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" ? (value as Json) : {}
const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? value : 0)

export type Mapped =
  | { readonly kind: "event"; readonly event: AgentEvent }
  | {
      readonly kind: "permission"
      readonly requestId: string
      /** The id of the tool call that asks. The card of that call shows the question. */
      readonly toolUseId: string
      readonly tool: string
      readonly input: Json
    }
  | {
      readonly kind: "limits"
      readonly limits: readonly RuntimeLimit[]
      /** True when the vendor refuses requests until `resetsAt`. */
      readonly rejected: boolean
      readonly resetsAt: number | null
    }
  | {
      readonly kind: "result"
      readonly ok: boolean
      readonly text: string
      readonly input: number
      readonly output: number
    }

export interface StreamState {
  /** The tool calls seen so far, by id. */
  readonly calls: Map<string, { name: string; input: string }>
}

export const newStreamState = (): StreamState => ({ calls: new Map() })

const outputText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((block) => str(obj(block).text))
      .filter(Boolean)
      .join("\n")
  return ""
}

const seconds = (value: unknown) => (typeof value === "number" ? value * 1000 : null)

/** Turns one message of the stream into what the app does with it. */
export const mapClaudeMessage = (message: unknown, state: StreamState): Mapped[] => {
  const msg = obj(message)
  const sub = msg.parent_tool_use_id !== undefined && msg.parent_tool_use_id !== null
  switch (msg.type) {
    case "stream_event": {
      if (sub) return []
      const event = obj(msg.event)
      if (event.type !== "content_block_delta") return []
      const delta = obj(event.delta)
      if (delta.type === "text_delta" && str(delta.text))
        return [{ kind: "event", event: { type: "text", text: str(delta.text) } }]
      if (delta.type === "thinking_delta" && str(delta.thinking))
        return [{ kind: "event", event: { type: "thinking", text: str(delta.thinking) } }]
      return []
    }
    case "assistant": {
      if (sub) return []
      const out: Mapped[] = []
      const content = obj(msg.message).content
      for (const block of Array.isArray(content) ? content.map(obj) : []) {
        if (block.type !== "tool_use" || state.calls.has(str(block.id))) continue
        const call = { name: str(block.name), input: JSON.stringify(block.input ?? {}) }
        state.calls.set(str(block.id), call)
        out.push({
          kind: "event",
          event: { type: "tool", state: "running", call: { id: str(block.id), ...call } },
        })
      }
      return out
    }
    case "user": {
      if (sub) return []
      const out: Mapped[] = []
      const content = obj(msg.message).content
      for (const block of Array.isArray(content) ? content.map(obj) : []) {
        if (block.type !== "tool_result") continue
        const id = str(block.tool_use_id)
        const call = state.calls.get(id) ?? { name: "tool", input: "{}" }
        out.push({
          kind: "event",
          event: {
            type: "tool",
            state: block.is_error === true ? "failed" : "done",
            call: { id, ...call },
            output: outputText(block.content),
          },
        })
      }
      return out
    }
    case "control_request": {
      const request = obj(msg.request)
      if (request.subtype !== "can_use_tool") return []
      return [
        {
          kind: "permission",
          requestId: str(msg.request_id),
          toolUseId: str(request.tool_use_id) || str(msg.request_id),
          tool: str(request.tool_name),
          input: obj(request.input),
        },
      ]
    }
    case "rate_limit_event": {
      const info = "rate_limit_info" in msg ? obj(msg.rate_limit_info) : msg
      const windows = obj(info.unifiedWindows)
      const limits: RuntimeLimit[] = Object.entries(windows).map(([window, value]) => ({
        window,
        used: Math.min(1, Math.max(0, num(obj(value).utilization))),
        resetsAt: seconds(obj(value).resetsAt),
      }))
      return [
        {
          kind: "limits",
          limits,
          rejected: info.status === "rejected",
          resetsAt: seconds(info.resetsAt),
        },
      ]
    }
    case "result": {
      const usage = obj(msg.usage)
      return [
        {
          kind: "result",
          ok: msg.subtype === "success" && msg.is_error !== true,
          text: str(msg.result),
          input:
            num(usage.input_tokens) +
            num(usage.cache_creation_input_tokens) +
            num(usage.cache_read_input_tokens),
          output: num(usage.output_tokens),
        },
      ]
    }
    default:
      return []
  }
}

// ---- permission prompts ----------------------------------------------------------------

const FILE_READ = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"])
const FILE_WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

const firstWord = (command: string) => command.trim().split(/\s+/)[0] ?? ""

/** What the card says about a step, and whether the rules of the app call it risky. */
export const describeRequest = (
  callId: string,
  tool: string,
  input: Json,
  workspace: string,
): ApprovalRequest => {
  if (tool === "Bash" || tool === "PowerShell") {
    const command = str(input.command)
    const reason = riskyReason(command, workspace)
    return {
      callId,
      risky: reason !== null,
      key: `run_command:${reason ?? firstWord(command)}`,
      summary: command,
    }
  }
  if (FILE_READ.has(tool) || FILE_WRITE.has(tool)) {
    const path = str(input.file_path) || str(input.notebook_path) || str(input.path) || "."
    const inside = insideWorkspace(path, workspace)
    const base = FILE_WRITE.has(tool) ? "write_file" : "read_file"
    return {
      callId,
      risky: !inside,
      key: `${base}${inside ? "" : ":outside"}`,
      summary: `${tool}: ${path}`,
    }
  }
  if (tool === "WebFetch")
    return { callId, risky: false, key: "fetch_url", summary: str(input.url) || tool }
  if (tool === "WebSearch")
    return { callId, risky: false, key: "web_search", summary: str(input.query) || tool }
  const detail = JSON.stringify(input).slice(0, 200)
  return { callId, risky: false, key: `tool:${tool}`, summary: `${tool} ${detail}` }
}

// ---- running a turn --------------------------------------------------------------------

/** `mcpConfig` is the file that lets the program reach the tools of the app (see bridge.ts). */
export const claudeArgs = (run: RuntimeRun, mcpConfig?: string): string[] => {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    // Prompts for permission come to the app as messages, and the app answers them.
    "--permission-prompt-tool",
    "stdio",
    // The settings, hooks and servers of the user are not for the agents of this app.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
    "--model",
    run.model,
  ]
  if (run.effort) args.push("--effort", run.effort)
  if (run.system.trim()) args.push("--append-system-prompt", run.system)
  if (run.useTools) args.push("--disallowedTools", "AskUserQuestion")
  else args.push("--tools", "")
  return args
}

/** What went wrong in a turn that the vendor ended with an error. */
export const claudeFailure = (text: string, resetsAt: number | null): ProviderFailure => {
  if (/\b(limit|quota|usage)\b/i.test(text) && /\b(reached|hit|exceeded|resets?)\b/i.test(text))
    return new ProviderFailure("provider_limit", text, resetsAt ?? undefined)
  if (/log ?in|sign ?in|authenticat|oauth|401|unauthorized|expired/i.test(text))
    return new ProviderFailure("runtime_signed_out", text)
  return new ProviderFailure("provider_error", text || "The program ended with an error.")
}

const TAIL = 2000

export async function* runClaude(run: RuntimeRun): AsyncGenerator<AgentEvent> {
  mkdirSync(run.workspace, { recursive: true })
  const staged = run.bridge ? stage(run.bridge) : null
  const child = spawn(run.bin, claudeArgs(run, staged?.claudeConfig), {
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
      // A program that could not start never ends its output; this ends the reading.
      lines.close()
      resolve(code)
    }),
  )
  const stop = () => child.kill()
  run.signal.addEventListener("abort", stop, { once: true })
  const send = (message: unknown) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  child.stdin.on("error", () => {})

  const state = newStreamState()
  let limitsResetAt: number | null = null
  let rejected = false
  let result: Extract<Mapped, { kind: "result" }> | undefined
  try {
    send({ type: "user", message: { role: "user", content: run.prompt } })
    for await (const line of lines) {
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      for (const mapped of mapClaudeMessage(message, state)) {
        if (mapped.kind === "event") yield mapped.event
        else if (mapped.kind === "limits") {
          run.onLimits(mapped.limits)
          rejected = mapped.rejected
          limitsResetAt = mapped.resetsAt
        } else if (mapped.kind === "permission") {
          const call = describeRequest(mapped.toolUseId, mapped.tool, mapped.input, run.workspace)
          // A tool of the app asks the user by itself, at the permission level of the agent.
          let allowed = bridgeToolName(mapped.tool) !== null
          try {
            if (!allowed) allowed = await run.approve(call)
          } catch (error) {
            if (run.signal.aborted) return
            throw error
          }
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: mapped.requestId,
              response: allowed
                ? { behavior: "allow", updatedInput: mapped.input }
                : { behavior: "deny", message: "The user denied this step." },
            },
          })
        } else result = mapped
      }
      if (result) break
    }
    child.stdin.end()
    if (run.signal.aborted) return
    if (!result) {
      const code = await exited
      throw new ProviderFailure(
        "provider_error",
        startError?.message ?? (stderr.trim() || `The program ended with code ${code}.`),
      )
    }
    if (!result.ok) throw claudeFailure(result.text, rejected ? limitsResetAt : null)
    yield { type: "usage", input: result.input, output: result.output }
  } finally {
    run.signal.removeEventListener("abort", stop)
    child.stdin.end()
    if (child.exitCode === null) {
      // Give the program a moment to end by itself, then stop it.
      const timer = setTimeout(stop, 2000)
      await exited
      clearTimeout(timer)
    }
    staged?.remove()
  }
}
