// "Look again later" (spec 005, "Follow-up"; 007, "Look again later"). An agent ends its turn and
// asks the app to start a new turn at a later time, so that it can check the result of work that
// takes time without holding a process open and without the user setting a routine.

/** The reason of a follow-up: one line, up to this many characters. */
export const FOLLOW_UP_REASON_MAX = 200
/** The delay of a follow-up: a whole number of minutes, from 1 to 1440. */
export const FOLLOW_UP_MINUTES_MIN = 1
export const FOLLOW_UP_MINUTES_MAX = 24 * 60
/** One agent holds at most this many follow-ups that wait. */
export const FOLLOW_UPS_PER_AGENT_MAX = 20
/** A follow-up that is later than this does not start on wake: it is dropped (spec 005). */
export const FOLLOW_UP_LATE_MAX = 12 * 60 * 60 * 1000
/** How many late follow-ups start in one look. */
export const FOLLOW_UPS_PER_LOOK_MAX = 50

/** A follow-up that waits for its time. */
export interface FollowUp {
  readonly id: string
  readonly agentId: string
  /** The place: the direct chat of the agent, a thread of it, or a channel (spec 003, 004). */
  readonly channelId: string | null
  readonly threadId: string | null
  /** The task that the call was made in. Its details show this follow-up (spec 005). */
  readonly taskId: string
  /** One line: what the agent wants to look at. */
  readonly reason: string
  /** When the task starts, in ms. */
  readonly at: number
  readonly createdAt: number
}

/**
 * The reason of a follow-up from what the agent wrote: one line, with the line breaks and the
 * runs of spaces as one space, cut at `FOLLOW_UP_REASON_MAX`. Null for nothing.
 */
export const cleanFollowUpReason = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null
  const line = raw.replace(/\s+/g, " ").trim()
  if (line === "") return null
  const chars = [...line]
  return chars.length > FOLLOW_UP_REASON_MAX ? chars.slice(0, FOLLOW_UP_REASON_MAX).join("") : line
}

/** True when the delay of a follow-up is a whole number of minutes in the allowed range. */
export const validFollowUpMinutes = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= FOLLOW_UP_MINUTES_MIN &&
  value <= FOLLOW_UP_MINUTES_MAX

/** The time of a follow-up, from now and the delay in minutes. */
export const followUpAt = (now: number, minutes: number) => now + minutes * 60_000

/**
 * The prompt of the task that a follow-up starts (spec 005). The agent reads the reason and the
 * time of its own follow-up, and how late the task is when the app was off.
 */
export const followUpPrompt = (reason: string, at: number, now: number): string => {
  const late = now - at
  const lines = [
    `You asked to look again at this later, in an earlier turn: ${reason}`,
    `The time you asked for was ${timeText(at)}.`,
  ]
  if (late >= 60_000)
    lines.push(`This task starts ${minutesText(late)} late, because the app was off.`)
  lines.push("Do the work that the reason names now, and tell the user what you found.")
  return lines.join("\n")
}

/** A time of day in the user's own words: 24-hour clock, no seconds. */
export const timeText = (at: number) => {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A length of time in words, at most one unit: minutes, then hours, then days. */
export function minutesText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"}`
}

/** What a look at the clock does with one follow-up (spec 005). */
export type FollowUpDue =
  | { readonly kind: "none" }
  /** The time has come: the app makes its task at once. */
  | { readonly kind: "start" }
  /** The time has passed by more than the limit: no task, and the details say this. */
  | { readonly kind: "drop" }

/**
 * What the app does with a follow-up at `now`: nothing while its time is ahead. A follow-up that is
 * late starts, as a run of a routine that the app slept through does (009); the prompt says how
 * late it is. Only one that is more than `FOLLOW_UP_LATE_MAX` late is dropped, because the agent
 * would look at a result that is long gone.
 */
export const followUpDue = (at: number, now: number): FollowUpDue => {
  if (at > now) return { kind: "none" }
  return now - at <= FOLLOW_UP_LATE_MAX ? { kind: "start" } : { kind: "drop" }
}

/** The label of the task that a follow-up starts: "Look again: <reason>", cut for a list. */
export const followUpLabel = (reason: string, max = 60): string => {
  const full = [...`Look again: ${reason}`]
  return full.length > max ? `${full.slice(0, max - 1).join("")}…` : full.join("")
}

/**
 * What the model reads from a "wait until" call (spec 007, "Look again later"). The calls are
 * English, as the other replies of the tools are.
 */
export const FOLLOW_UP_REPLIES = {
  /** The reason is missing or holds nothing but spaces. */
  empty: "The reason is empty. Give one line that says what you will look at.",
  /** The delay is not a whole number of minutes in the allowed range. */
  minutes: `The delay must be a whole number of minutes, from ${FOLLOW_UP_MINUTES_MIN} to ${FOLLOW_UP_MINUTES_MAX}.`,
  /** The place is not a direct chat: a channel, a routine or a workflow step. */
  place: "A follow-up works in a direct chat. This place has no follow-up.",
  /** The agent holds 20 follow-ups already. */
  full: `This agent has ${FOLLOW_UPS_PER_AGENT_MAX} follow-ups that wait. Try again later.`,
  /** The follow-up is recorded. */
  recorded: (minutes: number, reason: string) =>
    `Recorded. A new turn starts in ${minutesText(minutes * 60_000)} to look at: ${reason}. End your turn now.`,
} as const
