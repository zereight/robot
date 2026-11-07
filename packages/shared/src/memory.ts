// The memory of a workflow (spec 008): the items, the history, the choices of the memory page and the
// limits. The rules are here as constants and pure functions, so the main process and the window
// read the same ones. A point that the specs call open is not decided here
// (docs/spec-questions.md, rows of W2 for 008).

/** The memory tool takes a text of at most this many characters, for an item and for a proposal. */
export const MEMORY_TOOL_MAX = 500
/**
 * The text that the user types or edits by hand. 008 says the user "can type longer items by hand"
 * and names no number; docs/spec-questions.md (008, row on the typed text) gives 1000.
 */
export const MEMORY_USER_MAX = 1000
/** The history keeps 90 days and at most 1000 rows for each workflow (spec 008, "Rules"). */
export const MEMORY_HISTORY_DAYS = 90
export const MEMORY_HISTORY_ROWS = 1000
/**
 * What a search of the memory tool gives back. 008 says "up to a limit set by the size of the
 * context of the model" and names no number; the earlier rule of docs/spec-questions.md (008, row
 * on the choice of items) is kept: at most 20 items and 4000 characters, and every item when the
 * memory holds fewer than 6.
 */
export const MEMORY_READ_ITEMS = 20
export const MEMORY_READ_CHARS = 4000
export const MEMORY_READ_ALL_BELOW = 6

/** "Memory saving": "Ask me first" is the default, "Save at once" is the choice of the user. */
export const MEMORY_MODES = ["ask", "now"] as const
export type MemoryMode = (typeof MEMORY_MODES)[number]

/** Where an item came from (spec 008, "Memory item"). */
export const MEMORY_SOURCES = ["user", "node", "proposal"] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

/** Who made a change of the history: the user, a node, a proposal that the user accepted, or an undo. */
export const MEMORY_ACTORS = ["user", "node", "proposal", "undo"] as const
export type MemoryActor = (typeof MEMORY_ACTORS)[number]

export const MEMORY_KINDS = ["added", "edited", "deleted"] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export interface MemoryItem {
  readonly id: string
  readonly text: string
  readonly source: MemorySource
  readonly createdAt: number
  readonly updatedAt: number
}

export interface MemoryHistoryRow {
  readonly id: string
  readonly memoryId: string
  readonly at: number
  readonly actor: MemoryActor
  readonly kind: MemoryKind
  readonly source: MemorySource
  /** The text before and after. Both are null for a row whose text looks like a secret. */
  readonly oldText: string | null
  readonly newText: string | null
  /** True when the text looks like a secret: the window shows "[redacted]" and no Undo. */
  readonly redacted: boolean
  /** The row that this row undid, when it is an undo. */
  readonly undoOf: string | null
  /** The row that undid this one. */
  readonly undoneBy: string | null
  /** Undo is on only while the item is exactly as this change made it (spec 008, "Flows", 4). */
  readonly canUndo: boolean
  /** Why Undo is off: `newer` is "A newer change exists. Undo that one first." */
  readonly undoBlocked: "newer" | "redacted" | "undone" | null
}

/** The memory page of a workflow: the choices above the tabs, and the items (spec 008). */
export interface MemoryState {
  readonly workflowId: string
  /** Memory is on or off for the workflow. Off keeps the items and uses none. */
  readonly enabled: boolean
  readonly mode: MemoryMode
  /** The switch "Self-improvement" of the workflow (spec 002). */
  readonly selfImprovement: boolean
  /** The items, newest first, filtered by the search. */
  readonly items: readonly MemoryItem[]
  /** The proposals of the kind "Memory item" that wait: the link "Proposals (N)". */
  readonly proposals: number
}

/** The key that decides whether a fact is known: spaces at both ends and case do not matter. */
export const factKey = (text: string): string => text.trim().normalize("NFC").toLocaleLowerCase()

/** The words of a search: split at white space, case does not matter. */
export const searchWords = (query: string): string[] =>
  query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")

/** A text matches a search when it holds every word, as part of a word (spec 001, message search). */
export const matchesWords = (text: string, words: readonly string[]): boolean => {
  const low = text.toLocaleLowerCase()
  return words.every((w) => low.includes(w))
}

/**
 * The items that a search of the memory tool gives back, newest first: every item when the memory
 * holds fewer than 6, else the items that share a word with the query. No query gives the newest
 * items. The result stays inside the limits of the tool.
 */
export const selectForRead = <T extends { readonly text: string }>(
  items: readonly T[],
  query: string,
): { items: T[]; more: boolean } => {
  const words = searchWords(query).filter((w) => [...w].length > 1)
  const pool =
    items.length < MEMORY_READ_ALL_BELOW || words.length === 0
      ? [...items]
      : items.filter((i) => {
          const low = i.text.toLocaleLowerCase()
          return words.some((w) => low.includes(w))
        })
  const out: T[] = []
  let chars = 0
  for (const item of pool) {
    const size = [...item.text].length
    if (out.length >= MEMORY_READ_ITEMS || (out.length > 0 && chars + size > MEMORY_READ_CHARS))
      return { items: out, more: true }
    out.push(item)
    chars += size
  }
  return { items: out, more: false }
}
