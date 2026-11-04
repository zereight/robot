import { type KeepAwakeState, keepAwakeState } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Activity } from "./Activity.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { Platform } from "./Platform.ts"
import { SettingsStore } from "./Settings.ts"

export interface KeepAwakeService {
  /** Whether the computer is held awake now, and why. */
  readonly state: Effect.Effect<KeepAwakeState>
}

/**
 * Keeps the computer from sleeping while the work of the app needs it (spec 013, "Keep the
 * computer awake"). A computer that sleeps runs no agent and no routine. The service looks at the
 * setting, at the agents that work, at the routines that are on and at the power source. Each time
 * one of them changes, it decides again and tells the platform. It holds nothing that outlives the
 * app: the hold ends when the app ends.
 */
export class KeepAwake extends Context.Service<KeepAwake, KeepAwakeService>()(
  "robot/main/KeepAwake",
) {
  static readonly layer = Layer.effect(
    KeepAwake,
    Effect.gen(function* () {
      const platform = yield* Platform
      const activity = yield* Activity
      const bus = yield* EventBus
      const db = yield* Database
      const settings = yield* SettingsStore

      let mode = (yield* settings.get).keepAwake
      /** The routines that are on and run on this computer, not on the other of a sync pair. */
      const routinesOn = () =>
        db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM routine WHERE enabled = 1 AND runs_on IS NULL",
        )?.n ?? 0
      const compute = (): KeepAwakeState =>
        keepAwakeState({
          mode,
          working: activity.workingIds().length,
          routines: routinesOn(),
          onBattery: platform.onBattery(),
        })

      let last: KeepAwakeState | undefined
      const same = (a: KeepAwakeState, b: KeepAwakeState) =>
        a.reason === b.reason &&
        a.mode === b.mode &&
        a.working === b.working &&
        a.routines === b.routines &&
        a.onBattery === b.onBattery
      /** Decides again. The windows hear of a change only when something that they show changed. */
      const refresh = () => {
        const next = compute()
        platform.setKeepAwake(next.reason !== null)
        if (last && same(last, next)) return
        last = next
        bus.emit("keepAwake.changed", next)
      }

      activity.onChange(refresh)
      platform.onPowerSource(refresh)
      bus.tap((event, payload) => {
        if (event === "settings.changed") {
          mode = (payload as { keepAwake: typeof mode }).keepAwake
          refresh()
        } else if (event === "routines.changed") refresh()
      })
      refresh()

      return KeepAwake.of({ state: Effect.sync(compute) })
    }),
  )
}
