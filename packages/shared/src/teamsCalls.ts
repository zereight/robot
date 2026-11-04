import { type TeamsFields, teamsNameKey } from "./teamsLink.ts"

// Calls from Teams (spec 028, S102): the pure rules of "Who may call", the call text, the read set
// of a chat and the limit of calls. Nothing here touches a page, a clock or a database.

/** More than this long between two finished reads makes the next read a baseline read. */
export const TEAMS_GAP_MS = 2 * 60_000
/** At most this many calls start work in one window. */
export const TEAMS_CALLS_MAX = 10
export const TEAMS_CALLS_WINDOW_MS = 60_000
/** The name of a sender is stored with the message, cut at this many characters. */
export const TEAMS_SENDER_MAX = 100

/** The name of the sender as a message stores it: spaces at both ends removed, and cut. */
export const senderOfMessage = (name: string): string =>
  [...name.trim().replace(/\s+/g, " ")].slice(0, TEAMS_SENDER_MAX).join("")

/** The read set keeps at most this many message keys. The oldest keys go first. */
export const TEAMS_READ_SET_MAX = 5000

/** One message of the Teams chat, as the page shows it. */
export interface TeamsMessage {
  /** The identity that the page gives to the message, or null when the page gives none. */
  readonly id: string | null
  /** The name of the sender as the page shows it. Empty when the page shows none. */
  readonly sender: string
  /** The text. Empty for a file, a picture or a card alone. */
  readonly text: string
  /** The time that the page gives, in ms, or null. */
  readonly time: number | null
  /** The page marks the message as written by the user of this account. */
  readonly own: boolean
}

/** The open chat of the page and its messages, oldest first, in the order that the chat shows. */
export interface TeamsChatRead {
  readonly openTitle: string | null
  readonly messages: readonly TeamsMessage[]
}

// --- Who may call ------------------------------------------------------------------------------

/** Why a message gets no answer. The link log holds this word and nothing else of the message. */
export const CALL_REFUSALS = [
  "own_text",
  "no_text",
  "no_sender",
  "bot",
  "not_allowed",
  "no_call",
  "nothing_left",
] as const
export type CallRefusal = (typeof CALL_REFUSALS)[number]

export type CallCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: CallRefusal }

/** The fields of the link that "Who may call" reads. They come from the link and nowhere else. */
export type CallRules = Pick<TeamsFields, "allow" | "bots" | "callText" | "chatKind" | "marker">

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The text with its first call text taken out, or null when the text holds none. Letter case is
 * ignored. The spaces at the ends go, and the two sides of the cut join with one space.
 */
export const takeOutCall = (text: string, callText: string): string | null => {
  const call = callText.trim()
  if (call === "") return null
  const found = new RegExp(escapeRegex(call), "iu").exec(text)
  if (!found) return null
  const before = text.slice(0, found.index).trimEnd()
  const after = text.slice(found.index + found[0].length).trimStart()
  return before !== "" && after !== "" ? `${before} ${after}` : `${before}${after}`
}

/**
 * Applies "Who may call" (spec 028) to one message. The six checks run in the order of the spec, and
 * the first that fails gives the reason. When all pass, `text` is what the agent gets: the text with
 * the first call text taken out.
 */
export const checkCall = (message: TeamsMessage, rules: CallRules): CallCheck => {
  // 1. The app never reads its own text.
  const marker = rules.marker.trim()
  if (marker !== "" && message.text.trimStart().startsWith(marker))
    return { ok: false, reason: "own_text" }
  // 2. A file, a picture or a card alone has no text.
  if (message.text.trim() === "") return { ok: false, reason: "no_text" }
  // 3. The sender has a name.
  const sender = teamsNameKey(message.sender)
  if (sender === "") return { ok: false, reason: "no_sender" }
  // 4. The name is on the allow list and not on the bot list. The bot list wins.
  if (rules.bots.some((name) => teamsNameKey(name) === sender)) return { ok: false, reason: "bot" }
  if (!rules.allow.some((name) => teamsNameKey(name) === sender))
    return { ok: false, reason: "not_allowed" }
  // 5. The message calls the app. With no call text, every message of a chat with one person does.
  const call = rules.callText.trim()
  if (call === "") {
    if (rules.chatKind !== "person") return { ok: false, reason: "no_call" }
    return { ok: true, text: message.text.trim() }
  }
  const left = takeOutCall(message.text, call)
  if (left === null) return { ok: false, reason: "no_call" }
  // 6. Some text is left after the first call text goes.
  return left.trim() === ""
    ? { ok: false, reason: "nothing_left" }
    : { ok: true, text: left.trim() }
}

// --- Read once ---------------------------------------------------------------------------------

/**
 * The keys of the messages that the app has read. A message is read once: an edit, a reload and a
 * delete after the read start nothing.
 *
 * The key is the identity that the page gives. A page that gives none is keyed by the sender, the
 * time and the place among the messages with the same sender and time, so that two messages with
 * the same text, sender and time are two messages, and an edit does not make a new one.
 */
export interface ReadSet {
  readonly keys: Set<string>
}

export const newReadSet = (): ReadSet => ({ keys: new Set() })

/** The key of each message of a list, in the order of the list. */
export const messageKeys = (list: readonly TeamsMessage[]): string[] => {
  const places = new Map<string, number>()
  return list.map((m) => {
    if (m.id !== null && m.id !== "") return `id:${m.id}`
    const base = `${teamsNameKey(m.sender)}|${m.time ?? ""}`
    const n = places.get(base) ?? 0
    places.set(base, n + 1)
    return `at:${base}|${n}`
  })
}

const remember = (set: ReadSet, keys: readonly string[]) => {
  for (const key of keys) set.keys.add(key)
  // A Set keeps the order of insertion, so the first key is the oldest.
  while (set.keys.size > TEAMS_READ_SET_MAX) {
    const oldest = set.keys.values().next().value
    if (oldest === undefined) break
    set.keys.delete(oldest)
  }
}

/** A baseline read: every message now in the chat counts as read. Nothing is answered. */
export const markAllRead = (set: ReadSet, list: readonly TeamsMessage[]): void =>
  remember(set, messageKeys(list))

/** The messages that the app has not read, in the order of the list. They count as read now. */
export const takeUnread = (set: ReadSet, list: readonly TeamsMessage[]): TeamsMessage[] => {
  const keys = messageKeys(list)
  const fresh = list.filter((_, i) => !set.keys.has(keys[i] as string))
  remember(set, keys)
  return fresh
}

// --- The gap and the limit ---------------------------------------------------------------------

/**
 * True when more than 2 minutes passed between two finished reads (spec 028, "Starts and gaps"):
 * the computer slept, or the page could not be read. The next read is a baseline read.
 */
export const readGap = (lastFinishedAt: number | null, now: number): boolean =>
  lastFinishedAt !== null && now - lastFinishedAt > TEAMS_GAP_MS

/** The starts of work that still count in the window of one minute. */
export const recentCalls = (starts: readonly number[], now: number): number[] =>
  starts.filter((at) => now - at < TEAMS_CALLS_WINDOW_MS && at <= now)

/** True when one more call may start work now: fewer than 10 started in the last minute. */
export const callMayStart = (starts: readonly number[], now: number): boolean =>
  recentCalls(starts, now).length < TEAMS_CALLS_MAX

// --- The link log ------------------------------------------------------------------------------

/**
 * The events of the link log (spec 014): the time, the event, the reason and the place. A record
 * holds no text of a message and no name of a sender.
 */
export const TEAMS_LOG_EVENTS = [
  "baseline",
  "call_started",
  "call_refused",
  "call_over_limit",
  "queue_full",
  "target_failed",
  "gap_skipped_call",
] as const
export type TeamsLogEvent = (typeof TEAMS_LOG_EVENTS)[number]

/** Why a baseline read ran. */
export const BASELINE_REASONS = ["start", "signed_out", "offline", "gap"] as const
export type BaselineReason = (typeof BASELINE_REASONS)[number]
