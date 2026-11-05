import { nameKey } from "./agents.ts"
import { orgParents, type TreeOrg } from "./orgTree.ts"

// One line (spec 030, "One line"). An agent is a member of more than one organization only when
// all of them are on one line: of each two, one is a higher organization of the other. These are
// plain functions, so the service, the form, the menus and the drags of the chart (029), a linked
// computer (012) and the phone read the same rules. They read members, never the archive state:
// an agent that is archived stays a member, and it counts.

/** What the rules need of an organization. */
export interface OneLineOrg extends TreeOrg {
  readonly name: string
  readonly memberIds: readonly string[]
}

/** What the rules need of an agent: the name decides which agent and which pair come first. */
export interface OneLineAgent {
  readonly id: string
  readonly name: string
}

/**
 * One change to an organization, as a check reads it. A field that is absent stays as it is. An
 * organization that is not in the list is a new one: it has the `name` (for the order only), the
 * parent and the members of the change.
 */
export interface OrgLineChange {
  readonly id: string
  readonly name?: string
  readonly parentId?: string | null
  readonly memberIds?: readonly string[]
}

/** Why the check refuses (the data of the two long lines of spec 030, "One line"). */
export type LineRefusal =
  /** "<agent> is in <other>, which is not on one line with <organization>." */
  | {
      readonly kind: "member"
      readonly agentId: string
      readonly orgId: string
      readonly otherId: string
    }
  /** "<agent> is in <A> and <B>, which would not be on one line." */
  | {
      readonly kind: "parent"
      readonly agentId: string
      readonly aId: string
      readonly bId: string
    }

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The order of names, ignoring case. A tie goes by id. */
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  nameKey(a.name).localeCompare(nameKey(b.name)) || compareText(a.id, b.id)

/** A test of two organizations in the tree as it is read now (a loop or a missing parent counts as none). */
const lineTest = (orgs: readonly TreeOrg[]) => {
  const parents = orgParents(orgs)
  const above = new Map<string, Set<string>>()
  const higher = (id: string): Set<string> => {
    const known = above.get(id)
    if (known) return known
    const out = new Set<string>()
    for (
      let at = parents.get(id) ?? null;
      at !== null && !out.has(at);
      at = parents.get(at) ?? null
    )
      out.add(at)
    above.set(id, out)
    return out
  }
  return (a: string, b: string) => a === b || higher(a).has(b) || higher(b).has(a)
}

/** Whether two organizations are on one line: one is a higher organization of the other. */
export const onOneLine = (orgs: readonly TreeOrg[], a: string, b: string): boolean =>
  lineTest(orgs)(a, b)

/** Whether each two of the organizations are on one line. */
export const orgsOnOneLine = (orgs: readonly TreeOrg[], ids: readonly string[]): boolean => {
  const test = lineTest(orgs)
  return ids.every((a, i) => ids.slice(i + 1).every((b) => test(a, b)))
}

/** The organizations as they would be after the changes. */
const applied = (orgs: readonly OneLineOrg[], changes: readonly OrgLineChange[]): OneLineOrg[] => {
  const out = new Map(orgs.map((o) => [o.id, o] as const))
  for (const change of changes) {
    const was = out.get(change.id)
    out.set(change.id, {
      id: change.id,
      name: was?.name ?? change.name ?? "",
      parentId: change.parentId !== undefined ? change.parentId : (was?.parentId ?? null),
      memberIds: change.memberIds ?? was?.memberIds ?? [],
    })
  }
  return [...out.values()]
}

/**
 * Why the changes break a line, or undefined when they keep it (spec 030, "One line", "The check").
 * The changes are one change: a save of the form with all its fields, or a move (the agent has
 * left the source organization before the add is checked).
 *
 * 1. An agent that is a new member of an organization must be on one line with each other
 *    organization of the agent. The first agent in the order of names is named, with the first
 *    conflicting organization in the order of names.
 * 2. A new place in the tree must not put the organizations of an agent off one line. The first
 *    agent and the first pair of its organizations in the order of names are named. A pair that
 *    was off the line before is not named: a repair removes it (S122b), a new change does not
 *    cause it. A removal is never refused.
 */
export const orgLineRefusal = (
  orgs: readonly OneLineOrg[],
  agents: readonly OneLineAgent[],
  changes: readonly OrgLineChange[],
): LineRefusal | undefined => {
  const after = applied(orgs, changes)
  const was = lineTest(orgs)
  const now = lineTest(after)
  const sorted = [...agents].sort(byName)
  const oldMembers = new Map(orgs.map((o) => [o.id, new Set(o.memberIds)] as const))
  const byNameOrgs = [...after].sort(byName)
  const added = (orgId: string, agentId: string) =>
    (after.find((o) => o.id === orgId)?.memberIds.includes(agentId) ?? false) &&
    !oldMembers.get(orgId)?.has(agentId)
  const targets = changes
    .filter((c) => c.memberIds !== undefined)
    .map((c) => after.find((o) => o.id === c.id) as OneLineOrg)
    .sort(byName)

  for (const agent of sorted) {
    for (const target of targets) {
      if (!added(target.id, agent.id)) continue
      const other = byNameOrgs.find(
        (o) => o.id !== target.id && o.memberIds.includes(agent.id) && !now(target.id, o.id),
      )
      if (other) return { kind: "member", agentId: agent.id, orgId: target.id, otherId: other.id }
    }
  }

  for (const agent of sorted) {
    const mine = byNameOrgs.filter((o) => o.memberIds.includes(agent.id))
    for (const [i, a] of mine.entries())
      for (const b of mine.slice(i + 1))
        if (!now(a.id, b.id) && was(a.id, b.id))
          return { kind: "parent", agentId: agent.id, aId: a.id, bId: b.id }
  }
  return undefined
}

const membersOf = (orgs: readonly OneLineOrg[], orgId: string): readonly string[] =>
  orgs.find((o) => o.id === orgId)?.memberIds ?? []

/** The change that adds an agent to an organization. */
export const addMemberChange = (
  orgs: readonly OneLineOrg[],
  orgId: string,
  agentId: string,
): OrgLineChange => ({
  id: orgId,
  memberIds: [...membersOf(orgs, orgId).filter((id) => id !== agentId), agentId],
})

/** The changes of a move: the agent leaves `fromId`, and it joins `toId` (spec 030, check 1). */
export const moveMemberChanges = (
  orgs: readonly OneLineOrg[],
  agentId: string,
  fromId: string,
  toId: string,
): OrgLineChange[] => [
  { id: fromId, memberIds: membersOf(orgs, fromId).filter((id) => id !== agentId) },
  addMemberChange(orgs, toId, agentId),
]

/**
 * The organization that makes `orgId` refuse the agent, or undefined when the agent can be added:
 * the first conflicting organization in the order of names. This is the "<other>" of the line "In
 * <other>." in the field "Members" and of "Not on one line with <other>." in the lists. `leavingId`
 * is the organization of a move; `parentId` is the parent that the open form holds.
 */
export const memberLineConflict = (
  orgs: readonly OneLineOrg[],
  agents: readonly OneLineAgent[],
  agentId: string,
  orgId: string,
  options: { readonly leavingId?: string; readonly parentId?: string | null } = {},
): string | undefined => {
  const base: OrgLineChange[] =
    options.leavingId === undefined
      ? [addMemberChange(orgs, orgId, agentId)]
      : moveMemberChanges(orgs, agentId, options.leavingId, orgId)
  const { parentId } = options
  const changes =
    parentId === undefined
      ? base
      : base.map((c): OrgLineChange => (c.id === orgId ? { ...c, parentId } : c))
  const refusal = orgLineRefusal(orgs, agents, changes)
  return refusal?.kind === "member" && refusal.agentId === agentId ? refusal.otherId : undefined
}

/**
 * The agent that makes `parentId` refuse as the new parent of `orgId`, or undefined: the "<agent>"
 * of "Would split the line of <agent>." `memberIds` is the list of the open form (absent: the
 * stored list).
 */
export const parentLineConflict = (
  orgs: readonly OneLineOrg[],
  agents: readonly OneLineAgent[],
  orgId: string,
  parentId: string | null,
  memberIds?: readonly string[],
): string | undefined =>
  orgLineRefusal(orgs, agents, [
    memberIds === undefined ? { id: orgId, parentId } : { id: orgId, parentId, memberIds },
  ])?.agentId

/** `parentLineConflict` for each other organization: the organization id and the agent id. */
export const parentLineReasons = (
  orgs: readonly OneLineOrg[],
  agents: readonly OneLineAgent[],
  orgId: string,
  memberIds?: readonly string[],
): Map<string, string> => {
  const out = new Map<string, string>()
  for (const o of orgs) {
    if (o.id === orgId) continue
    const agentId = parentLineConflict(orgs, agents, orgId, o.id, memberIds)
    if (agentId !== undefined) out.set(o.id, agentId)
  }
  return out
}

/** The error code of a refusal: the code that the window and a linked computer read. */
export const lineRefusalCode = (refusal: LineRefusal): "org_line_member" | "org_line_parent" =>
  refusal.kind === "member" ? "org_line_member" : "org_line_parent"

/**
 * The words that fill the long line of a refusal, as the error detail carries them (a JSON text of
 * names): `agent`, `other` and `organization` for "<agent> is in <other>, which is not on one line
 * with <organization>."; `agent`, `a` and `b` for "<agent> is in <A> and <B>, which would not be on
 * one line." A name that is gone reads as an empty text.
 */
export const lineRefusalDetail = (
  refusal: LineRefusal,
  orgs: readonly { readonly id: string; readonly name: string }[],
  agents: readonly OneLineAgent[],
): string => {
  const org = (id: string) => orgs.find((o) => o.id === id)?.name ?? ""
  const agent = agents.find((a) => a.id === refusal.agentId)?.name ?? ""
  return JSON.stringify(
    refusal.kind === "member"
      ? { agent, other: org(refusal.otherId), organization: org(refusal.orgId) }
      : { agent, a: org(refusal.aId), b: org(refusal.bId) },
  )
}

/** Reads the detail of `lineRefusalDetail`: the names by word, or none when the text is not one. */
export const parseLineDetail = (detail: string): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(detail)
    if (typeof value !== "object" || value === null) return {}
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"),
    )
  } catch {
    return {}
  }
}
