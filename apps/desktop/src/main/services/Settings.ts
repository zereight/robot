import { defaultSettings, type Settings, type SettingsPatch } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

export interface SettingsService {
  readonly get: Effect.Effect<Settings>
  update(patch: SettingsPatch): Effect.Effect<Settings>
}

/** Stores settings as one row per key, so new keys get their default value. */
export class SettingsStore extends Context.Service<SettingsStore, SettingsService>()(
  "robot/main/SettingsStore",
) {
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus

      const read = (): Settings => {
        const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM setting")
        const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
        const result: Record<string, unknown> = { ...defaultSettings }
        for (const key of Object.keys(defaultSettings)) {
          if (key in stored && typeof stored[key] === typeof result[key]) result[key] = stored[key]
        }
        return result as Settings
      }

      const update = Effect.fn("SettingsStore.update")(function* (patch: SettingsPatch) {
        db.transaction(() => {
          for (const [key, value] of Object.entries(patch)) {
            db.run(
              "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
              key,
              JSON.stringify(value),
            )
          }
        })
        const next = read()
        bus.emit("settings.changed", next)
        return next
      })

      return SettingsStore.of({ get: Effect.sync(read), update })
    }),
  )
}
