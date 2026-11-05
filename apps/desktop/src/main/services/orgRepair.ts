import {
  type ChangeTime,
  type OrgRepair,
  orgRepairAfterImport,
  orgRepairAfterSync,
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
