import type { RuleKind } from "./rules.ts"
import type { SensitiveLabel } from "./sensitive.ts"
import type { CheckReason } from "./unsure.ts"

/** The step kinds that the action log lists: files, shell commands, web pages, tools of a connection. */
export const LOGGED_KINDS = ["file", "shell", "web", "connection"] as const
export type LoggedKind = (typeof LOGGED_KINDS)[number]

/** For a file step: whether the step read or wrote. Other kinds have none. */
export type StepAccess = "read" | "write"

/**
 * Where outside content came from (spec 007, "Outside content"). The approval card of a guarded
 * step names the first source of the turn.
 */
export type OutsideSource =
  /** A page that the agent fetched or opened in its browser. The host is "" when not known. */
  | { readonly kind: "page"; readonly host: string }
  /** The result of a tool of a connection (018). */
  | { readonly kind: "connection"; readonly connection: string; readonly tool: string }
  /** The answer of a request with a saved secret (020). */
  | { readonly kind: "secret"; readonly name: string }
  /** The change that started a routine with a watch trigger (009). */
  | { readonly kind: "routine"; readonly name: string }
  /** A message from another agent. */
  | { readonly kind: "agent"; readonly name: string }
  /** A message from Teams (028). The card names "Teams" and holds no other data. */
  | { readonly kind: "teams" }

export const OUTSIDE_SOURCE_KINDS = [
  "page",
  "connection",
  "secret",
  "routine",
  "agent",
  "teams",
] as const satisfies readonly OutsideSource["kind"][]

/**
 * The source kinds that carry the program mark (spec 007, "Program mark"): a message from Teams
 * (028). A message of an outside program (023) joins this list when that feature is built: add its
 * kind to the type above and to this list, and nothing else in the program mark changes.
 */
const PROGRAM_SOURCE_KINDS: readonly OutsideSource["kind"][] = ["teams"]

/** True when a source carries the program mark: outside content from it holds the mark. */
export const carriesProgramMark = (source: OutsideSource | null | undefined): boolean =>
  source !== null && source !== undefined && PROGRAM_SOURCE_KINDS.includes(source.kind)

/**
 * The steps that ask again in a turn that holds outside content (spec 007):
 * - `memory`: a save to memory (008),
 * - `settings`: a change of the agent's own settings or instructions (002),
 * - `secret_request`: a request with a saved secret that uses a method other than GET (020),
 * - `secret_new`: a request for a new secret (020),
 * - `feedback`: adding feedback to a run in the chat (003, 007).
 */
export const GUARDED_STEPS = [
  "memory",
  "settings",
  "secret_request",
  "secret_new",
  "feedback",
] as const
export type GuardedStep = (typeof GUARDED_STEPS)[number]

/**
 * The step of a manage tool (spec 037): a change request for an agent, a channel or a routine. It
 * is not a guarded step: it asks the user at every level except "Read only", also at "Full access",
 * with or without outside content, and no rule covers it.
 */
export const MANAGE_STEP = "manage" as const
export type ManageStep = typeof MANAGE_STEP

/** True when a value has the shape of an outside source. Sync uses it for a card that waits. */
export const isOutsideSource = (v: unknown): v is OutsideSource => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  const text = (x: unknown) => typeof x === "string" && x.length <= 500
  const keys = (list: string[]) => Object.keys(o).every((k) => list.includes(k))
  switch (o.kind) {
    case "page":
      return keys(["kind", "host"]) && text(o.host)
    case "connection":
      return keys(["kind", "connection", "tool"]) && text(o.connection) && text(o.tool)
    case "secret":
    case "routine":
    case "agent":
      return keys(["kind", "name"]) && text(o.name)
    case "teams":
      return keys(["kind"])
    default:
      return false
  }
}

/** The source as a column stores it (JSON text), or null. Text that is no source reads as none. */
export const parseOutsideSource = (text: string | null | undefined): OutsideSource | null => {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return isOutsideSource(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Who decided a step of the action log (spec 007, "Action log"). `app` is the app itself, for an
 * address that is never allowed (spec 007, "Sensitive places"). `unreadable_rule` is a rule that
 * the app could not read, followed by the user on a card. `check` is the check of "Ask when
 * unsure": it was sure that the user asked for the step (spec 007).
 */
export type ActionDecider =
  | "level"
  | "allow_rule"
  | "deny_rule"
  | "user"
  | "app"
  | "unreadable_rule"
  | "check"

/** The decider values, for a column that stores them. */
export const ACTION_DECIDERS = [
  "level",
  "allow_rule",
  "deny_rule",
  "user",
  "app",
  "unreadable_rule",
  "check",
] as const satisfies readonly ActionDecider[]

/**
 * The check of "Ask when unsure" on a step of the log (spec 007, "Action log"): `allowed` is true
 * when the check was sure (the step ran, decided by the check, with its probability). When it is
 * false the check sent the step to the user (decided by the user, with the reason of the check).
 * A step that did not go to the check has none.
 */
export interface ActionCheck {
  readonly allowed: boolean
  /** The chance of "The user asked for this", or null when the check gave none. */
  readonly probability: number | null
  /** Why the check did not allow the step; null when it allowed it. */
  readonly reason: CheckReason | null
}

/**
 * The rule that decided a step, as the log keeps it. The text stays when the rule is deleted
 * later: the row then shows `deleted` (spec 007, "Action log").
 */
export interface ActionRule {
  readonly id: string
  readonly kind: RuleKind
  readonly text: string
  readonly detail: string | null
  readonly deleted: boolean
}
/** The result of a step of the action log. */
export type ActionResult = "ran" | "failed" | "refused" | "stopped"

/**
 * The kind of an entry of the action log: a guarded step (spec 007, "Outside content"), or a step
 * of the four kinds of "Permission rules": file, shell command, web page, tool of a connection.
 */
export type ActionKind = GuardedStep | ManageStep | LoggedKind
/** Every kind of step that the action log holds, for its filter (spec 007). */
export const ACTION_KINDS = [
  "memory",
  "settings",
  "secret_request",
  "secret_new",
  "feedback",
  MANAGE_STEP,
  "file",
  "shell",
  "web",
  "connection",
] as const satisfies readonly ActionKind[]

/** One entry of the action log. */
export interface ActionLogEntry {
  readonly id: string
  readonly at: number
  readonly workflowId: string
  /** The name that the workflow had at the time of the step. */
  readonly workflowName: string
  /** The name and the number that the node of the task had at the time of the step (spec 007). */
  readonly nodeName: string | null
  readonly nodeNumber: number | null
  readonly kind: ActionKind
  /** For a step of a file, whether it read or wrote (spec 007). Null for every other kind. */
  readonly access: StepAccess | null
  /** A short target, cut at 200 characters, with secrets hidden. */
  readonly target: string
  readonly decidedBy: ActionDecider
  readonly result: ActionResult
  readonly taskId: string | null
  /** The first source of outside content, when the turn held outside content. */
  readonly outside: OutsideSource | null
  /** The label of the first credential place, when the turn held a sensitive read. */
  readonly sensitive: SensitiveLabel | null
  /** The rule that decided the step, or the rule that could not be read. Null when none did. */
  readonly rule: ActionRule | null
  /** The check of "Ask when unsure", when the step went to the check (spec 007). */
  readonly check: ActionCheck | null
  /** The name of the linked device that answered the card of the step (spec 012), or null. */
  readonly device: string | null
}

export const ACTION_LOG_DAYS = 90
export const ACTION_LOG_MAX = 100_000
export const ACTION_TARGET_MAX = 200

/** The host of an address, or "" when it is not an address. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

/**
 * What a guarded step does in a turn or a task (spec 007, "Outside content"). In a turn that holds
 * outside content, a guarded step asks the user at every level except "Full access". At "Full
 * access" it runs with no question, unless the turn holds the program mark. A turn that holds no
 * outside content runs the step as the level says: no extra question.
 */
export const guardVerdict = (input: {
  readonly level: import("./tools.ts").PermissionLevel
  readonly outside: boolean
  readonly program: boolean
}): "run" | "ask" => {
  if (input.program) return "ask"
  if (!input.outside) return "run"
  return input.level === "full" ? "run" : "ask"
}
