import type { Turn } from "../providers/chat.ts"

const NEWEST_MAX = 100_000

/**
 * One text for a vendor program: the chat so far, then the new message. A vendor program keeps
 * no session between turns, so the app hands it the history. The oldest lines go first when the
 * history is too long.
 */
export const buildPrompt = (turns: readonly Turn[], historyMax = 60_000): string => {
  const texts = turns.filter((t) => t.role !== "tool" && t.content.trim() !== "")
  const last = texts.at(-1)
  if (!last) return "(no text)"
  const earlier = texts.slice(0, -1)
  if (last.role !== "user") return earlier.length === 0 ? last.content : buildPrompt(earlier)
  const newest = last.content.slice(0, NEWEST_MAX)
  if (earlier.length === 0) return newest
  const lines = earlier.map((t) => `${t.role === "user" ? "User" : "You"}: ${t.content.trim()}`)
  let history = lines.join("\n\n")
  if (history.length > historyMax) history = `…${history.slice(history.length - historyMax)}`
  return `The chat so far:\n\n${history}\n\n---\nThe new message of the user:\n\n${newest}`
}

/**
 * A block of a message count that the cut of an old history moves in one step. The cut does not
 * move at each message, so the start of the text stays the same for several turns.
 */
const CUT_STEP = 8

const LEAD =
  'The chat so far follows, with one block for each message. A block that starts with "User:" is a message of the user. A block that starts with "You:" is an earlier reply of yours. Answer the last message of the user.'

const OMITTED = "(The oldest messages of this chat are left out here.)"

/**
 * The chat for a program that takes it as blocks, one block for each message. The model reads a
 * start of the request from its cache when that start is the same as in the turn before. A block
 * is the unit of that match, so a message that is its own block, with the same text in each turn,
 * is read from the cache. The text of one block that grows or changes in the middle is not.
 *
 * The blocks of one turn are the blocks of the turn before, with the new ones at the end. Only
 * the cut of an old history moves them, and it moves in steps of {@link CUT_STEP} blocks.
 */
export const buildBlocks = (turns: readonly Turn[], historyMax = 60_000): string[] => {
  const texts = turns.filter((t) => t.role !== "tool" && t.content.trim() !== "")
  // The program answers the last message of the user, as in buildPrompt.
  let end = texts.length
  while (end > 0 && texts[end - 1]?.role !== "user") end--
  if (end === 0) return [texts.at(-1)?.content ?? "(no text)"]
  const items = texts.slice(0, end).map((t, i) => {
    const body = t.content.trim()
    return `${t.role === "user" ? "User" : "You"}: ${i === end - 1 ? body.slice(0, NEWEST_MAX) : body}`
  })
  let start = items.length - 1
  let size = items[start]?.length ?? 0
  while (start > 0 && size + (items[start - 1]?.length ?? 0) + 2 <= historyMax) {
    start--
    size += (items[start]?.length ?? 0) + 2
  }
  const cut = start === 0 ? 0 : Math.min(Math.ceil(start / CUT_STEP) * CUT_STEP, items.length - 1)
  return [LEAD, ...(cut > 0 ? [OMITTED] : []), ...items.slice(cut)]
}
