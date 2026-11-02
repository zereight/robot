import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { RuntimeLimit } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import { parseVersion } from "./claude.ts"
import { runtimeEnv } from "./env.ts"
import { execute } from "./proc.ts"
import type { Login, RuntimeRun } from "./types.ts"

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

/** The flags that the permission level gives. A headless run cannot ask, so the level limits it. */
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

export async function* runMuse(run: RuntimeRun): AsyncGenerator<AgentEvent> {
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
