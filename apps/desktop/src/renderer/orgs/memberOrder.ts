/**
 * The order of the field "Members" (spec 030): one list by name, ignoring case. An archived member
 * stands in its place by name, not after the others. A name that is the same keeps its order.
 */
export const byMemberName = <T extends { readonly agent: { readonly name: string } }>(
  choices: readonly T[],
): T[] =>
  [...choices].sort((a, b) =>
    a.agent.name.localeCompare(b.agent.name, undefined, { sensitivity: "base" }),
  )
