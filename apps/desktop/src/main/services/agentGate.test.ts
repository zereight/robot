import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { AgentGate, rankOf } from "./agentGate.ts"

/** Lets the forked fibers run until each of them waits. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow
})

describe("AgentGate (spec 005, Queue)", () => {
  test("routines and workflows come after the user and other agents", () => {
    expect(rankOf("chat")).toBe(0)
    expect(rankOf("channel")).toBe(0)
    expect(rankOf("agent")).toBe(0)
    expect(rankOf("routine")).toBe(1)
    expect(rankOf("workflow")).toBe(1)
  })

  test("a chat task starts before a routine task that waited longer; one kind keeps its order", async () => {
    const order = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = new AgentGate()
        const order: string[] = []
        const hold = Deferred.makeUnsafe<void>()
        const job = (name: string, rank: number) =>
          gate.run(
            rank,
            Effect.sync(() => void order.push(name)),
          )
        const first = yield* Effect.forkChild(
          gate.run(
            0,
            Deferred.await(hold).pipe(Effect.tap(() => Effect.sync(() => void order.push("long")))),
          ),
        )
        yield* settle
        const waiting = [
          yield* Effect.forkChild(job("routine 1", 1)),
          yield* settle.pipe(Effect.andThen(Effect.forkChild(job("routine 2", 1)))),
          yield* settle.pipe(Effect.andThen(Effect.forkChild(job("chat", 0)))),
        ]
        yield* settle
        expect(gate.waiting).toBe(3)
        expect(order).toEqual([])
        yield* Deferred.succeed(hold, undefined)
        yield* Fiber.join(first)
        for (const f of waiting) yield* Fiber.join(f)
        return order
      }),
    )
    expect(order).toEqual(["long", "chat", "routine 1", "routine 2"])
  })

  test("a stop of a waiting task takes it out of the queue, and the next task still starts", async () => {
    const order = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = new AgentGate()
        const order: string[] = []
        const hold = Deferred.makeUnsafe<void>()
        const first = yield* Effect.forkChild(gate.run(0, Deferred.await(hold)))
        yield* settle
        const stopped = yield* Effect.forkChild(
          gate.run(
            0,
            Effect.sync(() => void order.push("stopped")),
          ),
        )
        const next = yield* Effect.forkChild(
          gate.run(
            1,
            Effect.sync(() => void order.push("next")),
          ),
        )
        yield* settle
        yield* Fiber.interrupt(stopped)
        expect(gate.waiting).toBe(1)
        yield* Deferred.succeed(hold, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(next)
        return order
      }),
    )
    expect(order).toEqual(["next"])
  })

  test("a failed task frees the turn", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = new AgentGate()
        yield* gate.run(0, Effect.fail("boom")).pipe(Effect.ignore)
        return yield* gate.run(1, Effect.succeed("ran"))
      }),
    )
    expect(result).toBe("ran")
  })
})
