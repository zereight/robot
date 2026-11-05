import { toolStepKind } from "./notifications.ts"
import { redactSecrets } from "./redact.ts"

// ---------------------------------------------------------------------------------------------
// Limits of a task (spec 005).
// ---------------------------------------------------------------------------------------------

/** A task at this depth or deeper cannot send a message to another agent. */
export const CHAIN_LIMIT = 8

export const STEP_LIMIT_MIN = 20
export const STEP_LIMIT_MAX = 2000
export const STEP_LIMIT_DEFAULT = 300

/** True when `value` is a whole number that the setting "step limit" accepts. */
export const isStepLimit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= STEP_LIMIT_MIN &&
  value <= STEP_LIMIT_MAX

/** True when a task at this depth may not send a message (spec 005, "Message chain"). */
export const chainAtLimit = (depth: number) => depth >= CHAIN_LIMIT

/**
 * The depth of a task, from what made it. A task that the user, a routine or a workflow starts
 * has depth 0. A message of another agent, and the reply to such a message, make a task one
 * deeper than the task that caused it. A part of a plan, a nudge and a retry keep the depth of
 * the task that made them.
 */
export const taskDepth = (
  cause: { readonly kind: "none" } | { readonly kind: "same" | "message"; readonly depth: number },
): number => (cause.kind === "none" ? 0 : cause.kind === "same" ? cause.depth : cause.depth + 1)

/** The reason that the sender of a message gets when the chain is at its limit. */
export const CHAIN_LIMIT_TEXT = `The chain of agent messages is at its limit (${CHAIN_LIMIT}).`

/**
 * Told to every agent that has the tool "send message" (spec 007). The main agent is the one
 * that sends the most, but every agent has the tool, so every agent reads the rule (see
 * `docs/spec-questions.md`, 007 and 002).
 */
export const CHAIN_LIMIT_RULE =
  "When the tool send_message fails because the chain of agent messages is at its limit, do not look for another way to pass the same work on. Tell the user what stopped."

/** What the model reads when the repeated-read guard refuses a step. */
export const REPEATED_READ_TEXT =
  "You already have this result: the same target gave the same result twice in this turn. Use the result you already have, or do something else."

// ---------------------------------------------------------------------------------------------
// The record of the steps of a task (spec 007, "Action log"). The retry note reads it.
// ---------------------------------------------------------------------------------------------

/** The step kinds that the action log lists: files, shell commands, web pages, tools of a connection. */
export const LOGGED_KINDS = ["file", "shell", "web", "connection"] as const
export type LoggedKind = (typeof LOGGED_KINDS)[number]

/** For a file step: whether the step read or wrote. Other kinds have none. */
export type StepAccess = "read" | "write"

export const STEP_RESULTS = ["ran", "failed", "refused", "stopped"] as const
export type StepResult = (typeof STEP_RESULTS)[number]

/** A target is cut at this many characters. */
export const TARGET_MAX = 200

export interface LoggedStep {
  readonly kind: LoggedKind
  readonly access: StepAccess | null
  /** A path, a command, an address, or the name of a connection and a tool. Never arguments of a connection tool. */
  readonly target: string
  readonly result: StepResult
  readonly at: number
}

const READ_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_files",
  "read_article",
  "read",
  "glob",
  "grep",
  "ls",
  "find",
  "notebookread",
])

/**
 * Whether a file tool reads or writes. A tool that is not known to read counts as a write: the
 * safer reading, because a missed write would hide the retry note.
 */
export const fileAccess = (toolName: string): StepAccess =>
  READ_TOOLS.has(toolName.trim().toLowerCase()) ? "read" : "write"

/** The kind of a tool, as the action log lists it, or null when the log has no entry for it. */
export const loggedKind = (toolName: string): LoggedKind | null => {
  const kind = toolStepKind(toolName)
  if (kind === "files") return "file"
  if (kind === "command") return "shell"
  if (kind === "web") return "web"
  if (kind === "connection") return "connection"
  return null
}

const FIELDS = ["path", "file_path", "command", "cmd", "url", "query", "pattern", "title", "name"]

/** The text a card shows for the target of a step: the first usual field of the input. */
const firstField = (input: string): string => {
  let args: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(input || "{}")
    if (value && typeof value === "object") args = value as Record<string, unknown>
  } catch {}
  for (const key of FIELDS) {
    const value = args[key]
    if (typeof value === "string" && value) return value
    if (Array.isArray(value) && typeof value[0] === "string") return value.join(" ")
  }
  return ""
}

/**
 * The short target of a step. A tool of a connection names the connection and the tool, never
 * the arguments. A secret in the text is hidden, and the text is cut.
 */
export const stepTarget = (toolName: string, input: string, connection?: string): string => {
  const kind = loggedKind(toolName)
  // `connection` is "connection name · tool name", when the app knows the names (spec 018).
  const raw = kind === "connection" ? (connection ?? toolName) : firstField(input)
  const clean = redactSecrets(raw.replace(/\s+/g, " ").trim())
  return [...clean].length > TARGET_MAX ? [...clean].slice(0, TARGET_MAX).join("") : clean
}

/**
 * A step that may change things: a file write, a shell command, or a tool of a connection, with
 * the result Ran, Failed or Stopped. A step that failed or stopped may have run in part. A
 * refused step did not run.
 */
export const mayChange = (step: Pick<LoggedStep, "kind" | "access" | "result">): boolean => {
  if (step.result === "refused") return false
  if (step.kind === "shell" || step.kind === "connection") return true
  return step.kind === "file" && step.access === "write"
}

// ---------------------------------------------------------------------------------------------
// The retry note (spec 005).
// ---------------------------------------------------------------------------------------------

/** The note lists at most this many steps. */
export const RETRY_NOTE_STEPS = 5

export interface RetryNote {
  /**
   * The name of the computer where the task ran, when the list of steps is not on this
   * computer. Null when the list is here.
   */
  readonly computer: string | null
  /** The steps that may have changed things, newest first. At most 5. Empty with no list. */
  readonly steps: readonly LoggedStep[]
  /** How many more steps exist than the list shows. */
  readonly more: number
}

/**
 * The note for a retry, from the steps of the first try (oldest first), or null when none of
 * them may have changed things and the retry starts at once.
 */
export const retryNote = (steps: readonly LoggedStep[]): RetryNote | null => {
  const changing = steps.filter(mayChange).reverse()
  if (changing.length === 0) return null
  return {
    computer: null,
    steps: changing.slice(0, RETRY_NOTE_STEPS),
    more: Math.max(0, changing.length - RETRY_NOTE_STEPS),
  }
}

/** The note when the steps of the first try are not on this computer: the same text, no list. */
export const remoteRetryNote = (computer: string): RetryNote => ({
  computer,
  steps: [],
  more: 0,
})

/** What a retry request answers: the new try started, or the note that the user must read first. */
export type RetryResult =
  | { readonly started: true }
  | { readonly started: false; readonly note: RetryNote }

// ---------------------------------------------------------------------------------------------
// Repeated reads (spec 005).
// ---------------------------------------------------------------------------------------------

/** The tools of the app that read a file or fetch a web page, and that the guard watches. */
export const GUARDED_TOOLS: readonly string[] = ["read_file", "fetch_url"]

/** A 53-bit hash of a text, so the guard keeps a short mark of a result and not the result. */
const fingerprint = (text: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length}:${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`
}

/**
 * Watches the reads of one turn. A read is refused when two earlier steps of the turn had the
 * same target and the same result as this one. A read that gives a new result is not refused.
 * The guard keeps a mark of every result, also the result of a refused step, and only the last
 * two for each target.
 */
export const createReadGuard = () => {
  const seen = new Map<string, string[]>()
  return {
    /** Records a read and tells whether it must be refused. */
    refuse(tool: string, target: string, result: string): boolean {
      const key = `${tool}\0${target}`
      const mark = fingerprint(result)
      const earlier = seen.get(key) ?? []
      const refused = earlier.length === 2 && earlier[0] === mark && earlier[1] === mark
      seen.set(key, [...earlier, mark].slice(-2))
      return refused
    },
  }
}
export type ReadGuard = ReturnType<typeof createReadGuard>

/**
 * The note that the agent of a new try reads before its prompt (spec 005, "Retry note"). It is text
 * for the model, not interface text. It lists the same steps as the note of the user.
 */
export const retryNoteForModel = (note: RetryNote): string => {
  const head =
    "This task is a new try of an earlier task that did not end well. The earlier try ran steps that may have changed things. Failed, Blocked and Cancelled do not undo them."
  const ask =
    "Check the current state before you do one of these steps again, so that you do not do a thing twice, for example push a change or send a message again."
  if (note.computer !== null)
    return `${head} It ran on the computer ${note.computer}, so the list of its steps is not here.\n${ask}`
  const lines = note.steps.map((s) => `- ${s.kind}: ${s.target} (${s.result})`)
  if (note.more > 0) lines.push(`- and ${note.more} more`)
  return `${head} The steps, newest first:\n${lines.join("\n")}\n${ask}`
}
