import { describe, expect, test } from "bun:test"
import { defaultSettings } from "@robot/shared"
import { Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { SettingsStore } from "./Settings.ts"

const setup = () => {
  const bus = EventBus.recording()
  const layer = SettingsStore.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Database.layer(":memory:"), bus.layer)),
  )
  return {
    bus,
    run: <A>(e: Effect.Effect<A, never, SettingsStore>) =>
      Effect.runSync(e.pipe(Effect.provide(layer), Effect.scoped)),
  }
}

describe("SettingsStore", () => {
  test("starts with defaults", () => {
    const { run } = setup()
    expect(run(SettingsStore.use((s) => s.get))).toEqual(defaultSettings)
  })

  test("a step limit outside 20 to 2000 reads as the default (spec 013)", () => {
    const { run } = setup()
    const next = run(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.update({ stepLimit: 50 })
        const kept = (yield* store.get).stepLimit
        yield* store.update({ stepLimit: 5 })
        return { kept, bad: (yield* store.get).stepLimit }
      }),
    )
    expect(next).toEqual({ kept: 50, bad: 300 })
  })

  test("update stores the patch and emits the new settings", () => {
    const { run, bus } = setup()
    const next = run(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.update({ theme: "light", language: "ko" })
        return yield* store.get
      }),
    )
    expect(next.theme).toBe("light")
    expect(next.language).toBe("ko")
    expect(next.textSize).toBe("default")
    expect(bus.events).toHaveLength(1)
    expect(bus.events[0]?.event).toBe("settings.changed")
  })
})
