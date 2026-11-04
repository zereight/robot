import type { MessageKey } from "./i18n/en.ts"
import type { TeamsState } from "./teamsLink.ts"

// The pause of the Teams link and its notices (spec 028, "States and errors"; 015; 021): the pure
// rules of the repeated failure, of the notification "Teams link needs you" and of the row in
// Today. Nothing here touches a page, a clock or a database.

/** The link pauses itself when this many reads in a row fail. */
export const TEAMS_PAUSE_READS = 20
/** The link pauses itself when this many tries to send in a row fail. */
export const TEAMS_PAUSE_SENDS = 6

/**
 * Why the link paused: the page could not be read, or the page did not take the messages. The
 * texts are "The app cannot read the Teams page" and "Teams does not take the messages".
 */
export const TEAMS_PAUSE_REASONS = ["read", "send"] as const
export type TeamsPauseReason = (typeof TEAMS_PAUSE_REASONS)[number]

export const isTeamsPauseReason = (value: unknown): value is TeamsPauseReason =>
  typeof value === "string" && (TEAMS_PAUSE_REASONS as readonly string[]).includes(value)

/** The text of the reason of a pause, in Settings, Teams and in the Today row. */
export const teamsPauseReasonKey = (reason: TeamsPauseReason): MessageKey =>
  reason === "read" ? "teams.pause.read" : "teams.pause.send"

// --- The count of failures ---------------------------------------------------------------------

/** The failed reads in a row and the failed tries to send in a row. Each has its own count. */
export interface TeamsFailCounts {
  readonly reads: number
  readonly sends: number
}

export const noFailures: TeamsFailCounts = { reads: 0, sends: 0 }

/**
 * What a read or a try to send came to:
 * - `good`: the read finished, or the page took the message. The count of that kind is set to 0.
 * - `failed`: the page could not be read, or it did not take the message. The count goes up by 1.
 * - `neutral`: the read or the try says nothing about the page. "Signed out", "Chat not found" and
 *   "Offline" are not failures (spec 028), and a chat with another title is not a failure of the
 *   page. The count stays as it is.
 */
export type TeamsAttempt = "good" | "failed" | "neutral"

/** The counts after an attempt, and the reason to pause now, or null. */
export interface TeamsCounted {
  readonly counts: TeamsFailCounts
  readonly pause: TeamsPauseReason | null
}

/**
 * Counts one read. The 20th failed read in a row pauses the link; the counts are then 0, so that a
 * resume starts clean.
 */
export const countRead = (counts: TeamsFailCounts, attempt: TeamsAttempt): TeamsCounted => {
  if (attempt === "neutral") return { counts, pause: null }
  if (attempt === "good") return { counts: { ...counts, reads: 0 }, pause: null }
  const reads = counts.reads + 1
  return reads >= TEAMS_PAUSE_READS
    ? { counts: noFailures, pause: "read" }
    : { counts: { ...counts, reads }, pause: null }
}

/** Counts one try to send. The 6th failed try in a row pauses the link. */
export const countSend = (counts: TeamsFailCounts, attempt: TeamsAttempt): TeamsCounted => {
  if (attempt === "neutral") return { counts, pause: null }
  if (attempt === "good") return { counts: { ...counts, sends: 0 }, pause: null }
  const sends = counts.sends + 1
  return sends >= TEAMS_PAUSE_SENDS
    ? { counts: noFailures, pause: "send" }
    : { counts: { ...counts, sends }, pause: null }
}

/**
 * The counts after the page was seen offline. A try to send that fails while the network is down
 * says nothing about the page, so the row of failed tries ends. The row of failed reads stays: a
 * page that cannot be read is still a failed read after a look that found no network.
 */
export const afterOffline = (counts: TeamsFailCounts): TeamsFailCounts => ({
  ...counts,
  sends: 0,
})

// --- The notification --------------------------------------------------------------------------

/** The states that need the user: the notification and the row in Today are for these (spec 028). */
export type TeamsNeed = "signedOut" | "paused"

/** The need of a state, or null when the state does not need the user. */
export const teamsNeed = (state: TeamsState): TeamsNeed | null =>
  state === "signedOut" || state === "paused" ? state : null

/**
 * The states that say nothing about the need: the link looks again. A look at the page can go from
 * Signed out to Offline and back, and that is no new need. Any other state that is not a need
 * (On, Off, Chat not found, Target missing) ends the need.
 */
const keepsNeed = (state: TeamsState): boolean => state === "connecting" || state === "offline"

export interface TeamsNoticeStep {
  /** The need that the notification is for now, or null when none goes out. */
  readonly notify: TeamsNeed | null
  /** The need that the link remembers: it is the need that made the last notification. */
  readonly memory: TeamsNeed | null
}

/**
 * Decides if the notification "Teams link needs you" goes out (spec 028, 015). One notification
 * goes out when the state becomes Signed out or Paused, once for each change: the same need that is
 * still there makes no second one, and a loop of the link makes none. The memory ends when the
 * state is fine (On), when the user turned the link off (Off), and for Chat not found and Target
 * missing. Connecting and Offline keep it, so a short look that fails does not make a flood.
 */
export const teamsNoticeStep = (memory: TeamsNeed | null, state: TeamsState): TeamsNoticeStep => {
  const need = teamsNeed(state)
  if (need !== null) return { notify: need === memory ? null : need, memory: need }
  return { notify: null, memory: keepsNeed(state) ? memory : null }
}

/** The title of the notification, and the text of its body. Neither holds a name or a message. */
export const teamsNoticeTitleKey = "teams.notice.title" as const satisfies MessageKey

export const teamsNoticeBodyKey = (need: TeamsNeed): MessageKey =>
  need === "paused" ? "teams.notice.paused" : "teams.notice.signedOut"

// --- The row in Today --------------------------------------------------------------------------

/** What the link tells the Today page: the state that needs the user, and since when. */
export interface TeamsAttention {
  readonly state: TeamsNeed
  /** Why the link paused, or null for Signed out. */
  readonly reason: TeamsPauseReason | null
  /** When the state began, or the time of the pause. */
  readonly since: number
}
