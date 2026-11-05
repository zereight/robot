// Events (spec 038). One arrival at a place that the user made: a schedule, a watch, a web hook, a
// message of an outside program, or a test of a trigger form. The Events tab shows each arrival,
// the place, and the result.

/** The source of an event, in the order of spec 038. */
export const EVENT_SOURCES = [
  "schedule",
  "watch",
  "web_hook",
  "outside_program",
  "teams",
  "test",
] as const
export type EventSource = (typeof EVENT_SOURCES)[number]

/** What the app did with an event (spec 038, "Result"). */
export const EVENT_RESULTS = [
  "routed",
  "would_go",
  "duplicate",
  "waits",
  "skipped",
  "no_rule",
  "failed",
] as const
export type EventResult = (typeof EVENT_RESULTS)[number]

/** The summary line of an event, and the detail. */
export const EVENT_SUMMARY_MAX = 200
export const EVENT_DETAIL_MAX = 20_000
/** A profile keeps this many events. The oldest leaves when a new one arrives at the limit. */
export const EVENTS_MAX = 2000
/** An id counts as a duplicate for this long (spec 038, "Duplicates"). */
export const EVENT_ID_DAYS = 7
export const EVENT_ID_MS = EVENT_ID_DAYS * 24 * 60 * 60 * 1000
/** A test event leaves after this time. */
export const EVENT_TEST_MS = 24 * 60 * 60 * 1000
/** A subject holds 1 to this many characters, from the set below. */
export const EVENT_SUBJECT_MAX = 100
export const EVENT_ID_MAX = 200
/** The page reads this many rows at most for one look, in groups of 50. */
export const EVENTS_PER_LOOK_MAX = 200
export const EVENTS_PAGE = 50
/** "Make a rule" is offered on the newest 20 events only. */
export const EVENTS_FOR_RULE = 20

/** The characters of a subject (spec 038, "One at a time for one subject"). */
const SUBJECT_MARKS = new Set(["#", ".", "_", ":", "/", "@", "-"])

/** True when a subject fits the form of spec 038. */
export const validEventSubject = (value: string): boolean => {
  if (value.length < 1 || value.length > EVENT_SUBJECT_MAX) return false
  for (const ch of value) {
    if (/[A-Za-z0-9]/.test(ch)) continue
    if (!SUBJECT_MARKS.has(ch)) return false
  }
  return true
}

/**
 * A text of an event that the user reads (spec 038). The app writes its own words as a key and its
 * parameters, so that the row shows the language of the interface (AGENTS.md: interface text comes
 * from translation keys, never literals). Text that a source gives from outside is kept as it came.
 */
export type EventText =
  | { readonly key: string; readonly params: Readonly<Record<string, string>> }
  | { readonly text: string }

/** True when the app wrote this text, so that it goes through the catalogue. */
export const isKeyedText = (value: EventText): value is Extract<EventText, { key: string }> =>
  "key" in value

/** A text of an event as the user reads it. */
export const eventText = (
  value: EventText,
  translate: (key: string, params?: Record<string, string>) => string,
): string => ("key" in value ? translate(value.key, { ...value.params }) : value.text)

/** How the app chose the place of an event (spec 038, "Why"). */
export type EventWhy = EventText

/** A short reason that the row shows under its text. */
export type EventReason = EventText

/** An event: one arrival, with its place and its result. */
export interface RobotEvent {
  readonly id: string
  readonly serverId: string
  readonly source: EventSource
  /** A short name that the source gives, for example "issue opened". */
  readonly type: EventText
  readonly subject: string | null
  /** The name that the source gives to one call, for a call that comes again. */
  readonly callId: string | null
  readonly summary: EventText
  readonly detail: string
  readonly link: string | null
  /** The agent of the place, when the place has one. */
  readonly agentId: string | null
  /** The routine or the workflow that took it, when one did. */
  readonly placeId: string | null
  /** True when the place is a routine. False when it is a workflow, or when there is none. */
  readonly placeIsRoutine: boolean
  readonly placeName: string | null
  /** How the app chose the place, in one line (spec 038, "Why"). */
  readonly why: EventWhy
  /** What the turn got for the event, cut at what a turn keeps. */
  readonly got: string
  /** The task or the run that the event started. */
  readonly taskId: string | null
  readonly result: EventResult
  /** The reason of a result that does not speak for itself. */
  readonly reason: EventReason | null
  /** True when the text came from outside this app (spec 007). */
  readonly outside: boolean
  readonly at: number
}

/** An event that the app is about to store: the fields that the caller gives. */
export interface EventInput {
  readonly serverId: string
  readonly source: EventSource
  readonly type: EventText
  readonly subject?: string | null
  readonly callId?: string | null
  readonly summary: EventText
  readonly detail?: string
  readonly link?: string | null
  readonly agentId?: string | null
  readonly placeId?: string | null
  readonly placeIsRoutine?: boolean
  readonly placeName?: string | null
  readonly why: EventWhy
  readonly got?: string
  readonly taskId?: string | null
  readonly result: EventResult
  readonly reason?: EventReason | null
  readonly outside?: boolean
}

/** A summary line: one line, the runs of spaces as one space, cut at the limit. */
export const cleanEventSummary = (raw: string): string => {
  const line = raw.replace(/\s+/g, " ").trim()
  const chars = [...line]
  return chars.length > EVENT_SUMMARY_MAX
    ? `${chars.slice(0, EVENT_SUMMARY_MAX - 1).join("")}…`
    : chars.join("")
}

/**
 * Shortens the parameters of a keyed text, so that no stored field grows past its limit. The
 * summary line of the catalogue is already short; a parameter that a place name fills is cut at
 * the limit of a subject.
 */
export const cleanEventParams = (
  params: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    const chars = [...value.replace(/\s+/g, " ").trim()]
    out[key] =
      chars.length > EVENT_SUBJECT_MAX ? chars.slice(0, EVENT_SUBJECT_MAX).join("") : chars.join("")
  }
  return out
}

/** A detail, cut at the limit, with the mark of the cut. */
export const cutEventDetail = (raw: string, max = EVENT_DETAIL_MAX): string => {
  const chars = [...raw]
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")
}

/**
 * True when two events of one subject would go at the same time. Only the messages of an outside
 * program wait in turn (spec 038, "One at a time for one subject"). A schedule, a watch and a web
 * hook keep their own rules (009, 010).
 */
export const subjectWaits = (source: EventSource): boolean => source === "outside_program"

/** How many messages of one subject may wait before the next one is Skipped (spec 038). */
export const SUBJECT_WAITING_MAX = 3

/** The translation key of the words of each result. */
export const eventResultKey = (result: EventResult): string => `events.result.${result}`

/** The translation key of the words of each source. */
export const eventSourceKey = (source: EventSource): string => `events.source.${source}`

/** The line "Why" of an event as the user reads it (spec 038, "Why"). */
export const eventWhyText = (
  why: EventWhy,
  translate: (key: string, params?: Record<string, string>) => string,
): string => eventText(why, translate)

/** The reason of an event as the user reads it, or null when the row has none. */
export const eventReasonText = (
  reason: EventReason | null,
  translate: (key: string, params?: Record<string, string>) => string,
): string | null => (reason ? eventText(reason, translate) : null)

/** The label of a test event: it shows for 1 day, then leaves. */
export const testEventGone = (event: RobotEvent, now: number): boolean =>
  event.source === "test" && now - event.at > EVENT_TEST_MS
