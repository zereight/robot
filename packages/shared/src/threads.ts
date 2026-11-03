/**
 * Threads, the context meter and compact (spec 003). The rules here are pure, so that the main
 * process and the window use the same ones.
 */

import type { PlaceMarks } from "./placeMarks.ts"
import type { RecentPlace } from "./work.ts"

/** An agent has at most this many threads, the main thread included (spec 003, "Threads"). */
export const THREAD_MAX = 50
/** The title of a thread is the first line of its first message, at most this many characters. */
export const THREAD_TITLE_MAX = 60
/** At this share of the context or more, the app compacts before a turn (spec 003). */
export const COMPACT_AT = 0.85
/**
 * At this many tokens of use or more, the app also compacts before a turn, whatever the share
 * (spec 003). It comes first for a model with a context larger than about 470000 tokens.
 */
export const COMPACT_AT_TOKENS = 400_000
/** The newest turns that a compact keeps word for word. */
export const COMPACT_KEEP_TURNS = 2
/** After a failed automatic compact, the app waits this many ended turns before it tries again. */
export const COMPACT_PAUSE_TURNS = 5

/**
 * Why a thread cannot be archived or deleted now (spec 003): a turn runs, a task waits for the
 * user, a task waits in the queue, or messages wait in the message queue.
 */
export type ThreadBusy = "turn" | "waiting" | "queued" | "messages"

/** A thread of an agent other than the main thread. */
export interface ChatThread {
  readonly id: string
  readonly agentId: string
  /** Null until the first message: the window shows "New thread". */
  readonly title: string | null
  readonly createdAt: number
  readonly archivedAt: number | null
  /** The thread and the message where the fork was made. Null for a thread that is no fork. */
  readonly fork: { readonly threadId: string | null; readonly messageId: string } | null
  readonly unread: number
  readonly busy: ThreadBusy | null
  /** The marks that the thread holds: a thread is a place of its own (spec 007). */
  readonly marks: PlaceMarks
  /** The task of the thread that waits in the queue, and what it waits behind (spec 005). */
  readonly queued?: QueuedLine | null
}

/** The line of a queued task in its thread (spec 003, 005). */
export interface QueuedLine {
  readonly taskId: string
  readonly behind: RecentPlace | null
}

/** The threads of one agent, for the list in the chat header. */
export interface ChatThreads {
  readonly main: {
    readonly unread: number
    readonly busy: ThreadBusy | null
    readonly queued?: QueuedLine | null
  }
  /** Threads other than the main thread, the newest first. Archived threads too. */
  readonly threads: readonly ChatThread[]
}

/** Why Compact is off (spec 003). The window writes the words. */
export type CompactOff =
  | "size_unknown"
  | "self_compacts"
  | "agent_working"
  | "too_short"
  | "not_connected"
  | "linked"

/** The context meter of one thread, and the state of compact. */
export interface ChatMeter {
  /** Tokens of the context that the last reply used. Null when not known (after a compact). */
  readonly used: number | null
  /** The size of the context of the model. Null when not known. */
  readonly size: number | null
  /** Why Compact is off now, or null when the user can run it. */
  readonly off: CompactOff | null
  /** True while a compact of this thread runs: the working line reads "Compacting…". */
  readonly compacting: boolean
}

/** The title of a thread from the text of a message: its first line, or null when it is empty. */
export const threadTitle = (text: string): string | null => {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim()
  if (!line) return null
  return [...line].slice(0, THREAD_TITLE_MAX).join("")
}

/** True when a new thread can be made: the agent has fewer than 50 threads, main included. */
export const canAddThread = (otherThreads: number) => otherThreads + 1 < THREAD_MAX

/**
 * Where the newest kept turns start in the rows that the model reads after the last summary. A
 * turn starts at a message of the user that follows a reply, or at the first row. Rows before the
 * index go into the summary. Null when the conversation has 2 turns or fewer: nothing to compact.
 */
export const compactCut = (
  authors: readonly ("user" | "agent")[],
  keep = COMPACT_KEEP_TURNS,
): number | null => {
  const starts: number[] = []
  for (const [i, author] of authors.entries()) {
    if (i === 0 || (author === "user" && authors[i - 1] === "agent")) starts.push(i)
  }
  if (starts.length <= keep) return null
  return starts[starts.length - keep] ?? null
}

/** The share of the context that is used, from 0 to 1, or null when it is not known. */
export const meterShare = (used: number | null, size: number | null): number | null =>
  used === null || size === null || size <= 0 ? null : Math.min(1, used / size)

/**
 * True when a use of the context is so high that the app compacts before the next turn (spec 003):
 * the size and the use are known, and the use is 85 percent or more, or 400000 tokens or more.
 */
export const compactDue = (used: number | null, size: number | null): boolean => {
  const share = meterShare(used, size)
  if (share === null || used === null) return false
  return share >= COMPACT_AT || used >= COMPACT_AT_TOKENS
}

/**
 * True when the app compacts before a turn (spec 003, "Automatic compact"): the setting is on, the
 * provider does not compact by itself, the use is due for a compact (see `compactDue`), and no
 * pause of 5 turns holds.
 */
export const shouldAutoCompact = (input: {
  readonly setting: boolean
  readonly selfCompacts: boolean
  readonly used: number | null
  readonly size: number | null
  readonly pause: number
}): boolean => {
  if (!input.setting || input.selfCompacts || input.pause > 0) return false
  return compactDue(input.used, input.size)
}

/**
 * The pause after a turn ends (spec 003): a failed compact, or a first reply after a compact that
 * reports a use that is due for a compact again, sets 5 turns. Each other ended turn takes one off.
 */
export const nextPause = (
  pause: number,
  event: "turn" | "compact_failed" | "full_after_compact",
): number => (event === "turn" ? Math.max(0, pause - 1) : COMPACT_PAUSE_TURNS)
