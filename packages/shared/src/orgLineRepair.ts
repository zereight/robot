import { nameKey } from "./agents.ts"
import { onOneLine } from "./orgLine.ts"
import type { ChangeTime } from "./orgTree.ts"

// The repair of a broken line (spec 030, "One line", "Repair"). Two computers can each add the same
// agent to an organization while apart, or one can move an organization while the other adds a
// member. The check at each change cannot see that. The repair removes the agent from the
// organization that it joined last, one at a time, until its organizations are on one line. The
// result depends on the data only, so two computers that hold the same data choose the same
// removals.

/** What the repair needs of an organization. */
export interface LineRepairOrg {
  readonly id: string
  readonly name: string
  readonly parentId: string | null
  readonly memberIds: readonly string[]
  /** When the organization was made. */
  readonly createdAt: number
  /**
   * When the members changed last, from the stamp that sync keeps (019). Absent counts as the
   * oldest time: an import carries no time, and a migration has none.
   */
  readonly membersChanged?: ChangeTime
}

/** The agent leaves `orgId` because it is in `otherId`, which is not on one line with `orgId`. */
export interface LineRemoval {
  readonly agentId: string
  readonly orgId: string
  readonly otherId: string
}

const NEVER: ChangeTime = { l: 0, c: 0, n: "" }

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * More than 0 when `a` was joined after `b`: the later time of the membership change, then the
 * organization that was made later, then the later id (spec 030, "Which was joined later").
 */
const joinedLater = (a: LineRepairOrg, b: LineRepairOrg): number => {
  const x = a.membersChanged ?? NEVER
  const y = b.membersChanged ?? NEVER
  return x.l - y.l || x.c - y.c || a.createdAt - b.createdAt || compareText(a.id, b.id)
}

/** The order of names, ignoring case. A tie goes by id. */
const byName = (a: LineRepairOrg, b: LineRepairOrg) =>
  nameKey(a.name).localeCompare(nameKey(b.name)) || compareText(a.id, b.id)

/**
 * The removals that put every agent on one line. For one agent: among its organizations that are in
 * at least one pair that is not on one line, the one that it joined last loses the agent. The check
 * runs again until the organizations of the agent are on one line. `otherId` is the first, in the
 * order of names, of the organizations that the agent is in and that are not on one line with the
 * organization that it leaves. An agent whose organizations are on one line is never touched. Does
 * not depend on the order of the organizations. Nothing for data that is right.
 */
export const orgRepairLines = (orgs: readonly LineRepairOrg[]): LineRemoval[] => {
  const byId = new Map(orgs.map((o) => [o.id, o]))
  const mine = new Map<string, LineRepairOrg[]>()
  for (const o of orgs)
    for (const agentId of new Set(o.memberIds)) {
      const list = mine.get(agentId)
      if (list) list.push(o)
      else mine.set(agentId, [o])
    }
  const removals: LineRemoval[] = []
  for (const agentId of [...mine.keys()].sort(compareText)) {
    let left = (mine.get(agentId) ?? []).filter((o) => byId.has(o.id))
    for (;;) {
      const apart = left.filter((o) => left.some((p) => !onOneLine(orgs, o.id, p.id)))
      if (apart.length === 0) break
      const leaves = apart.reduce((best, o) => (joinedLater(o, best) > 0 ? o : best))
      const other = apart
        .filter((p) => !onOneLine(orgs, leaves.id, p.id))
        .sort(byName)[0] as LineRepairOrg
      removals.push({ agentId, orgId: leaves.id, otherId: other.id })
      left = left.filter((o) => o.id !== leaves.id)
    }
  }
  return removals
}
