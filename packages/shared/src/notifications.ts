import type { Face } from "./agents.ts"
import type { MessagePart, ToolAsk } from "./chat.ts"

export const NOTIFY_KINDS = [
  "reply",
  "mention",
  "approval",
  "question",
  "task_failed",
  "routine_failed",
  "workflow_notice",
] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]

export const ISLAND_MODES = ["off", "attention", "always"] as const
export type IslandMode = (typeof ISLAND_MODES)[number]

export const MUTE_CHOICES = ["off", "1h", "8h", "1d", "forever"] as const
export type MuteChoice = (typeof MUTE_CHOICES)[number]

/** A server or a channel that does not notify. `until` is null for "until turned back on". */
export interface Mute {
  readonly kind: "server" | "channel"
  readonly id: string
  readonly until: number | null
}

const HOUR = 3_600_000
const MUTE_MS: Record<"1h" | "8h" | "1d", number> = { "1h": HOUR, "8h": 8 * HOUR, "1d": 24 * HOUR }

/** The end time of a mute, null for no end, or undefined when the choice removes the mute. */
export const muteUntil = (choice: MuteChoice, now: number): number | null | undefined =>
  choice === "off" ? undefined : choice === "forever" ? null : now + MUTE_MS[choice]

/** Whether a place is muted at `now`, by its channel or by its server. */
export const isMuted = (
  mutes: readonly Mute[],
  serverId: string,
  channelId: string | null,
  now: number,
) =>
  mutes.some(
    (m) =>
      ((m.kind === "server" && m.id === serverId) ||
        (m.kind === "channel" && channelId !== null && m.id === channelId)) &&
      (m.until === null || m.until > now),
  )

/** Where a notification leads: a place, and a message in it. */
export interface PlaceTarget {
  readonly kind: "agent" | "channel"
  readonly id: string
  readonly messageId?: string
  /** Set for a place on a linked server: the window opens that server first (spec 012). */
  readonly serverId?: string
}

export interface IslandAgent {
  readonly id: string
  readonly name: string
  readonly face: Face
}

/** The kinds of step that the island names, see spec 007. */
export const TOOL_STEP_KINDS = [
  "files",
  "command",
  "web",
  "browser",
  "connection",
  "agent",
  "computer",
] as const
export type ToolStepKind = (typeof TOOL_STEP_KINDS)[number]

const FILE_TOOLS = new Set([
  "list_files",
  "read_file",
  "write_file",
  "search_files",
  "read_article",
  "write_article",
  "delete_article",
  "add_source",
  "file_change",
  "read",
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "notebookread",
  "glob",
  "grep",
  "ls",
  "find",
  "apply_patch",
])
const COMMAND_TOOLS = new Set(["run_command", "bash", "bashoutput", "killshell", "shell"])
const WEB_TOOLS = new Set(["fetch_url", "webfetch", "websearch", "web_search"])

/**
 * The kind of step that a tool name stands for, or null when the name is none of the kinds. The
 * names are those of the tools of the app and of the vendor programs. The island shows the kind
 * and never the arguments of the step.
 */
export const toolStepKind = (name: string): ToolStepKind | null => {
  const n = name.trim().toLowerCase()
  if (FILE_TOOLS.has(n)) return "files"
  if (COMMAND_TOOLS.has(n) || n.startsWith("exec_command")) return "command"
  if (WEB_TOOLS.has(n)) return "web"
  if (n.startsWith("browser_") || n === "browser") return "browser"
  if (n.startsWith("computer_") || n === "computer") return "computer"
  if (n === "task" || n === "ask_agent") return "agent"
  // A tool of a connection: `mcp__server__tool`, or `server.tool`.
  if (n.startsWith("mcp__") || /^[^./\\\s]+\.[^./\\\s]+$/.test(n)) return "connection"
  return null
}

/** The kind of step that runs now in a reply: the last tool part that has not ended. */
export const runningStepKind = (parts: readonly MessagePart[]): ToolStepKind | null => {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.kind === "tool" && (part.state === "running" || part.state === "waiting"))
      return toolStepKind(part.name)
  }
  return null
}

/** The name of the tool that a call of a reply used, or undefined. */
export const toolNameOf = (parts: readonly MessagePart[], callId: string) => {
  const part = parts.find((p) => p.kind === "tool" && p.id === callId)
  return part?.kind === "tool" ? part.name : undefined
}

/**
 * The kind of step that an approval card asks about, from the tool that waits. A question has
 * none. An article card is about files. Null when the tool name is none of the kinds.
 */
export const askStep = (ask: ToolAsk, toolName: string | undefined): ToolStepKind | null =>
  ask.kind === "question" ? null : ask.kind === "article" ? "files" : toolStepKind(toolName ?? "")

/** An approval or a question that waits for the user. */
export interface IslandAttention {
  readonly agentId: string
  readonly agent: IslandAgent
  readonly callId: string
  readonly kind: "approval" | "question"
  /** The step to approve, or the question. Cut by `attentionText`. */
  readonly summary: string
  /** The channel name, or null for a direct chat. */
  readonly place: string | null
  /** For an approval, the kind of step. Null when the app does not know it. */
  readonly step: ToolStepKind | null
  /**
   * True when the island may offer "Always allow for this agent": an approval of a task that runs
   * on this computer, with that choice on its card. A request of the other computer of a sync
   * pair never has it (spec 015, 019).
   */
  readonly always: boolean
  readonly target: PlaceTarget
}

/** What an agent does now, see "Detail card" in spec 015. */
export type IslandDoing =
  | { readonly kind: "plan"; readonly label: string }
  | { readonly kind: "tool"; readonly tool: ToolStepKind }
  | { readonly kind: "none" }

/** One row of the detail card. */
export interface IslandRow {
  readonly agent: IslandAgent
  /** The channel name, or null for a direct chat. */
  readonly place: string | null
  readonly target: PlaceTarget
  readonly doing: IslandDoing
  /** When the current task started, in ms. */
  readonly since: number
}

/** The result card. `id` is new for each result, so a newer result replaces an older one. */
export interface IslandResult {
  readonly id: number
  readonly kind: "reply" | "task_failed" | "routine_failed"
  readonly agent: IslandAgent
  readonly place: string | null
  /** The first line of a reply. Empty for a failure. */
  readonly line: string
  /** Why a task or routine failed. Null for a reply. */
  readonly reason: { readonly code: string; readonly detail: string } | null
  readonly target: PlaceTarget
}

export interface IslandState {
  readonly mode: IslandMode
  /** Working agents, at most three. */
  readonly working: readonly IslandAgent[]
  /** How many agents work, also when more than three. */
  readonly count: number
  /** One row for each working agent, at most five. */
  readonly rows: readonly IslandRow[]
  /** The requests that wait, the oldest first. */
  readonly waiting: readonly IslandAttention[]
  readonly result: IslandResult | null
}

export const ISLAND_WORKING_MAX = 3
export const ISLAND_ROWS_MAX = 5
export const ISLAND_SUMMARY_MAX = 90
export const ISLAND_QUESTION_MAX = 160
export const ISLAND_LINE_MAX = 90
/** The result card stays this long, and longer while the pointer is on it. */
export const ISLAND_RESULT_MS = 6000
/** The detail card closes this long after the pointer has left. */
export const ISLAND_CLOSE_MS = 400

const cutLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim()
  return [...line].length > max ? `${[...line].slice(0, max - 1).join("")}…` : line
}

/** One line, cut to the island width. */
export const islandSummary = (text: string) => cutLine(text, ISLAND_SUMMARY_MAX)

/** The text of an attention card: 90 characters for an approval, 160 for a question. */
export const attentionText = (kind: IslandAttention["kind"], text: string) =>
  cutLine(text, kind === "question" ? ISLAND_QUESTION_MAX : ISLAND_SUMMARY_MAX)

/** The first line of a reply that has text, cut to 90 characters. */
export const firstLine = (text: string) => {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "")
  return line === undefined ? "" : cutLine(line, ISLAND_LINE_MAX)
}

/** How long a task has run: m:ss, and h:mm:ss after one hour. */
export const formatRunTime = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, "0")
  const hours = Math.floor(total / 3600)
  if (hours === 0) return `${Math.floor(total / 60)}:${seconds}`
  return `${hours}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${seconds}`
}

/** The kinds of notice that can show a result card. */
export const RESULT_KINDS = ["reply", "task_failed", "routine_failed"] as const
export const isResultKind = (kind: NotifyKind): kind is IslandResult["kind"] =>
  (RESULT_KINDS as readonly string[]).includes(kind)

/** The key of a waiting request. */
export const attentionKey = (a: Pick<IslandAttention, "agentId" | "callId">) =>
  `${a.agentId}:${a.callId}`

/**
 * Which request the attention card shows after the list changed. The request that showed stays
 * when it is still there. When the user answered it, the card shows the request that took its
 * place, that is the next one.
 */
export const attentionIndex = (
  before: readonly IslandAttention[],
  index: number,
  after: readonly IslandAttention[],
) => {
  if (after.length === 0) return 0
  const shown = before[index]
  if (shown) {
    const same = after.findIndex((a) => attentionKey(a) === attentionKey(shown))
    if (same >= 0) return same
  }
  return Math.min(Math.max(index, 0), after.length - 1)
}

export type IslandShape = "hidden" | "bar" | "attention" | "result"

/**
 * What the island shows, from its mode: hidden, a bar, the result card, or the attention card.
 * The detail card opens from the bar when the pointer is on it. The window decides that.
 */
export const islandShape = (state: IslandState): IslandShape => {
  if (state.mode === "off") return "hidden"
  if (state.waiting.length > 0) return "attention"
  if (state.mode !== "always") return "hidden"
  return state.result ? "result" : "bar"
}

/** Whether a message mentions the user. The user is `@you` or `@user`. */
export const mentionsUser = (text: string) => /(^|[^\w])@(you|user)\b/i.test(text)
