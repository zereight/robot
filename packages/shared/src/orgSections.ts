import { nameKey } from "./agents.ts"
import type { Place } from "./ui.ts"

// The view "By organization" of Agents (spec 001, "Agents by organization"). This one rule makes the
// sections, so the window and its tests cannot disagree. Nothing here is stored: the sections come
// from the organizations as they are now.

/** The collapse key of the section "No organization". */
export const NO_ORG_SECTION_ID = "no-org:agents"

/** The collapse key of the section of one organization. It is not the id of a user section. */
export const orgSectionKey = (organizationId: string) => `org:${organizationId}`

/** A section of the view "By organization": the agents whose deepest organization is one. */
export interface OrgSectionView {
  /** The collapse key (`orgSectionKey`). */
  readonly id: string
  /** The name of the organization. Text of the user. It is not translated. */
  readonly name: string
  readonly places: readonly Place[]
}

export interface OrganizationSections {
  /** In the order of the names, ignoring case, and then of the ids. No section is empty. */
  readonly sections: readonly OrgSectionView[]
  /** The agents that are in no organization: the section "No organization". */
  readonly none: readonly Place[]
}

/**
 * Puts each agent in the section of its deepest organization (spec 036). `deepestOf` gives that
 * organization, or nothing for an agent in none. The agents of a section keep the order they came
 * in. An organization that is the deepest of no agent has no section.
 */
export const organizationSections = (
  agents: readonly Place[],
  deepestOf: (agentId: string) => { readonly id: string; readonly name: string } | null | undefined,
): OrganizationSections => {
  const found = new Map<string, { id: string; name: string; places: Place[] }>()
  const none: Place[] = []
  for (const agent of agents) {
    const organization = deepestOf(agent.id)
    if (!organization) {
      none.push(agent)
      continue
    }
    const section = found.get(organization.id) ?? {
      id: organization.id,
      name: organization.name,
      places: [],
    }
    section.places.push(agent)
    found.set(organization.id, section)
  }
  const sections = [...found.values()]
    .sort((a, b) => {
      const x = nameKey(a.name)
      const y = nameKey(b.name)
      return x === y ? (a.id < b.id ? -1 : 1) : x < y ? -1 : 1
    })
    .map((s): OrgSectionView => ({ id: orgSectionKey(s.id), name: s.name, places: s.places }))
  return { sections, none }
}
