import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Deferred, Effect, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { AppError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testPlatform, testRuntime } from "./testing.ts"

const setup = async () => {
  const { runtime } = testRuntime()
  const run = runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: local.id, name, role: "", instructions: "", model: null }),
      ),
    )
  const make = (agentId: string, prompt: string, parentId: string | null = null) =>
    run(
      Tasks.use((t) => t.create({ agentId, prompt, source: "chat", sourceId: agentId, parentId })),
    )
  const state = async (id: string) => (await run(Tasks.use((t) => t.get(id)))).task.state
  return { run, local, agent, make, state }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("Tasks", () => {
  test("an agent runs one task at a time; the next one waits in order", async () => {
    const { run, agent, make, state } = await setup()
    const ada = await agent("Ada")
    const first = await make(ada.id, "first")
    const second = await make(ada.id, "second")
    const gate = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const one = run(
      Tasks.use((t) =>
        t.run(
          first.id,
          ada.id,
          Effect.gen(function* () {
            order.push("first start")
            yield* Deferred.await(gate)
            order.push("first end")
          }),
        ),
      ),
    )
    await sleep(20)
    const two = run(
      Tasks.use((t) =>
        t.run(
          second.id,
          ada.id,
          Effect.sync(() => order.push("second")),
        ),
      ),
    )
    await sleep(20)
    expect(await state(first.id)).toBe("running")
    expect(await state(second.id)).toBe("queued")
    await run(Deferred.succeed(gate, undefined))
    await Promise.all([one, two])
    expect(order).toEqual(["first start", "first end", "second"])
    expect(await state(first.id)).toBe("done")
    expect(await state(second.id)).toBe("done")
  })

  test("another agent is not blocked", async () => {
    const { run, agent, make, state } = await setup()
    const ada = await agent("Ada")
    const bo = await agent("Bo")
    const a = await make(ada.id, "a")
    const b = await make(bo.id, "b")
    const gate = Deferred.makeUnsafe<void>()
    const slow = run(Tasks.use((t) => t.run(a.id, ada.id, Deferred.await(gate))))
    await run(Tasks.use((t) => t.run(b.id, bo.id, Effect.void)))
    expect(await state(b.id)).toBe("done")
    expect(await state(a.id)).toBe("running")
    await run(Deferred.succeed(gate, undefined))
    await slow
  })

  test("stop cancels a running task and a queued one, and a failure keeps its code", async () => {
    const { run, agent, make, state } = await setup()
    const ada = await agent("Ada")
    const running = await make(ada.id, "running")
    const queued = await make(ada.id, "queued")
    const failing = await make(ada.id, "failing")
    const p1 = run(Tasks.use((t) => t.run(running.id, ada.id, Effect.never)))
    await sleep(20)
    const p2 = run(Tasks.use((t) => t.run(queued.id, ada.id, Effect.void)))
    await sleep(20)
    await run(Tasks.use((t) => t.stop(queued.id)))
    await run(Tasks.use((t) => t.stop(running.id)))
    await Promise.allSettled([p1, p2])
    expect(await state(running.id)).toBe("cancelled")
    expect(await state(queued.id)).toBe("cancelled")

    await run(
      Tasks.use((t) =>
        t.run(failing.id, ada.id, Effect.fail(new AppError({ code: "boom", detail: "why" }))),
      ),
    ).catch(() => {})
    const detail = await run(Tasks.use((t) => t.get(failing.id)))
    expect(detail.task.state).toBe("failed")
    expect(detail.task.error).toEqual({ code: "boom", detail: "why" })
  })

  test("stopping a parent stops its children", async () => {
    const { run, agent, make, state } = await setup()
    const ada = await agent("Ada")
    const bo = await agent("Bo")
    const parent = await make(ada.id, "parent")
    const child = await make(bo.id, "child", parent.id)
    const grandchild = await make(bo.id, "grandchild", child.id)
    const p = run(Tasks.use((t) => t.run(child.id, bo.id, Effect.never)))
    await sleep(20)
    await run(Tasks.use((t) => t.stop(parent.id)))
    await p.catch(() => {})
    expect(await state(parent.id)).toBe("cancelled")
    expect(await state(child.id)).toBe("cancelled")
    expect(await state(grandchild.id)).toBe("cancelled")
    const detail = await run(Tasks.use((t) => t.get(parent.id)))
    expect(detail.children.map((c) => c.id)).toEqual([child.id, grandchild.id])
  })

  test("retry needs a failed or cancelled task with a handler", async () => {
    const { run, agent, make } = await setup()
    const ada = await agent("Ada")
    const task = await make(ada.id, "x")
    const refused = await run(Tasks.use((t) => t.retry(task.id)).pipe(Effect.flip))
    expect(refused.code).toBe("cannot_retry_task")
  })

  test("after a restart, work that was running is failed with the reason", async () => {
    const { platform, dataDir } = testPlatform()
    const file = join(dataDir, "robot.db")
    const open = () =>
      ManagedRuntime.make(
        appLayer({
          platform,
          databaseFile: file,
          localServerName: "T",
          emit: () => {},
          secrets: Secrets.memory,
        }),
      )
    const first = open()
    const local = await first.runPromise(Servers.use((s) => s.local))
    const ada = await first.runPromise(
      Agents.use((a) =>
        a.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const task = await first.runPromise(
      Tasks.use((t) =>
        t.create({ agentId: ada.id, prompt: "p", source: "chat", sourceId: ada.id }),
      ),
    )
    await first.dispose()
    const second = open()
    const detail = await second.runPromise(Tasks.use((t) => t.get(task.id)))
    expect(detail.task.state).toBe("failed")
    expect(detail.task.error?.code).toBe("app_stopped")
    await second.dispose()
  })
})
