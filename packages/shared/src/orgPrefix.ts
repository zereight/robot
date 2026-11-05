import { charLength, nameKey } from "./agents.ts"
import { orgLevels, orgParents, type TreeOrg } from "./orgTree.ts"

// The organization prefix "[Docs] Ada" (spec 036). These functions hold every rule of it: which
// organization an agent shows, the prefix text, the shown name, and the match of a search text
// against the organization name. The computer, a linked computer and the phone read them, so they
// cannot disagree. Nothing here is stored.

/** The prefix text holds at most this many characters of the organization name (spec 036). */
export const ORG_PREFIX_MAX = 16

/** What the deepest organization needs of an organization. */
export interface PrefixOrg extends TreeOrg {
  readonly name: string
  readonly memberIds: readonly string[]
}

/**
 * Picks the deepest organization of each agent that is a member of one of `orgs` (spec 030, "One
 * line"). The deepest organization is the one with the greatest depth in the tree as it is now; a
 * top organization has depth 1. Before the rule "One line" holds for all data, an agent can be in
 * organizations that are not on one line. A tie then goes to the first name, ignoring case, and
 * then to the lower id. With data that holds "One line", a tie never happens. This is the one
 * place that decides, so each place that shows a prefix gets the same organization.
 */
export const deepestOrgIndex = <O extends PrefixOrg>(orgs: readonly O[]): Map<string, O> => {
  const depth = orgLevels(orgParents(orgs))
  const depthOf = (o: O) => depth.get(o.id) ?? 1
  // Deeper first; then the first name; then the lower id.
  const before = (a: O, b: O) => {
    if (depthOf(a) !== depthOf(b)) return depthOf(a) > depthOf(b)
    const x = nameKey(a.name)
    const y = nameKey(b.name)
    if (x !== y) return x < y
    return a.id < b.id
  }
  const index = new Map<string, O>()
  for (const o of orgs) {
    for (const agentId of o.memberIds) {
      const best = index.get(agentId)
      if (best === undefined || before(o, best)) index.set(agentId, o)
    }
  }
  return index
}

/** The deepest organization of one agent, or null when the agent is in none. */
export const deepestOrg = <O extends PrefixOrg>(orgs: readonly O[], agentId: string): O | null =>
  deepestOrgIndex(orgs).get(agentId) ?? null

/** The first `ORG_PREFIX_MAX` characters of the name, and "…" when the name is longer. */
export const orgPrefixText = (organization: string): string =>
  charLength(organization) > ORG_PREFIX_MAX
    ? `${[...organization].slice(0, ORG_PREFIX_MAX).join("")}…`
    : organization

/** An agent name as the window shows it (spec 036, "Shown name"). */
export interface ShownName {
  /** The text "[<organization>]" with the cut name, or null when no prefix shows. */
  readonly prefix: string | null
  /** The whole name of the organization (the note on the prefix), or null. */
  readonly organization: string | null
  /** The stored name of the agent. */
  readonly name: string
  /** The prefix, one space and the name; the name alone when there is no prefix. */
  readonly text: string
  /** The accessible name: "<name>, <whole organization name>"; the name alone with no prefix. */
  readonly label: string
}

/**
 * The shown name of an agent. `organization` is the name of its deepest organization, or null.
 * `on` is the switch "Show the organization before an agent name" of the computer that shows the
 * name. Without an organization, or with the switch off, there is no prefix.
 */
export const shownName = (
  name: string,
  organization: string | null | undefined,
  on: boolean,
): ShownName => {
  if (!on || organization === null || organization === undefined || organization.trim() === "") {
    return { prefix: null, organization: null, name, text: name, label: name }
  }
  const prefix = `[${orgPrefixText(organization)}]`
  return {
    prefix,
    organization,
    name,
    text: `${prefix} ${name}`,
    label: `${name}, ${organization}`,
  }
}

/**
 * True when the typed text is a part of the whole organization name, ignoring case (spec 036,
 * "Search of places", "Mention"). The text that is cut in the prefix still counts. An empty text
 * matches nothing: a list that shows every entry for an empty text decides that itself.
 */
export const orgNameMatches = (organization: string | null | undefined, text: string): boolean => {
  const q = text.trim().toLocaleLowerCase()
  if (q === "" || !organization) return false
  return organization.toLocaleLowerCase().includes(q)
}
