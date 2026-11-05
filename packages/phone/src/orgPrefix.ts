import { deepestOrgIndex, type PrefixOrg, type ShownName, shownName } from "@robot/shared"

// The organization prefix on the phone (spec 035, 011). The phone reads the organizations of a
// server (a read needs the link only), keeps the whole name of the deepest organization of each
// agent in its cache, and draws "[Docs] Ada" from it. The rule that picks the organization is the
// one of the computer (`deepestOrgIndex`), so both show the same prefix.

/** The whole name of the deepest organization, by agent id. An agent in none has no entry. */
export type AgentOrgs = Readonly<Record<string, string>>

const isOrg = (value: unknown): value is PrefixOrg => {
  if (typeof value !== "object" || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    (o.parentId === null || typeof o.parentId === "string") &&
    Array.isArray(o.memberIds)
  )
}

/**
 * The names for the cache, from the answer of "organizations.list". An answer that is not a list
 * (a server of an older step answers "Not allowed") gives null, and the phone keeps what it has.
 * An entry that does not read is skipped.
 */
export const agentOrgNames = (answer: unknown): AgentOrgs | null => {
  if (!Array.isArray(answer)) return null
  const orgs = answer.filter(isOrg).map((o) => ({
    ...o,
    memberIds: o.memberIds.filter((m): m is string => typeof m === "string"),
  }))
  const names: Record<string, string> = {}
  for (const [agentId, org] of deepestOrgIndex(orgs)) names[agentId] = org.name
  return names
}

/** The shown name of an agent. `on` is the switch of this phone. */
export const phoneShownName = (
  orgs: AgentOrgs | null | undefined,
  on: boolean,
  agentId: string,
  name: string,
): ShownName => shownName(name, orgs && Object.hasOwn(orgs, agentId) ? orgs[agentId] : null, on)
