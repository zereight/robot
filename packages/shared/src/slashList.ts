/** The list above the message box when the user types a slash (spec 003, flow 7; spec 017, flow 6). */

/** The commands of the message box. The word is what the user types after the slash. */
export const SLASH_COMMANDS = ["compact"] as const
export type SlashCommand = (typeof SLASH_COMMANDS)[number]

/** The list shows at most this many skills (spec 003). */
export const SLASH_SKILLS_MAX = 30

/** What the user typed after a first slash. Null when the text does not open the list. */
export const slashQuery = (text: string): string | null => {
  const typed = /^\/(\S*)$/.exec(text)
  return typed ? (typed[1] ?? "").toLocaleLowerCase() : null
}

/** The items whose name starts with the query, then those that hold it. The order inside stays. */
const narrow = <T>(items: readonly T[], name: (item: T) => string, query: string): T[] => {
  const key = (item: T) => name(item).toLocaleLowerCase()
  const starts = items.filter((item) => key(item).startsWith(query))
  const inside = items.filter((item) => !starts.includes(item) && key(item).includes(query))
  return [...starts, ...inside]
}

export type SlashItem<S extends { readonly name: string }> =
  | { readonly kind: "command"; readonly command: SlashCommand }
  | { readonly kind: "skill"; readonly skill: S }

/**
 * The items of the list for the text in the box: the commands first, then the skills that the user
 * saved for this agent, at most 30 of them. Empty when the text does not open the list.
 */
export const slashItems = <S extends { readonly name: string }>(
  text: string,
  skills: readonly S[],
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashItem<S>[] => {
  const query = slashQuery(text)
  if (query === null) return []
  return [
    ...narrow(commands, (command) => command, query).map(
      (command): SlashItem<S> => ({ kind: "command", command }),
    ),
    ...narrow(skills, (skill) => skill.name, query)
      .slice(0, SLASH_SKILLS_MAX)
      .map((skill): SlashItem<S> => ({ kind: "skill", skill })),
  ]
}
