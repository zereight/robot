import { holdLasts } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

/**
 * The clock of the holds. Only a test replaces it, to move time by hand (spec 006: "with a fake
 * clock, move the time past the reset time").
 */
export const holdClock = { now: () => Date.now() }

/** A hold of the main model of an agent, as the store keeps it. */
export interface HoldState {
  /** When the hold ends, in ms since the epoch. */
  readonly until: number
  /** True after the user pressed "Use the main model now". The hold no longer counts. */
  readonly released: boolean
}

export interface ModelHoldsService {
  /** The hold that counts now: not released, and its time has not passed. Null otherwise. */
  active(agentId: string): { readonly until: number } | null
  /**
   * The hold that stores for the agent, also after "Use the main model now" and after its time
   * passed. The agent uses it to tell a limit that comes back from a first limit.
   */
  stored(agentId: string): HoldState | null
  /**
   * A turn of the main model failed with a limit reason: the main model is held until `until`.
   * `fresh` is false when the user ended the hold of the same limit by hand before: the hold
   * starts again, and the chat shows no second line (spec 006).
   */
  start(agentId: string, until: number): { readonly fresh: boolean }
  /** "Use the main model now": the hold stops counting. False when no hold counts. */
  release(agentId: string): boolean
  /** The hold ends and leaves no trace: the backup is not ready, or the main model answered. */
  clear(agentId: string): void
}

interface Row {
  agent_id: string
  ends_at: number
  released: number
}

/** A timer cannot wait longer than this; it arms itself again when it fires early. */
const MAX_WAIT_MS = 2 ** 31 - 1

/**
 * The hold of the main model of an agent while its limit is spent (spec 006, "Backup model"). It
 * lives on this computer only: sync (019) does not carry it and an export does not hold it. It
 * stays after a restart and ends at its time or with the button. Each change tells the windows
 * and the linked devices through "agents.changed", because the header of the chat shows it.
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

      const serverOf = (agentId: string) =>
        db.get<{ server_id: string }>("SELECT server_id FROM agent WHERE id = ?", agentId)
          ?.server_id
      const tell = (agentId: string) => {
        const serverId = serverOf(agentId)
        if (serverId) bus.emit("agents.changed", { serverId })
      }
      const row = (agentId: string) =>
        db.get<Row>(
          "SELECT agent_id, ends_at, released FROM model_hold WHERE agent_id = ?",
          agentId,
        )

      /** Tells the windows and the linked devices when the time of the hold has passed. */
      const arm = (agentId: string, endsAt: number) => {
        const old = timers.get(agentId)
        if (old) clearTimeout(old)
        const wait = endsAt - holdClock.now()
        if (wait <= 0) return
        const timer = setTimeout(
          () => {
            timers.delete(agentId)
            const current = row(agentId)
            if (!current) return
            if (current.ends_at > holdClock.now()) return arm(agentId, current.ends_at)
            db.run("DELETE FROM model_hold WHERE agent_id = ?", agentId)
            tell(agentId)
          },
          Math.min(wait, MAX_WAIT_MS),
        )
        // The hold must not keep the app open.
        timer.unref?.()
        timers.set(agentId, timer)
      }

      // The holds that a restart found: each one ends at its time, and a hold that ended while
      // the app was closed is gone.
      db.run("DELETE FROM model_hold WHERE ends_at <= ?", holdClock.now())
      for (const held of db.all<Row>("SELECT agent_id, ends_at, released FROM model_hold"))
        arm(held.agent_id, held.ends_at)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const timer of timers.values()) clearTimeout(timer)
          timers.clear()
        }),
      )

      const stored = (agentId: string): HoldState | null => {
        const current = row(agentId)
        if (!current) return null
        // A hold whose time has passed is gone. The row leaves with the next change.
        if (current.ends_at <= holdClock.now()) return null
        return { until: current.ends_at, released: current.released === 1 }
      }

      return ModelHolds.of({
        active: (agentId) => {
          const hold = stored(agentId)
          return hold && !hold.released && holdLasts(hold, holdClock.now())
            ? { until: hold.until }
            : null
        },
        stored,
        start: (agentId, until) => {
          const before = stored(agentId)
          db.run(
            `INSERT INTO model_hold (agent_id, ends_at, released) VALUES (?, ?, 0)
             ON CONFLICT (agent_id) DO UPDATE SET ends_at = excluded.ends_at, released = 0`,
            agentId,
            until,
          )
          arm(agentId, until)
          tell(agentId)
          // The first limit of an episode shows the line. A limit that comes back after the user
          // ended the hold by hand, before the time of the first one passed, does not.
          return { fresh: !(before?.released === true) }
        },
        release: (agentId) => {
          const hold = stored(agentId)
          if (!hold || hold.released) return false
          db.run("UPDATE model_hold SET released = 1 WHERE agent_id = ?", agentId)
          tell(agentId)
          return true
        },
        clear: (agentId) => {
          if (!row(agentId)) return
          db.run("DELETE FROM model_hold WHERE agent_id = ?", agentId)
          const timer = timers.get(agentId)
          if (timer) clearTimeout(timer)
          timers.delete(agentId)
          tell(agentId)
        },
      })
    }),
  )
}
