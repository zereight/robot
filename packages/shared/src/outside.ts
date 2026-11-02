import type { MessagePart } from "./chat.ts"
import { toolStepKind } from "./notifications.ts"
import type { LoggedKind, StepAccess } from "./steps.ts"
import type { TaskSource } from "./task.ts"
import type { PermissionLevel } from "./tools.ts"

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

export const OUTSIDE_SOURCE_KINDS = ["page", "connection", "secret", "routine", "agent"] as const

/** Who started a turn. Only "user" is a turn that the user started. */
export type TurnStarter = "user" | "routine" | "workflow" | "agent"

/** The starter of a turn of a task, by the source of the task. */
export const starterOf = (source: TaskSource): TurnStarter =>
  source === "routine" ? "routine" : source === "workflow" ? "workflow" : "user"

/**
 * The steps that ask again in a turn that holds outside content (spec 007):
 * - `memory`: a save to memory (008),
 * - `settings`: a change of the agent's own settings or instructions (002),
 * - `secret_request`: a request with a saved secret that uses a method other than GET (020),
 * - `secret_new`: a request for a new secret (020).
 */
export const GUARDED_STEPS = ["memory", "settings", "secret_request", "secret_new"] as const
export type GuardedStep = (typeof GUARDED_STEPS)[number]

/**
 * The permission levels that the guard knows. "Read only" is the strictest level of spec 007; the
 * guard decides for it already, so that the level can use the guard when it comes.
 */
export type GuardLevel = PermissionLevel | "read_only"

/**
 * What the guard decides about a guarded step:
 * - `refuse_rule`: a Deny rule refuses it, at every level,
 * - `refuse_read_only`: "Read only" refuses it, as other changes,
 * - `ask`: an approval card with Allow once and Deny only,
 * - `run`: it runs with no question ("Full access"),
 * - `usual`: the guard adds nothing; the step goes the way it goes with no outside content.
 */
export type GuardVerdict = "refuse_rule" | "refuse_read_only" | "ask" | "run" | "usual"

export interface GuardInput {
  readonly step: GuardedStep
  readonly level: GuardLevel
  /** True when the turn holds outside content. */
  readonly outside: boolean
  readonly starter: TurnStarter
  /** True when a Deny rule matches the step. */
  readonly denied?: boolean
}

/** The decision for a guarded step (spec 007, "Outside content"). An Allow rule does not count. */
export const guardDecision = (input: GuardInput): GuardVerdict => {
  if (input.denied) return "refuse_rule"
  // At "Read only" a save to memory follows the outside rule; every other guarded step is a change.
  if (input.level === "read_only" && input.step !== "memory") return "refuse_read_only"
  if (input.level === "full") return "run"
  if (input.outside) return "ask"
  // A turn that the user did not start asks before a change of the agent's own settings.
  if (input.step === "settings" && input.starter !== "user") return "ask"
  return "usual"
}

/**
 * The mark of one turn: who started it and the first source of outside content, or null. A turn
 * holds outside content from the first such step until it ends.
 */
export interface TurnMark {
  readonly starter: TurnStarter
  source: OutsideSource | null
}

/**
 * A new mark. A turn that a message from another agent or a watch routine starts passes its
 * source here: it holds outside content from its start.
 */
export const newTurnMark = (
  starter: TurnStarter,
  source: OutsideSource | null = null,
): TurnMark => ({
  starter,
  source,
})

/** The turn got outside content. The first source stays. */
export const holdOutside = (mark: TurnMark, source: OutsideSource | null): void => {
  if (source && !mark.source) mark.source = source
}

/** The host of an address, or "" when it is not an address. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

const argsOf = (input: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(input || "{}")
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The connection and tool of a name like `mcp__server__tool` or `server.tool`. */
const connectionOf = (name: string): { connection: string; tool: string } => {
  if (name.startsWith("mcp__")) {
    const [, connection = "", ...rest] = name.split("__")
    return { connection, tool: rest.join("__") }
  }
  const [connection = "", tool = ""] = name.split(".")
  return { connection, tool }
}

/**
 * The outside content that an ended tool call gave the agent, or null. It knows the tools of the
 * app and the web, browser and connection tools of vendor programs.
 */
export const outsideOfCall = (name: string, input: string): OutsideSource | null => {
  const args = argsOf(input)
  const url = typeof args.url === "string" ? args.url : ""
  if (name === "add_source") return url ? { kind: "page", host: hostOf(url) } : null
  // The answer of a request with a saved secret (spec 020).
  if (name === "secret_request")
    return typeof args.name === "string" ? { kind: "secret", name: args.name } : null
  if (name === "browser_close" || name === "browser_click" || name === "browser_type") return null
  const kind = toolStepKind(name)
  if (kind === "web" || kind === "browser") return { kind: "page", host: hostOf(url) }
  if (kind === "connection") return { kind: "connection", ...connectionOf(name) }
  return null
}

/**
 * The first outside content in the saved parts of a reply. A turn that waited through a restart
 * gets its mark back from it: an ended step that gave outside content, or the card that waits.
 */
export const outsideOfParts = (parts: readonly MessagePart[]): OutsideSource | null => {
  for (const part of parts) {
    if (part.kind !== "tool") continue
    if (part.ask?.kind === "approval" && part.ask.outside) return part.ask.outside
    if (part.state === "done" || part.state === "failed") {
      const source = outsideOfCall(part.name, part.input)
      if (source) return source
    }
  }
  return null
}

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
    default:
      return false
  }
}

/** Who decided a step of the action log (spec 007, "Action log"). */
export type ActionDecider = "level" | "allow_rule" | "deny_rule" | "user"
/** The result of a step of the action log. */
export type ActionResult = "ran" | "failed" | "refused" | "stopped"

/**
 * The kind of an entry of the action log: a guarded step (spec 007, "Outside content"), or a step
 * of the four kinds of "Permission rules": file, shell command, web page, tool of a connection.
 */
export type ActionKind = GuardedStep | LoggedKind

/** One entry of the action log. */
export interface ActionLogEntry {
  readonly id: string
  readonly at: number
  readonly agentId: string
  /** The name that the agent had at the time of the step. */
  readonly agentName: string
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
}

export const ACTION_LOG_DAYS = 90
export const ACTION_LOG_MAX = 100_000
export const ACTION_TARGET_MAX = 200
