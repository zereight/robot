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
