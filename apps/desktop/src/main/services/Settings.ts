import { defaultSettings, Settings, type SettingsPatch } from "@robot/shared"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { keyValueTable } from "./keyValue.ts"

export interface SettingsService {
  readonly get: Effect.Effect<Settings>
  update(patch: SettingsPatch): Effect.Effect<Settings>
}

export class SettingsStore extends Context.Service<SettingsStore, SettingsService>()(
  "robot/main/SettingsStore",
) {
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const bus = yield* EventBus
      const table = keyValueTable(yield* Database, "setting", defaultSettings, Schema.is(Settings))

      const update = (patch: SettingsPatch) =>
        Effect.sync(() => {
          table.write(patch)
          const next = table.read()
          bus.emit("settings.changed", next)
          return next
        })

      return SettingsStore.of({ get: Effect.sync(table.read), update })
    }),
  )
}
