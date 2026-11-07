import {
  HOLD_MAX_MS,
  HOLD_UNKNOWN_MS,
  holdLasts,
  type ModelPick,
  type NodeHold,
  sameModelChoice,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { appendLog } from "./logs.ts"
import { Platform } from "./Platform.ts"

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
  /** The main choice of the node that reached its limit. The hold is of this model only. */
  readonly main: ModelPick
  /** The backup model that was on the node when the hold began. */
  readonly backup: ModelPick
}

export interface ModelHoldsService {
  /**
   * The hold that counts now for a node whose main choice is `main` and whose backup is `backup`: not
   * released, its time has not passed, and it began with this same main choice and this same backup.
   * A hold never passes to another main model or to another backup: it is dropped (spec 006: "it
   * holds the main model").
   */
  active(
    nodeId: string,
    main: ModelPick,
    backup: ModelPick | null,
  ): { readonly until: number } | null
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
  start(
    nodeId: string,
    main: ModelPick,
    backup: ModelPick,
    until: number,
  ): { readonly fresh: boolean }
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
  main_account_id: string
  main_model: string
  main_effort: string | null
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

const mainOf = (r: Row): ModelPick => ({
  accountId: r.main_account_id,
  model: r.main_model,
  effort: r.main_effort,
})

const COLUMNS = `node_id, ends_at, released, main_account_id, main_model, main_effort,
  backup_account_id, backup_model, backup_effort`

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
      const platform = yield* Platform
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
        db.get<Row>(`SELECT ${COLUMNS} FROM model_hold WHERE node_id = ?`, nodeId)

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
      // was closed is gone, and so is the hold of a node that no longer exists. A row with a time
      // that no hold can have (not a whole number, or more than the longest hold ahead) is dropped
      // and logged: a bad row never stops the app from starting. The test is made in SQL, before a
      // value is read into a number, because a value past 2^53 cannot be read at all.
      const now = holdClock.now()
      const bad = `ends_at <= ${Number(now)} OR typeof(ends_at) <> 'integer'
        OR ends_at > ${Number(now) + HOLD_MAX_MS}`
      try {
        const dropped = db.all<{ node_id: string }>(`SELECT node_id FROM model_hold WHERE ${bad}`)
        db.run(`DELETE FROM model_hold WHERE ${bad}`)
        db.run("DELETE FROM model_hold WHERE node_id NOT IN (SELECT id FROM workflow_node)")
        for (const gone of dropped)
          appendLog(platform.dataDir, "workflows", {
            event: "hold_dropped",
            node: gone.node_id,
            reason: "bad or ended time",
          })
        for (const held of db.all<Row>(`SELECT ${COLUMNS} FROM model_hold`))
          arm(held.node_id, held.ends_at)
      } catch (error) {
        // A table that cannot be read is emptied: the holds are a state that can be lost. Starting
        // the app comes first.
        appendLog(platform.dataDir, "workflows", {
          event: "hold_load_failed",
          reason: error instanceof Error ? error.message : String(error),
        })
        try {
          db.run("DELETE FROM model_hold")
        } catch {
          // Nothing more to do: the holds stay unread, and the app starts.
        }
      }
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
        return {
          until: current.ends_at,
          released: current.released === 1,
          main: mainOf(current),
          backup: pickOf(current),
        }
      }

      /** Takes the row away with no word to the windows: used for a hold that never showed again. */
      const drop = (nodeId: string) => {
        db.run("DELETE FROM model_hold WHERE node_id = ?", nodeId)
        const timer = timers.get(nodeId)
        if (timer) clearTimeout(timer)
        timers.delete(nodeId)
      }

      return ModelHolds.of({
        active: (nodeId, main, backup) => {
          const hold = stored(nodeId)
          if (!hold || hold.released || !holdLasts(hold, holdClock.now())) return null
          // The node now has another main model, no backup or another one: the hold does not
          // count, and it is dropped. It shows nowhere, so no window needs to hear of it.
          if (
            backup === null ||
            !sameModelChoice(hold.main, main) ||
            !sameModelChoice(hold.backup, backup)
          ) {
            drop(nodeId)
            return null
          }
          return { until: hold.until }
        },
        stored,
        start: (nodeId, main, backup, wanted) => {
          const before = stored(nodeId)
          // No caller may store a time that no hold can have.
          const at = holdClock.now()
          const until = Number.isFinite(wanted)
            ? Math.min(Math.max(Math.ceil(wanted), at + 1), at + HOLD_MAX_MS)
            : at + HOLD_UNKNOWN_MS
          db.run(
            `INSERT INTO model_hold (node_id, ends_at, released, main_account_id, main_model, main_effort,
               backup_account_id, backup_model, backup_effort)
             VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (node_id) DO UPDATE SET ends_at = excluded.ends_at, released = 0,
               main_account_id = excluded.main_account_id, main_model = excluded.main_model,
               main_effort = excluded.main_effort, backup_account_id = excluded.backup_account_id, backup_model = excluded.backup_model,
               backup_effort = excluded.backup_effort`,
            nodeId,
            until,
            main.accountId,
            main.model,
            main.effort,
            backup.accountId,
            backup.model,
            backup.effort,
          )
          arm(nodeId, until)
          tell(nodeId)
          // The first limit of an episode shows the line. A limit that comes back after the user
          // ended the hold by hand, before the time of the first one passed, does not.
          return {
            fresh: !(
              before?.released === true &&
              sameModelChoice(before.main, main) &&
              sameModelChoice(before.backup, backup)
            ),
          }
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
        ofWorkflow: (workflowId) => {
          const out: NodeHold[] = []
          const rows = db.all<
            Row & {
              n_account_id: string | null
              n_model: string | null
              n_effort: string | null
              n_backup_account_id: string | null
              n_backup_model: string | null
              n_backup_effort: string | null
              node_number: number
            }
          >(
            `SELECT ${COLUMNS.split(",")
              .map((c) => `h.${c.trim()}`)
              .join(", ")},
               n.account_id AS n_account_id, n.model AS n_model, n.effort AS n_effort,
               n.backup_account_id AS n_backup_account_id, n.backup_model AS n_backup_model,
               n.backup_effort AS n_backup_effort, n.number AS node_number
             FROM model_hold h JOIN workflow_node n ON n.id = h.node_id
             WHERE n.workflow_id = ? AND h.released = 0 AND h.ends_at > ?
             ORDER BY n.number`,
            workflowId,
            holdClock.now(),
          )
          for (const r of rows) {
            const main =
              r.n_account_id !== null && r.n_model !== null
                ? { accountId: r.n_account_id, model: r.n_model, effort: r.n_effort }
                : null
            const backup =
              r.n_backup_account_id !== null && r.n_backup_model !== null
                ? {
                    accountId: r.n_backup_account_id,
                    model: r.n_backup_model,
                    effort: r.n_backup_effort,
                  }
                : null
            // The node names another main model or another backup now: the hold is dropped.
            if (
              main === null ||
              backup === null ||
              !sameModelChoice(mainOf(r), main) ||
              !sameModelChoice(pickOf(r), backup)
            ) {
              drop(r.node_id)
              continue
            }
            out.push({
              nodeId: r.node_id,
              number: r.node_number,
              until: r.ends_at,
              backup: pickOf(r),
              // The model of the hold, not of the node: it is the one that reached its limit.
              main: r.main_model,
            })
          }
          return out
        },
      })
    }),
  )
}
