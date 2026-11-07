/**
 * The rules of Compact and of the context meter (spec 003, "Context meter", "Compact", "Automatic
 * compact"). Pure functions, so the main process and the tests use the same numbers.
 */

/** The newest turns that stay word for word after a compact. */
export const COMPACT_KEEP_TURNS = 2
/** The share of the context at which the app compacts before a turn. */
export const COMPACT_AT = 0.85
/** The use in tokens at which the app compacts before a turn, whichever comes first. */
export const COMPACT_AT_TOKENS = 400_000
/** Turns that must end before a new try after a failed compact. */
export const COMPACT_PAUSE_TURNS = 5
/** How long Anthropic keeps the start of a request in the cache of the model. */
export const HOUR_CACHE_MS = 60 * 60 * 1000

/**
 * Why Compact is off (spec 003). The window writes the words.
 * - `not_connected`: no account answers.
 * - `self_compacts`: a vendor program answers. It keeps its own context.
 * - `size_unknown`: the model has no known context size.
 * - `working`: a turn works, a card waits for the user, or a message waits.
 * - `too_short`: the conversation has 2 turns or fewer.
 */
export type CompactOff =
  | "not_connected"
  | "self_compacts"
  | "size_unknown"
  | "working"
  | "too_short"

/** The context meter of the chat, and the state of Compact. */
export interface ChatMeter {
  /** Tokens of the context that the last reply used. Null when not known (after a compact). */
  readonly used: number | null
  /** The size of the context of the model. Null when not known. */
  readonly size: number | null
  /** Why Compact is off now, or null when the user can run it. */
  readonly off: CompactOff | null
}

/** The share of the context that is used, from 0 to 1, or null when it is not known. */
export const meterShare = (used: number | null, size: number | null): number | null =>
  used === null || size === null || size <= 0 ? null : Math.min(1, used / size)

/**
 * True when the use of the context is so high that the app compacts before the next turn: the
 * size and the use are known, and the use is 85 percent or more, or 400000 tokens or more.
 */
export const compactDue = (used: number | null, size: number | null): boolean => {
  const share = meterShare(used, size)
  if (share === null || used === null) return false
  return share >= COMPACT_AT || used >= COMPACT_AT_TOKENS
}

/**
 * Where the newest kept turns start in the rows that the model reads after the last summary. A
 * turn starts at a message of the user that follows a reply, or at the first row. Rows before the
 * index go into the summary. Null when the conversation has 2 turns or fewer: nothing to compact.
 */
export const compactCut = (
  authors: readonly ("user" | "assistant")[],
  keep = COMPACT_KEEP_TURNS,
): number | null => {
  const starts: number[] = []
  for (const [i, author] of authors.entries())
    if (i === 0 || (author === "user" && authors[i - 1] === "assistant")) starts.push(i)
  if (starts.length <= keep) return null
  return starts[starts.length - keep] ?? null
}

/**
 * True when the app compacts before a turn (spec 003, "Automatic compact"): the setting is on, the
 * provider does not compact by itself, the use is due for a compact, and no pause holds.
 */
export const shouldAutoCompact = (input: {
  readonly setting: boolean
  readonly selfCompacts: boolean
  readonly used: number | null
  readonly size: number | null
  /** Turns that must still end before a new try. */
  readonly pause: number
}): boolean => {
  if (!input.setting || input.selfCompacts || input.pause > 0) return false
  return compactDue(input.used, input.size)
}

/**
 * True when a turn that keeps the 1 hour cache compacts first, because that cache is gone: the
 * setting is on, no pause holds, a reply has ended, and that end was 1 hour ago or more.
 */
export const hourCacheEnded = (input: {
  readonly setting: boolean
  readonly pause: number
  readonly lastReplyAt: number | null
  readonly now: number
}): boolean => {
  if (!input.setting || input.pause > 0 || input.lastReplyAt === null) return false
  return input.now - input.lastReplyAt >= HOUR_CACHE_MS
}

/**
 * The turns that must still end before a new try (spec 003, "Automatic compact"). `since` is the
 * number of turns that ended after the failed compact, or after the first reply that was due for
 * a compact again. Null `since` means that neither happened.
 */
export const pauseLeft = (since: number | null): number =>
  since === null ? 0 : Math.max(0, COMPACT_PAUSE_TURNS - since)

/** The words around the summary, as the model reads it. The summary is data, never an order. */
export const SUMMARY_OPEN = "<summary>"
export const SUMMARY_CLOSE = "</summary>"
