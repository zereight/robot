import { charLength } from "./agents.ts"
import { catalogues, type MessageKey, translate } from "./i18n/index.ts"
import type { Locale } from "./settings.ts"
import type { TeamsTargetKind } from "./teamsLink.ts"

// Answers and the outbox of the Teams link (spec 028, S103): the pure rules of the marker, the
// split into messages, the rate, the back-off, the drop rules and the lines for Teams. Nothing here
// touches a page, a clock or a database.

/** A message to Teams has at most this many characters. The marker counts. */
export const TEAMS_MESSAGE_MAX = 4000
/** One answer is at most this many messages. A longer text is cut. */
export const TEAMS_ANSWER_MESSAGES_MAX = 5
/** At most this many messages go out in one window. */
export const TEAMS_SEND_RATE_MAX = 20
export const TEAMS_SEND_RATE_WINDOW_MS = 60_000
/** The outbox holds at most this many messages. */
export const TEAMS_OUTBOX_MAX = 50
/** The first try again comes after this long. Then the time doubles, up to the maximum. */
export const TEAMS_RETRY_FIRST_MS = 5000
export const TEAMS_RETRY_MAX_MS = 5 * 60_000
/** A message holds back the later messages until it has failed this many tries in a row. */
export const TEAMS_HOLD_TRIES = 3
/** A message that failed is dropped after this long, counted from its first failed try. */
export const TEAMS_DROP_AFTER_MS = 60 * 60_000
/** The reason in a line "could not finish" is cut at this many characters. */
export const TEAMS_REASON_MAX = 300
/** Settings, Teams lists the newest records, at most this many. */
export const TEAMS_RECORDS_MAX = 50
/** At most one line "Too many messages" goes out in this time. */
export const TEAMS_TOO_MANY_WINDOW_MS = 60_000

// --- The marker --------------------------------------------------------------------------------

/** Every answer starts with the marker and one space. */
export const withMarker = (marker: string, text: string): string => `${marker.trim()} ${text}`

// --- The split ---------------------------------------------------------------------------------

const isBreakSpace = (char: string | undefined) =>
  char === " " || char === "\n" || char === "\r" || char === "\t"

/**
 * Takes the first chunk of `chars` from `from`, with at most `capacity` characters. When the rest
 * does not fit, the chunk ends at a line break or at a space when it can. A line break counts
 * first when it is in the second half of the room; else a space; else any line break; else the
 * chunk ends at the room. `next` is where the rest begins, with the spaces and breaks of the
 * cut taken away.
 */
const takeChunk = (chars: readonly string[], from: number, capacity: number) => {
  if (chars.length - from <= capacity) return { end: chars.length, next: chars.length }
  let lineBreak = -1
  let space = -1
  // The break char itself may be the first char after the chunk, so the search reaches it.
  for (let i = from + capacity; i > from; i--) {
    const char = chars[i]
    if (lineBreak < 0 && char === "\n") lineBreak = i
    if (space < 0 && (char === " " || char === "\t")) space = i
    if (lineBreak >= 0 && space >= 0) break
  }
  const half = from + capacity / 2
  const end =
    lineBreak >= half
      ? lineBreak
      : space >= 0
        ? space
        : lineBreak >= 0
          ? lineBreak
          : from + capacity
  let next = end
  while (next < chars.length && isBreakSpace(chars[next])) next++
  return { end, next }
}

/**
 * Splits an answer into messages (spec 028, "The outbox"). Each message starts with the marker and
 * one space, and has at most 4,000 characters, the marker included. The text is split at a line
 * break or a space when possible. One answer is at most 5 messages. A text that needs more is cut:
 * the last message ends with `cutLine`, on a line of its own.
 */
export const splitAnswer = (
  marker: string,
  text: string,
  cutLine: string,
): { readonly messages: string[]; readonly cut: boolean } => {
  const prefix = `${marker.trim()} `
  const capacity = TEAMS_MESSAGE_MAX - charLength(prefix)
  const chars = [...text.trim()]
  const messages: string[] = []
  let from = 0
  while (from < chars.length && messages.length < TEAMS_ANSWER_MESSAGES_MAX) {
    const last = messages.length === TEAMS_ANSWER_MESSAGES_MAX - 1
    let room = capacity
    let chunk = takeChunk(chars, from, room)
    let cut = false
    if (last && chunk.next < chars.length) {
      // The text goes on after the last message: it keeps room for the line that says so.
      room = capacity - charLength(cutLine) - 1
      chunk = takeChunk(chars, from, room)
      cut = true
    }
    const body = chars.slice(from, chunk.end).join("").trimEnd()
    messages.push(`${prefix}${body}${cut ? `\n${cutLine}` : ""}`)
    if (cut) return { messages, cut: true }
    from = chunk.next
  }
  return { messages, cut: false }
}

// --- The rate, the back-off and the drop rules -------------------------------------------------

/** The sends that still count in the window of one minute. */
export const recentSends = (times: readonly number[], now: number): number[] =>
  times.filter((at) => now - at < TEAMS_SEND_RATE_WINDOW_MS && at <= now)

/** True when one more message may go out now: fewer than 20 went out in the last minute. */
export const sendMayGo = (times: readonly number[], now: number): boolean =>
  recentSends(times, now).length < TEAMS_SEND_RATE_MAX

/**
 * How long to wait after the n-th failed try in a row: 5 seconds after the first, then twice as
 * long after each try, up to 5 minutes.
 */
export const retryDelayMs = (failedTries: number): number =>
  Math.min(TEAMS_RETRY_FIRST_MS * 2 ** Math.max(0, failedTries - 1), TEAMS_RETRY_MAX_MS)

/** What the order of the outbox needs to know of a message. */
export interface OutboxTiming {
  /** Failed tries in a row. */
  readonly tries: number
  /** The earliest time of the next try. */
  readonly nextTryAt: number
}

/** True while a message holds the later messages back: it has failed fewer than 3 tries. */
export const holdsLaterBack = (message: Pick<OutboxTiming, "tries">): boolean =>
  message.tries < TEAMS_HOLD_TRIES

/**
 * The message to try now, or null. Messages go in order. A message that waits for its next try
 * holds the later ones back until it has failed 3 tries in a row (spec 028): then the later
 * messages go on and it is tried again at its own time.
 */
export const pickNext = (outbox: readonly OutboxTiming[], now: number): number | null => {
  for (let i = 0; i < outbox.length; i++) {
    const message = outbox[i] as OutboxTiming
    if (message.nextTryAt <= now) return i
    if (holdsLaterBack(message)) return null
  }
  return null
}

/** True when a message that failed is old enough to be dropped with the record "Not sent". */
export const sendTooOld = (firstFailedAt: number | null, now: number): boolean =>
  firstFailedAt !== null && now - firstFailedAt >= TEAMS_DROP_AFTER_MS

/** True when the line "Too many messages" may go out now: at most one each minute. */
export const tooManyLineMayGo = (lastAt: number | null, now: number): boolean =>
  lastAt === null || now < lastAt || now - lastAt >= TEAMS_TOO_MANY_WINDOW_MS

// --- The lines for Teams -----------------------------------------------------------------------

/** The lines that the app writes in Teams besides the reply text (spec 028). */
export type TeamsLine =
  | { readonly kind: "noReply" }
  | { readonly kind: "files"; readonly count: number }
  | { readonly kind: "failed"; readonly name: string; readonly reason: string }
  | { readonly kind: "stopped"; readonly name: string }
  | { readonly kind: "waiting"; readonly name: string }
  | { readonly kind: "tooMany" }
  | { readonly kind: "queueFull"; readonly name: string }
  | { readonly kind: "gap" }

/** The word of a line in the link log. */
export const lineWord = (line: TeamsLine): string =>
  line.kind === "noReply"
    ? "no_reply"
    : line.kind === "tooMany"
      ? "too_many"
      : line.kind === "queueFull"
        ? "queue_full"
        : line.kind

/** The text of a line, in the language of the app. The marker is not part of it. */
export const lineText = (locale: Locale, line: TeamsLine): string => {
  switch (line.kind) {
    case "noReply":
      return translate(locale, "teams.line.noReply")
    case "files":
      return line.count === 1
        ? translate(locale, "teams.line.file")
        : translate(locale, "teams.line.files", { count: line.count })
    case "failed":
      return translate(locale, "teams.line.failed", { name: line.name, reason: line.reason })
    case "stopped":
      return translate(locale, "teams.line.stopped", { name: line.name })
    case "waiting":
      return translate(locale, "teams.line.waiting", { name: line.name })
    case "tooMany":
      return translate(locale, "teams.line.tooMany")
    case "queueFull":
      return translate(locale, "error.tasks_full", { detail: line.name })
    case "gap":
      return translate(locale, "teams.line.gap")
  }
}

/** The line that ends a text that was cut. */
export const cutLineText = (locale: Locale): string => translate(locale, "teams.line.cut")

/**
 * The reason in a line "could not finish": the text of the error as the app shows it, in the
 * language of the app, on one line and cut at 300 characters.
 */
export const failureReason = (
  locale: Locale,
  error: { readonly code: string; readonly detail: string } | null,
): string => {
  const key = error ? (`error.${error.code}` as MessageKey) : "error.unknown"
  const text =
    key in catalogues.en
      ? translate(locale, key, { detail: error?.detail ?? "" })
      : translate(locale, "error.unknown")
  return [...text.replace(/\s+/g, " ").trim()].slice(0, TEAMS_REASON_MAX).join("")
}

// --- Records -----------------------------------------------------------------------------------

/**
 * Why an answer did not go out (spec 028, "Records"). A record holds no text of a message. The
 * reason "linkPaused" is for the slice that pauses the link.
 */
export const TEAMS_RECORD_REASONS = [
  "wrongChat",
  "notSent",
  "outboxFull",
  "linkOff",
  "linkPaused",
  "signedOut",
] as const
export type TeamsRecordReason = (typeof TEAMS_RECORD_REASONS)[number]

export const isTeamsRecordReason = (value: unknown): value is TeamsRecordReason =>
  typeof value === "string" && (TEAMS_RECORD_REASONS as readonly string[]).includes(value)

/** The word of a reason in the link log. */
export const recordReasonWord = (reason: TeamsRecordReason): string =>
  reason.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** The text of a reason in Settings, Teams. */
export const teamsRecordReasonKey = (reason: TeamsRecordReason): MessageKey =>
  `teams.record.${reason}`

/** One record in Settings, Teams: the time, the reason, the place, and the task. No text. */
export interface TeamsRecord {
  readonly id: number
  readonly at: number
  readonly reason: TeamsRecordReason
  /** The agent or channel that the answer was for, or null. */
  readonly placeKind: TeamsTargetKind | null
  readonly placeId: string | null
  /** The name of the place now, or null when it is gone. */
  readonly placeName: string | null
  /** The task whose answer did not go out, or null (a line has no task). */
  readonly taskId: string | null
}
