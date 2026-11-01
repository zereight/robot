export const MEMORY_TEXT_MAX = 500
/** The limits of what one turn may carry from memory. */
export const MEMORY_ITEMS_MAX = 20
export const MEMORY_CHARS_MAX = 4000
/** With this many items or fewer, all of them are always given. */
export const MEMORY_ALL_BELOW = 6

export interface MemoryItem {
  readonly id: string
  readonly agentId: string
  readonly text: string
  /** The user, or the agent that saved it. */
  readonly source: "user" | "agent"
  readonly createdAt: number
  readonly updatedAt: number
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
export const relevantMemory = (items: readonly MemoryItem[], message: string): MemoryItem[] => {
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
  const out: MemoryItem[] = []
  let chars = 0
  for (const { item } of scored) {
    if (out.length >= MEMORY_ITEMS_MAX || chars + item.text.length > MEMORY_CHARS_MAX) break
    out.push(item)
    chars += item.text.length
  }
  return out
}
