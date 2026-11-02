import type { Face } from "./agents.ts"

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
}

export interface IslandAgent {
  readonly id: string
  readonly name: string
  readonly face: Face
}

/** An approval or a question that waits for the user. */
export interface IslandAttention {
  readonly agentId: string
  readonly agent: IslandAgent
  readonly callId: string
  readonly kind: "approval" | "question"
  /** One line: the step to approve, or the question. */
  readonly summary: string
  readonly target: PlaceTarget
}

export interface IslandState {
  readonly mode: IslandMode
  /** Working agents, at most three. */
  readonly working: readonly IslandAgent[]
  /** How many agents work, also when more than three. */
  readonly count: number
  readonly attention: IslandAttention | null
}

export const ISLAND_WORKING_MAX = 3
export const ISLAND_SUMMARY_MAX = 90

/** One line, cut to the island width. */
export const islandSummary = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return [...line].length > ISLAND_SUMMARY_MAX
    ? `${[...line].slice(0, ISLAND_SUMMARY_MAX - 1).join("")}…`
    : line
}

/** What the island shows, from its mode: hidden, a bar, or the expanded attention card. */
export const islandShape = (state: IslandState): "hidden" | "bar" | "attention" => {
  if (state.mode === "off") return "hidden"
  if (state.attention) return "attention"
  return state.mode === "always" ? "bar" : "hidden"
}

/** Whether a message mentions the user. The user is `@you` or `@user`. */
export const mentionsUser = (text: string) => /(^|[^\w])@(you|user)\b/i.test(text)
