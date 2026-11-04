import { describe, expect, test } from "bun:test"
import type { QuietTurn } from "@robot/shared"
import { Effect, Layer } from "effect"
import { Activity } from "./Activity.ts"
import { EventBus } from "./EventBus.ts"

const make = () => {
  const bus = EventBus.recording()
  const layer = Layer.provide(Activity.layer, bus.layer)
  const run = <A>(f: (a: Activity["Service"]) => A): Promise<A> =>
    Effect.runPromise(Activity.use((a) => Effect.sync(() => f(a))).pipe(Effect.provide(layer)))
  return { bus, layer, run }
}

const place = (over: Partial<Omit<QuietTurn, "seconds">> = {}): Omit<QuietTurn, "seconds"> => ({
  taskId: "t1",
  agentId: "a1",
  threadId: null,
  source: "chat",
  sourceId: "a1",
  name: "Mock account",
  ...over,
})

/** One Activity for a whole test: the layer builds a new one at each `run`. */
const shared = () => {
  const bus = EventBus.recording()
  const activity = Effect.runSync(
    Effect.gen(function* () {
      return yield* Activity
    }).pipe(Effect.provide(Layer.provide(Activity.layer, bus.layer))),
  )
  return { activity, events: bus.events }
}

describe("quiet turns (spec 005, 'Quiet line')", () => {
  test("a turn that becomes quiet is listed with its seconds, and the event holds every quiet turn", () => {
    const { activity, events } = shared()
    expect(activity.quietTurns().turns).toEqual([])
    activity.setQuiet(place(), 90)
    activity.setQuiet(place({ taskId: "t2", agentId: "a2", source: "channel", sourceId: "ch" }), 30)
    const turns = activity.quietTurns().turns
    expect(turns.map((t) => [t.taskId, t.agentId])).toEqual([
      ["t1", "a1"],
      ["t2", "a2"],
    ])
    expect(turns[0]?.seconds).toBeGreaterThanOrEqual(90)
    expect(turns[1]?.seconds).toBeGreaterThanOrEqual(30)
    const pushed = events.filter((e) => e.event === "quiet.changed")
    expect(pushed).toHaveLength(2)
    const last = pushed[1]?.payload as { turns: unknown[] } | undefined
    expect(last?.turns).toHaveLength(2)
    expect(activity.quietOf("t2")?.source).toBe("channel")
    expect(activity.quietOf("zzz")).toBeUndefined()
  })

  test("the end of a quiet turn is told once, and the end of a turn that was not quiet is not told", () => {
    const { activity, events } = shared()
    activity.setQuiet(place(), null)
    expect(events).toEqual([])
    activity.setQuiet(place(), 90)
    activity.setQuiet(place(), null)
    activity.setQuiet(place(), null)
    const pushed = events.filter((e) => e.event === "quiet.changed")
    expect(pushed).toHaveLength(2)
    const last = pushed[1]?.payload as { turns: unknown[] } | undefined
    expect(last?.turns).toEqual([])
    expect(activity.quietTurns().turns).toEqual([])
  })

  test("a new value for a turn that is quiet replaces the old one, as after the computer slept", () => {
    const { activity } = shared()
    activity.setQuiet(place(), 90)
    activity.setQuiet(place(), 200)
    expect(activity.quietTurns().turns).toHaveLength(1)
    expect(activity.quietOf("t1")?.seconds).toBeGreaterThanOrEqual(200)
  })

  test("the island hears about it through the change handlers", () => {
    const { activity } = shared()
    let calls = 0
    activity.onChange(() => calls++)
    activity.setQuiet(place(), 90)
    activity.setQuiet(place(), null)
    expect(calls).toBe(2)
  })

  test("nothing is kept for a later start: the list is memory only", async () => {
    const { run } = make()
    await run((a) => a.setQuiet(place(), 90))
    // A new Activity (a restart) has no quiet turn.
    expect(await run((a) => a.quietTurns().turns)).toEqual([])
  })
})
