// The `@` list of the message box of a direct chat (spec 003, "Mention another agent"). These
// functions hold the rules of the list. The computer and the phone draw it.

/** The list shows at most this many agents. */
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

/**
 * The agents of the list for a query: the names that start with the query, then the names that
 * hold it. The letter case does not count.
 */
export const mentionEntries = <T extends { readonly name: string }>(
  members: readonly T[],
  query: string,
): T[] => {
  const q = query.toLocaleLowerCase()
  const starts = members.filter((m) => m.name.toLocaleLowerCase().startsWith(q))
  const inside = members.filter(
    (m) => !starts.includes(m) && m.name.toLocaleLowerCase().includes(q),
  )
  return [...starts, ...inside].slice(0, MENTION_LIST_MAX)
}

/**
 * The names of `names` that the text mentions with `@Name`, in the order of `names`. A longer
 * name wins, so "@Ada Lovelace" is not also read as "@Ada". The letter case does not count.
 */
export const parseMentions = (text: string, names: readonly string[]): string[] => {
  const found = new Set<string>()
  let rest = text
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, "iu")
    if (pattern.test(rest)) {
      found.add(name)
      rest = rest.replace(pattern, "$1 ")
    }
  }
  return names.filter((n) => found.has(n))
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The other agents that a direct chat names with `@Name` (spec 003, "Mention another agent").
 * The chat's own agent, an archived agent and an unknown name are not mentions. `@all` is one
 * only when an agent has that name. The order is the order of `agents`.
 */
export const directMentions = <
  T extends { readonly id: string; readonly name: string; readonly archived: boolean },
>(
  agents: readonly T[],
  chatAgentId: string,
  text: string,
): T[] => {
  const open = agents.filter((agent) => !agent.archived && agent.id !== chatAgentId)
  const named = new Set(
    parseMentions(
      text,
      open.map((agent) => agent.name),
    ),
  )
  return open.filter((agent) => named.has(agent.name))
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
