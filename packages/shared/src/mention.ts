import { EVERYONE_MENTION } from "./channels.ts"

// The `@` list of the message box of a channel (spec 004, "Mention"). These functions hold the
// rules of the list. The computer and the phone draw it.

/** The list shows at most this many members, and `@all` as one more line. */
export const MENTION_LIST_MAX = 30

export interface OpenMention {
  /** The place of the `@` in the text. */
  readonly start: number
  /** The letters between the `@` and the caret. */
  readonly query: string
}

/**
 * The mention that the caret ends, or null. A mention starts at an `@` that opens the text or
 * follows a space or a line break, so an address such as `a@b.com` is plain text. The query holds
 * no space, so the list closes when the user types a space.
 */
export const openMention = (text: string, caret: number): OpenMention | null => {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf("@")
  if (start < 0) return null
  if (start > 0 && !/\s/u.test(before.charAt(start - 1))) return null
  const query = before.slice(start + 1)
  if (/\s/u.test(query)) return null
  return { start, query }
}

/** One line of the list: a member, or the everyone mention `@all`. */
export type MentionEntry<T> =
  | { readonly kind: "member"; readonly member: T }
  | { readonly kind: "all" }

/**
 * The lines of the list for a query. The members come first, in the order of the channel: the
 * names that start with the query, then the names that hold it. The letter case does not count.
 * `@all` is in the list when `withAll` holds and the query starts the word "all". It is the last
 * line, so that a bare `@` and Enter never call every member by chance. When the query is the
 * whole word, it is the first line.
 */
export const mentionEntries = <T extends { readonly name: string }>(
  members: readonly T[],
  query: string,
  withAll: boolean,
): MentionEntry<T>[] => {
  const q = query.toLocaleLowerCase()
  const starts = members.filter((m) => m.name.toLocaleLowerCase().startsWith(q))
  const inside = members.filter(
    (m) => !starts.includes(m) && m.name.toLocaleLowerCase().includes(q),
  )
  const lines: MentionEntry<T>[] = [...starts, ...inside]
    .slice(0, MENTION_LIST_MAX)
    .map((member) => ({ kind: "member", member }))
  if (!withAll || !EVERYONE_MENTION.startsWith(q)) return lines
  return q === EVERYONE_MENTION ? [{ kind: "all" }, ...lines] : [...lines, { kind: "all" }]
}

/**
 * Puts `@Name` in the place of the open mention, with one space after it, and gives the new text
 * and the place of the caret. A space that already follows the caret is not doubled.
 */
export const insertMention = (
  text: string,
  mention: OpenMention,
  caret: number,
  name: string,
): { readonly text: string; readonly caret: number } => {
  const tail = text.slice(caret)
  const spaced = tail.startsWith(" ")
  const head = `${text.slice(0, mention.start)}@${name}${spaced ? "" : " "}`
  return { text: `${head}${tail}`, caret: head.length + (spaced ? 1 : 0) }
}
