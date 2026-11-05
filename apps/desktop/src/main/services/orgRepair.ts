import type { SQLInputValue } from "node:sqlite"
import {
  type ChangeTime,
  type LineRepairOrg,
  type OrgRepair,
  orgRepairAfterImport,
  orgRepairAfterSync,
  orgRepairLines,
  type RepairOrg,
  type TreeRepairReason,
} from "@robot/shared"
import type { DatabaseService } from "./Database.ts"
import type { EventBusService } from "./EventBus.ts"
import { appendLog } from "./logs.ts"

// The repair of a broken organization tree (spec 030, "Repair"). The rules are in the shared tree
// module as pure functions. This file reads the organizations, clears the parent field of each one
// that they name, and gives back what it did. It is called where data comes in that was made
// elsewhere: after a sync brought changes, after a first copy by sync ended, after an import, and at
// the start of the app.

/** One repair that was made. */
export interface OrgRepaired {
  readonly id: string
  readonly name: string
  readonly reason: TreeRepairReason
}

export interface OrgRepairOptions {
  /**
   * "sync": changes of the other computer made the break, and the organization with the later parent
   * change is cleared. "import": the check goes from the top down, and a loop is broken by the tie
   * order alone (an import carries no time of change).
   */
  readonly mode: "sync" | "import"
  /**
   * When the parent field of each organization changed last, from the stamps that sync keeps. Both
   * computers hold the same stamps for the same changes, so both choose the same organization.
   * Absent: the stamps that the database holds, none for a database that never synced.
   */
  readonly changed?: ReadonlyMap<string, ChangeTime>
  readonly now?: () => number
}

/** The time of the last change of the parent field of each organization, from the stamps that sync keeps. */
export const storedOrgParentChanges = (db: DatabaseService): Map<string, ChangeTime> =>
  new Map(
    db
      .all<{ id: string; l: number; c: number; n: string }>(
        "SELECT id, l, c, n FROM sync_field WHERE kind = 'orgunit' AND field = 'parent'",
      )
      .map((r) => [r.id, { l: r.l, c: r.c, n: r.n }]),
  )

/**
 * Looks at all organizations. A loop or a fourth level is repaired: the parent field of the chosen
 * organization is cleared. A repair is not a change of the user: it makes no notification and has no
 * Undo. The cleared field is a change like any other, so sync sends it (spec 019). Returns the
 * repairs that were made, none for a tree that is right.
 */
export const repairOrgTree = (db: DatabaseService, options: OrgRepairOptions): OrgRepaired[] => {
  const now = options.now ?? Date.now
  const changed = options.changed ?? storedOrgParentChanges(db)
  const rows = db.all<{ id: string; name: string; parent_id: string | null; created_at: number }>(
    "SELECT id, name, parent_id, created_at FROM org_unit",
  )
  const orgs = rows.map((r): RepairOrg => {
    const stamp = changed.get(r.id)
    return {
      id: r.id,
      parentId: r.parent_id,
      createdAt: r.created_at,
      ...(stamp ? { parentChanged: stamp } : {}),
    }
  })
  const repairs: OrgRepair[] =
    options.mode === "import" ? orgRepairAfterImport(orgs) : orgRepairAfterSync(orgs)
  if (repairs.length === 0) return []
  const names = new Map(rows.map((r) => [r.id, r.name]))
  db.transaction(() => {
    for (const { id } of repairs)
      db.run("UPDATE org_unit SET parent_id = NULL, updated_at = ? WHERE id = ?", now(), id)
  })
  return repairs.map((r) => ({ id: r.id, name: names.get(r.id) ?? "", reason: r.reason }))
}

/**
 * Writes the line of each repair to the organization log (spec 014): the organization, the kind and
 * the time. It holds no text of a message.
 */
export const logOrgRepairs = (dataDir: string, repairs: readonly OrgRepaired[]) => {
  for (const r of repairs)
    appendLog(dataDir, "organizations", {
      event: "tree_repaired",
      organizationId: r.id,
      organization: r.name,
      kind: r.reason,
    })
}

/**
 * Tells what the repairs did: one line for each in the organization log, and the event of the
 * repair for a window that shows the org chart (the notice of the chart is a later step). The tree
 * itself is told with "organizations.changed".
 */
export const noteOrgRepairs = (
  bus: EventBusService,
  dataDir: string,
  serverId: string,
  repairs: readonly OrgRepaired[],
) => {
  if (repairs.length === 0) return
  logOrgRepairs(dataDir, repairs)
  for (const r of repairs)
    bus.emit("organizations.repaired", {
      serverId,
      organizationId: r.id,
      name: r.name,
      reason: r.reason,
    })
  bus.emit("organizations.changed", { serverId })
}

// ---------------------------------------------------------------------------------- the line

/** One removal that the repair of a line made: the agent left the organization. */
export interface LineRepaired {
  readonly orgId: string
  readonly orgName: string
  readonly agentId: string
  readonly agentName: string
  /** The organization that the agent is in, and that is not on one line with `orgId`. */
  readonly otherId: string
  readonly otherName: string
}

export interface LineRepairOptions {
  /**
   * When the members of each organization changed last, from the stamps that sync keeps. Absent: the
   * stamps that the database holds. An import and a migration carry no time: pass an empty map.
   */
  readonly changed?: ReadonlyMap<string, ChangeTime>
  readonly now?: () => number
}

/** What the repair of a line needs of a database: the migration passes the bare connection. */
export interface LineDb {
  all<T>(sql: string, ...params: SQLInputValue[]): T[]
  run(sql: string, ...params: SQLInputValue[]): void
}

/** The time of the last change of the members of each organization, from the stamps that sync keeps. */
export const storedOrgMemberChanges = (db: LineDb): Map<string, ChangeTime> =>
  new Map(
    db
      .all<{ id: string; l: number; c: number; n: string }>(
        "SELECT id, l, c, n FROM sync_field WHERE kind = 'orgunit' AND field = 'members'",
      )
      .map((r) => [r.id, { l: r.l, c: r.c, n: r.n }]),
  )

/**
 * Looks at all organizations. An agent whose organizations are not on one line leaves the
 * organization that it joined last, until they are (spec 030, "One line", "Repair"). It runs after
 * the repair of the tree. A removal is a normal change of the members, so sync sends it (spec 019),
 * and a lead that is removed is no longer the lead. It is not a change of the user: no notification
 * and no Undo. It never refuses. Returns the removals, none for data that is right.
 */
export const repairOrgLines = (db: LineDb, options: LineRepairOptions = {}): LineRepaired[] => {
  const now = options.now ?? Date.now
  const changed = options.changed ?? storedOrgMemberChanges(db)
  const rows = db.all<{ id: string; name: string; parent_id: string | null; created_at: number }>(
    "SELECT id, name, parent_id, created_at FROM org_unit",
  )
  const members = new Map<string, string[]>()
  for (const m of db.all<{ org_id: string; agent_id: string }>(
    "SELECT org_id, agent_id FROM org_member ORDER BY org_id, position",
  ))
    members.set(m.org_id, [...(members.get(m.org_id) ?? []), m.agent_id])
  const orgs = rows.map((r): LineRepairOrg => {
    const stamp = changed.get(r.id)
    return {
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      memberIds: members.get(r.id) ?? [],
      createdAt: r.created_at,
      ...(stamp ? { membersChanged: stamp } : {}),
    }
  })
  const removals = orgRepairLines(orgs)
  if (removals.length === 0) return []
  const orgNames = new Map(rows.map((r) => [r.id, r.name]))
  const agentNames = new Map(
    db.all<{ id: string; name: string }>("SELECT id, name FROM agent").map((a) => [a.id, a.name]),
  )
  // The caller holds the transaction: the removals of one pass go together.
  for (const { agentId, orgId } of removals) {
    db.run("DELETE FROM org_member WHERE org_id = ? AND agent_id = ?", orgId, agentId)
    // The lead of an organization is one of its members (spec 030).
    db.run(
      "UPDATE org_unit SET lead_agent_id = NULL WHERE id = ? AND lead_agent_id = ?",
      orgId,
      agentId,
    )
    db.run("UPDATE org_unit SET updated_at = ? WHERE id = ?", now(), orgId)
  }
  return removals.map((r) => ({
    orgId: r.orgId,
    orgName: orgNames.get(r.orgId) ?? "",
    agentId: r.agentId,
    agentName: agentNames.get(r.agentId) ?? "",
    otherId: r.otherId,
    otherName: orgNames.get(r.otherId) ?? "",
  }))
}

/**
 * Writes the line of each removal to the organization log (spec 014): the agent, the organization,
 * the kind "line". The time comes with the line. It holds no text of a message.
 */
export const logLineRepairs = (dataDir: string, repairs: readonly LineRepaired[]) => {
  for (const r of repairs)
    appendLog(dataDir, "organizations", {
      event: "line_repaired",
      organizationId: r.orgId,
      organization: r.orgName,
      agentId: r.agentId,
      agent: r.agentName,
      kind: "line",
    })
}

/**
 * Tells what the removals did: one line for each in the organization log, and the event for a
 * window that shows the org chart (it shows the line for 10 seconds, with no Undo and no notice).
 */
export const noteLineRepairs = (
  bus: EventBusService,
  dataDir: string,
  serverId: string,
  repairs: readonly LineRepaired[],
) => {
  if (repairs.length === 0) return
  logLineRepairs(dataDir, repairs)
  for (const r of repairs)
    bus.emit("organizations.repaired", {
      serverId,
      organizationId: r.orgId,
      name: r.orgName,
      reason: "line",
      agentName: r.agentName,
      otherName: r.otherName,
    })
  bus.emit("organizations.changed", { serverId })
}

/**
 * Writes the lines that a migration left in `org_line_note` to the organization log, and clears
 * them (spec 030, "Migration"). A migration has no data folder, so the lines wait until the app
 * starts. A start that is cut between the log and the clear writes the lines again: a line more is
 * better than a line lost.
 */
export const flushLineNotes = (db: DatabaseService, dataDir: string) => {
  const notes = db.all<{
    id: number
    org_id: string
    org_name: string
    agent_id: string
    agent_name: string
  }>("SELECT id, org_id, org_name, agent_id, agent_name FROM org_line_note ORDER BY id")
  if (notes.length === 0) return
  logLineRepairs(
    dataDir,
    notes.map((n) => ({
      orgId: n.org_id,
      orgName: n.org_name,
      agentId: n.agent_id,
      agentName: n.agent_name,
      otherId: "",
      otherName: "",
    })),
  )
  db.run("DELETE FROM org_line_note")
}
