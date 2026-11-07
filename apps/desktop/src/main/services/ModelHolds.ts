import { holdLasts, type ModelPick, type NodeHold, sameModelChoice } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

/**
 * The clock of the holds. Only a test replaces it, to move time by hand (spec 006: "with a fake
 * clock, move the time past the reset time").
 */
export const holdClock = { now: () => Date.now() }

/** A hold of the main model of a node, as the store keeps it. */
export interface HoldState {
  /** When the hold ends, in ms since the epoch. */
  readonly until: number
  /** True after the user pressed "Use <main model> now". The hold no longer counts. */
  readonly released: boolean
  /** The backup model that was on the node when the hold began. */
  readonly backup: ModelPick
}

export interface ModelHoldsService {
  /**
   * The hold that counts now for a node whose backup is `backup`: not released, its time has not
   * passed, and it began with this same backup. A hold never passes to another backup (spec 006).
   */
  active(nodeId: string, backup: ModelPick | null): { readonly until: number } | null
  /**
   * The hold that is stored for the node, also after "Use <main model> now". The engine uses it to
   * tell a limit that comes back at once from a first limit (no second line, spec 006).
   */
  stored(nodeId: string): HoldState | null
  /**
   * A turn of the main model failed with a limit reason: the main model is held until `until`.
   * `fresh` is false when the user ended the hold of the same limit by hand before: the hold starts
   * again, and the task view shows no second line (spec 006).
   */
  start(nodeId: string, backup: ModelPick, until: number): { readonly fresh: boolean }
  /** "Use <main model> now": the hold stops counting. False when no hold counts. */
  release(nodeId: string): boolean
  /** The hold ends and leaves no trace: the backup is not ready, or it was changed or removed. */
  clear(nodeId: string): void
  /** The holds of the nodes of a workflow that count now. */
  ofWorkflow(workflowId: string): readonly NodeHold[]
}

interface Row {
  node_id: string
  ends_at: number
  released: number
  backup_account_id: string
  backup_model: string
  backup_effort: string | null
}

/** A timer cannot wait longer than this; it arms itself again when it fires early. */
const MAX_WAIT_MS = 2 ** 31 - 1

const pickOf = (r: Row): ModelPick => ({
  accountId: r.backup_account_id,
  model: r.backup_model,
  effort: r.backup_effort,
})

/**
 * The hold of the main model of a text node while its limit is spent (spec 006, "Backup model"). It
 * lives on this computer only: sync (019) does not carry it and an export does not hold it. It stays
 * after a restart and ends at its time, or with the button. Each change tells the windows through
 * "workflows.changed", because the editor and the run view show it.
 */
export class ModelHolds extends Context.Service<ModelHolds, ModelHoldsService>()(
  "robot/main/ModelHolds",
) {
  static readonly layer = Layer.effect(
    ModelHolds,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const timers = new Map<string, ReturnType<typeof setTimeout>>()

      const serverOf = (nodeId: string) =>
        db.get<{ server_id: string }>(
          `SELECT w.server_id FROM workflow_node n JOIN workflow w ON w.id = n.workflow_id
           WHERE n.id = ?`,
          nodeId,
        )?.server_id
      const tell = (nodeId: string) => {
        const serverId = serverOf(nodeId)
        if (serverId) bus.emit("workflows.changed", { serverId })
      }
      const row = (nodeId: string) =>
        db.get<Row>(
          `SELECT node_id, ends_at, released, backup_account_id, backup_model, backup_effort
           FROM model_hold WHERE node_id = ?`,
          nodeId,
        )

      /** Tells the windows when the time of the hold has passed. */
      const arm = (nodeId: string, endsAt: number) => {
        const old = timers.get(nodeId)
        if (old) clearTimeout(old)
        const wait = endsAt - holdClock.now()
        if (wait <= 0) return
        const timer = setTimeout(
          () => {
            timers.delete(nodeId)
            const current = row(nodeId)
            if (!current) return
            if (current.ends_at > holdClock.now()) return arm(nodeId, current.ends_at)
            db.run("DELETE FROM model_hold WHERE node_id = ?", nodeId)
            tell(nodeId)
          },
          Math.min(wait, MAX_WAIT_MS),
        )
        // The hold must not keep the app open.
        timer.unref?.()
        timers.set(nodeId, timer)
      }

      // The holds that a restart found: each one ends at its time. A hold that ended while the app
      // was closed is gone, and so is the hold of a node that no longer exists.
      db.run("DELETE FROM model_hold WHERE ends_at <= ?", holdClock.now())
      db.run("DELETE FROM model_hold WHERE node_id NOT IN (SELECT id FROM workflow_node)")
      for (const held of db.all<Row>(
        `SELECT node_id, ends_at, released, backup_account_id, backup_model, backup_effort
         FROM model_hold`,
      ))
        arm(held.node_id, held.ends_at)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const timer of timers.values()) clearTimeout(timer)
          timers.clear()
        }),
      )

      const stored = (nodeId: string): HoldState | null => {
        const current = row(nodeId)
        // A hold whose time has passed is gone. The row leaves with the next change.
        if (!current || current.ends_at <= holdClock.now()) return null
        return { until: current.ends_at, released: current.released === 1, backup: pickOf(current) }
      }

      return ModelHolds.of({
        active: (nodeId, backup) => {
          const hold = stored(nodeId)
          if (!hold || hold.released || !holdLasts(hold, holdClock.now())) return null
          // The node now has no backup, or another one: the hold does not count.
          if (backup === null || !sameModelChoice(hold.backup, backup)) return null
          return { until: hold.until }
        },
        stored,
        start: (nodeId, backup, until) => {
          const before = stored(nodeId)
          db.run(
            `INSERT INTO model_hold (node_id, ends_at, released, backup_account_id, backup_model, backup_effort)
             VALUES (?, ?, 0, ?, ?, ?)
             ON CONFLICT (node_id) DO UPDATE SET ends_at = excluded.ends_at, released = 0,
               backup_account_id = excluded.backup_account_id, backup_model = excluded.backup_model,
               backup_effort = excluded.backup_effort`,
            nodeId,
            until,
            backup.accountId,
            backup.model,
            backup.effort,
          )
          arm(nodeId, until)
          tell(nodeId)
          // The first limit of an episode shows the line. A limit that comes back after the user
          // ended the hold by hand, before the time of the first one passed, does not.
          return { fresh: !(before?.released === true && sameModelChoice(before.backup, backup)) }
        },
        release: (nodeId) => {
          const hold = stored(nodeId)
          if (!hold || hold.released) return false
          db.run("UPDATE model_hold SET released = 1 WHERE node_id = ?", nodeId)
          tell(nodeId)
          return true
        },
        clear: (nodeId) => {
          if (!row(nodeId)) return
          db.run("DELETE FROM model_hold WHERE node_id = ?", nodeId)
          const timer = timers.get(nodeId)
          if (timer) clearTimeout(timer)
          timers.delete(nodeId)
          tell(nodeId)
        },
        ofWorkflow: (workflowId) =>
          db
            .all<Row & { main_model: string | null; node_number: number }>(
              `SELECT h.node_id, h.ends_at, h.released, h.backup_account_id, h.backup_model, h.backup_effort,
                 n.model AS main_model, n.number AS node_number
               FROM model_hold h JOIN workflow_node n ON n.id = h.node_id
               WHERE n.workflow_id = ? AND h.released = 0 AND h.ends_at > ?
                 AND n.backup_account_id = h.backup_account_id
                 AND n.backup_model = h.backup_model
                 AND COALESCE(n.backup_effort, '') = COALESCE(h.backup_effort, '')
               ORDER BY n.number`,
              workflowId,
              holdClock.now(),
            )
            .map((r) => ({
              nodeId: r.node_id,
              number: r.node_number,
              until: r.ends_at,
              backup: pickOf(r),
              main: r.main_model ?? "",
            })),
      })
    }),
  )
}
