import { defaultUiState, UiState, type UiStatePatch } from "@robot/shared"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./Database.ts"
import { keyValueTable } from "./keyValue.ts"

export interface UiStoreService {
  readonly get: Effect.Effect<UiState>
  update(patch: UiStatePatch): Effect.Effect<UiState>
}

/** Window layout state between runs. Only the renderer that changes it reads it back. */
export class UiStore extends Context.Service<UiStore, UiStoreService>()("robot/main/UiStore") {
  static readonly layer = Layer.effect(
    UiStore,
    Effect.gen(function* () {
      const table = keyValueTable(yield* Database, "ui_state", defaultUiState, Schema.is(UiState))
      return UiStore.of({
        get: Effect.sync(table.read),
        update: (patch) =>
          Effect.sync(() => {
            table.write(patch)
            return table.read()
          }),
      })
    }),
  )
}
