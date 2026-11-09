import { describe, expect, test } from "bun:test"
import { CheckStopped, checkWorkflow } from "./model.ts"
import { CHECK_LIMITS, withChecker } from "./runner.ts"

// A model with a million times a million ways to go: no check of it ends in the test.
const HEAVY = String.raw`---- MODULE Heavy ----
EXTENDS Naturals
VARIABLES x, y
Init == x = 0 /\ y = 0
Next == x' \in 0..999999 /\ y' \in 0..999999
====`
const CONFIG = "INIT Init NEXT Next"

const graph = {
  nodes: [
    {
      id: "a",
      number: 1,
      kind: "text" as const,
      name: "A",
      prompt: "",
      accountId: null,
      model: null,
      effort: null,
      backup: null,
      silentLimit: "follow" as const,
      permission: null,
      continueOnFailure: false,
      question: "",
      threshold: 0.9,
      options: [],
      x: 0,
      y: 0,
    },
  ],
  connections: [],
}

describe("the worker of the check", () => {
  test("a model that runs long is ended at the time limit, and the app is not blocked", async () => {
    const ticks: number[] = []
    // The timer of the main thread keeps running while the worker works.
    const timer = setInterval(() => ticks.push(performance.now()), 20)
    const started = performance.now()
    const outcome = await withChecker({ ...CHECK_LIMITS, timeMs: 400 }, (run) =>
      run(HEAVY, CONFIG).then(
        () => "done",
        (error) => error,
      ),
    )
    clearInterval(timer)
    expect(outcome).toBeInstanceOf(CheckStopped)
    expect(outcome).toMatchObject({ reason: "time" })
    expect(performance.now() - started).toBeLessThan(5_000)
    // The main thread answered its timer many times during the 400 ms. It was not blocked.
    expect(ticks.length).toBeGreaterThan(5)
  })

  test("the result of the check says that the check stopped", async () => {
    const outcome = await withChecker({ ...CHECK_LIMITS, timeMs: 400 }, (run) =>
      checkWorkflow(graph, (_source, config) => run(HEAVY, config)),
    )
    expect(outcome).toEqual({ state: "stopped", reason: "time" })
  })

  test("a module that the checker cannot read is a fault, not a problem of the workflow", async () => {
    const outcome = await withChecker(CHECK_LIMITS, (run) =>
      checkWorkflow(graph, (_source, config) => run("not a module", config)),
    )
    expect(outcome.state).toBe("failed")
  })
})
