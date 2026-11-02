import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { fakeClock } from "./silence.testing.ts"
import { SilenceTimer, SLEEP_GAP_MS, TICK_MS, turnWatch } from "./silence.ts"

const MINUTE = 60_000

const timer = (limitMinutes: number, held: { browser: boolean } = { browser: false }) => {
  const fake = fakeClock()
  const silent: number[] = []
  const t = new SilenceTimer({
    limitMs: limitMinutes * MINUTE,
    clock: fake.clock,
    onSilent: () => silent.push(1),
    userHoldsBrowser: () => held.browser,
  })
  return { fake, silent, t, held }
}

describe("the silent limit", () => {
  test("a turn with no sign of life is silent when the limit is reached, not before", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    fake.advance(MINUTE - TICK_MS)
    expect(silent).toEqual([])
    fake.advance(TICK_MS)
    expect(silent).toEqual([1])
  })

  test("the limit fires once", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    fake.advance(10 * MINUTE)
    expect(silent).toEqual([1])
  })

  test("a sign of life starts the count again at 0", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    fake.advance(50_000)
    t.alive()
    fake.advance(50_000)
    expect(silent).toEqual([])
    expect(t.silentFor).toBe(50_000)
    fake.advance(10_000)
    expect(silent).toEqual([1])
  })

  test("the clock does not run before the request is handed over", () => {
    const { fake, silent, t } = timer(1)
    fake.advance(10 * MINUTE)
    expect(silent).toEqual([])
    t.start()
    fake.advance(59_000)
    expect(silent).toEqual([])
  })

  test("the clock stops while the turn waits for the user and starts at 0 after", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    fake.advance(30_000)
    t.hold("user")
    // The turn waits for 2 minutes: it does not fail.
    fake.advance(2 * MINUTE)
    expect(silent).toEqual([])
    t.release("user")
    expect(t.silentFor).toBe(0)
    // After the answer the model is silent for a minute: now the turn fails.
    fake.advance(59_000)
    expect(silent).toEqual([])
    fake.advance(1_000)
    expect(silent).toEqual([1])
  })

  test("the clock stops while a tool step runs, from its start to its end", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    fake.advance(20_000)
    t.hold("tool:a")
    fake.advance(10 * MINUTE)
    expect(silent).toEqual([])
    t.release("tool:a")
    fake.advance(59_000)
    expect(silent).toEqual([])
    fake.advance(1_000)
    expect(silent).toEqual([1])
  })

  test("with two holds the clock runs again only when both have ended", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    t.hold("tool:a")
    t.hold("user")
    t.release("tool:a")
    fake.advance(5 * MINUTE)
    expect(silent).toEqual([])
    t.release("user")
    fake.advance(MINUTE)
    expect(silent).toEqual([1])
  })

  test("the clock stops while the user holds the browser", () => {
    const { fake, silent, t, held } = timer(1)
    t.start()
    fake.advance(40_000)
    held.browser = true
    fake.advance(5 * MINUTE)
    expect(silent).toEqual([])
    held.browser = false
    // It starts again at 0, so the 40 seconds from before do not count.
    fake.advance(59_000)
    expect(silent).toEqual([])
    fake.advance(1_000)
    expect(silent).toEqual([1])
  })

  test("the time while the computer sleeps does not count", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    fake.advance(30_000)
    // The computer sleeps for 3 hours.
    fake.sleep(3 * 60 * MINUTE)
    expect(silent).toEqual([])
    expect(t.silentFor).toBe(30_000 + TICK_MS)
    fake.advance(28_000)
    expect(silent).toEqual([])
    fake.advance(2_000)
    expect(silent).toEqual([1])
  })

  test("a short delay of a tick still counts in full", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    // A busy moment of 3 seconds is shorter than the gap that stands for a sleep.
    fake.sleep(SLEEP_GAP_MS - 1)
    expect(t.silentFor).toBe(SLEEP_GAP_MS - 1)
    expect(silent).toEqual([])
  })

  test("a stopped timer never fires", () => {
    const { fake, silent, t } = timer(1)
    t.start()
    fake.advance(30_000)
    t.stop()
    fake.advance(10 * MINUTE)
    expect(silent).toEqual([])
  })
})

describe("the watch of a turn", () => {
  const run = (limitMinutes: number) => {
    const fake = fakeClock()
    const progress: string[] = []
    const watch = turnWatch({
      limitMinutes,
      clock: fake.clock,
      progress: (p) => progress.push(p),
    })
    return { fake, progress, watch }
  }
  const text = { type: "text", text: "a" } as const
  const tool = (state: "running" | "done") =>
    ({
      type: "tool",
      state,
      call: { id: "c1", name: "read_file", input: "{}" },
      output: "",
    }) as never

  test("handing the request over makes the progress sent and starts the clock", () => {
    const { fake, progress, watch } = run(1)
    expect(progress).toEqual([])
    watch.handedOver()
    expect(progress).toEqual(["sent"])
    fake.advance(59_000)
    watch.stop()
  })

  test("a part of the reply makes the progress started; the count of tokens does not", () => {
    const { progress, watch } = run(1)
    watch.handedOver()
    watch.sense({ type: "usage", input: 5, output: 1 })
    expect(progress).toEqual(["sent"])
    watch.sense(text)
    expect(progress).toEqual(["sent", "started"])
    watch.stop()
  })

  test("a question or an approval makes the progress started", () => {
    const { progress, watch } = run(1)
    watch.handedOver()
    watch.waiting(true)
    expect(progress).toEqual(["sent", "started"])
    watch.stop()
  })

  test("the silent effect fails with the reason, in the singular for 1 minute", async () => {
    const { fake, watch } = run(1)
    watch.handedOver()
    const outcome = Effect.runPromiseExit(watch.silent)
    fake.advance(MINUTE)
    const exit = await outcome
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? (exit.cause.reasons[0] as { error?: unknown }).error : null
    expect(error).toMatchObject({ code: "silent_limit_1", detail: "1" })
  })

  test("the silent effect names the number of minutes for a longer limit", async () => {
    const { fake, watch } = run(5)
    watch.handedOver()
    const outcome = Effect.runPromiseExit(watch.silent)
    fake.advance(5 * MINUTE)
    const exit = await outcome
    const error = Exit.isFailure(exit) ? (exit.cause.reasons[0] as { error?: unknown }).error : null
    expect(error).toMatchObject({ code: "silent_limit", detail: "5" })
  })

  test("with no limit a silent turn does not fail by itself", () => {
    const { fake, progress, watch } = run(0)
    watch.handedOver()
    fake.advance(24 * 60 * MINUTE)
    expect(progress).toEqual(["sent"])
    watch.stop()
  })

  test("a tool step stops the clock from its start to its end", async () => {
    const { fake, watch } = run(1)
    let failed = false
    void Effect.runPromiseExit(watch.silent).then(() => {
      failed = true
    })
    watch.handedOver()
    watch.sense(tool("running"))
    fake.advance(10 * MINUTE)
    await Promise.resolve()
    expect(failed).toBe(false)
    watch.sense(tool("done"))
    fake.advance(MINUTE)
    await Promise.resolve()
    await Promise.resolve()
    expect(failed).toBe(true)
  })

  test("an approval that waits for 2 minutes does not fail the turn; silence after the answer does", async () => {
    const { fake, watch } = run(1)
    let failed = false
    void Effect.runPromiseExit(watch.silent).then(() => {
      failed = true
    })
    watch.handedOver()
    watch.waiting(true)
    fake.advance(2 * MINUTE)
    await Promise.resolve()
    expect(failed).toBe(false)
    watch.waiting(false)
    fake.advance(90_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(failed).toBe(true)
  })
})
