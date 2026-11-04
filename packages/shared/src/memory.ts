/** The longest text that the memory tool takes, for an item and for a proposal (spec 008). */
export const MEMORY_TEXT_MAX = 500
/** The longest item that the user types by hand. The tool takes less. */
export const MEMORY_USER_TEXT_MAX = MEMORY_TEXT_MAX * 2
/** The limits of what one turn may carry from memory. */
export const MEMORY_ITEMS_MAX = 20
export const MEMORY_CHARS_MAX = 4000
/** With this many items or fewer, all of them are always given. */
export const MEMORY_ALL_BELOW = 6
/** An agent has at most this many proposals. A new one replaces the oldest. */
export const MEMORY_PROPOSALS_MAX = 20
/** A proposal that nobody answers ends after this many days. */
export const MEMORY_PROPOSAL_DAYS = 30
/** The history of an agent keeps this many days and this many rows. The oldest go first. */
export const MEMORY_HISTORY_DAYS = 90
export const MEMORY_HISTORY_MAX = 1000
export const DAY_MS = 24 * 60 * 60 * 1000

/** "Save at once" (`now`) or "Ask me first" (`ask`): what the memory tool does for an agent. */
export const MEMORY_MODES = ["now", "ask"] as const
export type MemoryMode = (typeof MEMORY_MODES)[number]
export const DEFAULT_MEMORY_MODE: MemoryMode = "now"
export const isMemoryMode = (value: unknown): value is MemoryMode =>
  (MEMORY_MODES as readonly unknown[]).includes(value)

/** Where an item came from: the user, the agent's own save, or a proposal that the user accepted. */
export type MemorySource = "user" | "agent" | "proposal"

/**
 * The channel of a channel note (spec 008, "Channel notes"). `member` is false when the agent is
 * not a member of the channel now: the note is kept and is not read ("Not a member").
 */
export interface MemoryChannel {
  readonly id: string
  /** The name of the channel now, or null when the channel is gone. */
  readonly name: string | null
  readonly member: boolean
}

export interface MemoryItem {
  readonly id: string
  readonly agentId: string
  readonly text: string
  readonly source: MemorySource
  readonly createdAt: number
  readonly updatedAt: number
  /** The channel of a channel note, or null for a general item. */
  readonly channel: MemoryChannel | null
}

/** A channel with the notes of one agent, or that the agent is a member of (spec 008, flow 6). */
export interface MemoryScope {
  readonly id: string
  readonly name: string
  /** How many notes of the agent name this channel. */
  readonly notes: number
  /** True when the agent is a member now. A move goes only to such a channel. */
  readonly member: boolean
}

/** What the filter of the tab Items shows: all items, general items only, or one channel. */
export type MemoryFilter =
  | { readonly kind: "all" }
  | { readonly kind: "general" }
  | { readonly kind: "channel"; readonly id: string }

/** Where a proposal was made: the direct chat of the agent or a channel. */
export interface MemoryPlace {
  readonly kind: "agent" | "channel"
  readonly id: string
  /** The name of the chat now, or null when it is gone. */
  readonly name: string | null
}

/** A fact that an agent suggests. It is not memory, and the agent does not read it. */
export interface MemoryProposal {
  readonly id: string
  readonly agentId: string
  readonly text: string
  readonly createdAt: number
  readonly place: MemoryPlace | null
  /** The channel that the item will be a note of, with its name now, or null for a general item. */
  readonly channel: { readonly id: string; readonly name: string | null } | null
  /** True when a memory check made it (spec 008): the tab shows "From a memory check". */
  readonly fromCheck: boolean
}

/**
 * Who made a change: the user, the agent, a proposal that the user accepted, an undo, or the
 * delete of a channel (`channel_deleted`, spec 008).
 */
export type MemoryActor = "user" | "agent" | "proposal" | "undo" | "channel_deleted"
/** A move changes the channel of an item (spec 008, flow 6). */
export type MemoryChange = "added" | "edited" | "deleted" | "moved"

/** The channel of an item before or after a change. The name is the one at that time. */
export interface MemoryChannelRef {
  readonly id: string
  readonly name: string | null
}

/**
 * Whether Undo works on a row. It is off when the item is not as the change left it (`newer`),
 * and for a row whose text looks like a secret (`secret`, which shows no reason).
 */
export type MemoryUndo =
  | { readonly on: true }
  | { readonly on: false; readonly why: "newer" | "secret" | "channel_gone" }

export interface MemoryHistoryRow {
  readonly id: string
  readonly agentId: string
  readonly at: number
  readonly actor: MemoryActor
  readonly kind: MemoryChange
  /** The text before the change (edited, deleted), or null. "[redacted]" when it looks like a secret. */
  readonly before: string | null
  /** The text after the change (added, edited), or null. "[redacted]" when it looks like a secret. */
  readonly after: string | null
  readonly undo: MemoryUndo
  /** True when an undo took this change back and that undo still stands. */
  readonly undone: boolean
  /** The channel of the item before the change, or null for a general item (or an added item). */
  readonly channelBefore: MemoryChannelRef | null
  /** The channel of the item after the change, or null for a general item (or a deleted item). */
  readonly channelAfter: MemoryChannelRef | null
}

/** The line in the chat: what the memory tool did. It holds ids only, no text. */
export type MemoryNote =
  | { readonly kind: "saved"; readonly historyId: string }
  | { readonly kind: "suggested"; readonly proposalId: string }

/** What the memory tool did, for the agent and for the card. */
export type MemorySave =
  | { readonly kind: "saved"; readonly item: MemoryItem; readonly historyId: string }
  | { readonly kind: "suggested"; readonly proposal: MemoryProposal }
  /** The same fact is in the memory or among the proposals. */
  | { readonly kind: "known" }
  | { readonly kind: "empty" }
  | { readonly kind: "too_long" }
  | { readonly kind: "secret" }
  /** Memory is off for this agent. */
  | { readonly kind: "off" }
  /** The save names a channel, and the agent is not a member of it (or the channel is gone). */
  | { readonly kind: "not_member" }

/** The reason that a row shows when its Undo is off. */
export const MEMORY_UNDO_NEWER = "A newer change exists. Undo that one first."

/** Two texts are the same fact when they differ only in the spaces at the ends and in letter case. */
export const sameMemoryText = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/** What the rule for Undo needs to know about one history row and its item. */
export interface UndoFacts {
  readonly kind: MemoryChange
  /** The text that the change left (added, edited, moved). */
  readonly after: string | null
  /** The text of the item now, or null when the item is missing. */
  readonly itemText: string | null
  /** The channel that the change left, or null. */
  readonly afterChannel?: string | null
  /** The channel of the item now, or null. */
  readonly itemChannel?: string | null
  /** For a move: false when the channel that the item came from is gone. */
  readonly backExists?: boolean
  /** True when an undo already put back what a deletion took away. */
  readonly revived: boolean
  /** True when the text of the row looks like a secret. */
  readonly secret: boolean
}

/**
 * Undo is on only while the item is exactly as that change made it (spec 008). After an add or an
 * edit the item has the text that the change left. After a deletion the item is missing. Any
 * other state means a newer change exists. A row whose text looks like a secret has no Undo.
 */
export const memoryUndo = (f: UndoFacts): MemoryUndo => {
  if (f.secret) return { on: false, why: "secret" }
  if (f.kind === "deleted") return f.revived ? { on: false, why: "newer" } : { on: true }
  // The item must be as the change left it: the same text, and the same channel.
  if (
    f.itemText === null ||
    f.itemText !== f.after ||
    (f.itemChannel ?? null) !== (f.afterChannel ?? null)
  )
    return { on: false, why: "newer" }
  // A move goes back to the place it came from, so that place must still be there.
  if (f.kind === "moved" && f.backExists === false) return { on: false, why: "channel_gone" }
  return { on: true }
}

const words = (text: string) =>
  new Set(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => [...w].length >= 2),
  )

/**
 * Picks the items that relate to a message, by shared words, best first and newest first among
 * equals, within the item and size limits. A small memory is given whole.
 */
export const relevantMemory = <T extends Pick<MemoryItem, "text" | "createdAt">>(
  items: readonly T[],
  message: string,
): T[] => {
  const wanted = words(message)
  const scored = items
    .map((item) => {
      let score = 0
      // A word also matches when one is the start of the other: Korean particles follow nouns.
      for (const w of words(item.text))
        if ([...wanted].some((q) => q === w || q.startsWith(w) || w.startsWith(q))) score++
      return { item, score }
    })
    .filter((x) => items.length < MEMORY_ALL_BELOW || x.score > 0)
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
  const out: T[] = []
  let chars = 0
  for (const { item } of scored) {
    if (out.length >= MEMORY_ITEMS_MAX || chars + item.text.length > MEMORY_CHARS_MAX) break
    out.push(item)
    chars += item.text.length
  }
  return out
}
