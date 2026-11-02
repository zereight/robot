import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { taskTimes } from "@robot/shared"
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { AppError } from "./errors.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
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
  test("the times of a task: wait, first reply and total (spec 005)", async () => {
    const { run, agent } = await setup()
    const ada = await agent("Ada")
    const asked = Date.now() - 1000
    const task = await run(
      Tasks.use((t) =>
        t.create({
          agentId: ada.id,
          prompt: "q",
          source: "chat",
          sourceId: ada.id,
          askedAt: asked,
        }),
      ),
    )
    expect(task.askedAt).toBe(asked)
    expect(task.firstReplyAt).toBeNull()
    await run(
      Tasks.use((t) =>
        t.run(
          task.id,
          ada.id,
          Effect.gen(function* () {
            yield* Effect.sleep(30)
            t.replied(task.id)
            const first = (yield* t.get(task.id)).task.firstReplyAt
            yield* Effect.sleep(10)
            // Only the first reply counts.
            t.replied(task.id)
            expect((yield* t.get(task.id)).task.firstReplyAt).toBe(first)
          }),
        ),
      ),
    )
    const done = (await run(Tasks.use((t) => t.get(task.id)))).task
    const times = taskTimes(done)
    expect(times.wait).toBeGreaterThanOrEqual(0)
    expect(times.firstReply).toBeGreaterThanOrEqual(1030)
    expect(times.total).toBeGreaterThanOrEqual(times.firstReply ?? 0)
    // An ask time in the future is not possible: it is cut to the moment the task is made.
    const later = await run(
      Tasks.use((t) =>
        t.create({
          agentId: ada.id,
          prompt: "q",
          source: "chat",
          sourceId: ada.id,
          askedAt: Date.now() + 60_000,
        }),
      ),
    )
    expect(later.askedAt).toBe(later.createdAt)
  })

  test("a restart keeps the times that are known, and the total of a stopped task is not known", async () => {
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
    const make = () =>
      first.runPromise(
        Tasks.use((t) =>
          t.create({ agentId: ada.id, prompt: "p", source: "chat", sourceId: ada.id }),
        ),
      )
    const finished = await make()
    await first.runPromise(
      Tasks.use((t) =>
        t.run(
          finished.id,
          ada.id,
          Effect.sync(() => t.replied(finished.id)),
        ),
      ),
    )
    const before = taskTimes((await first.runPromise(Tasks.use((t) => t.get(finished.id)))).task)
    // A task that ran and had a reply when the app quit at once, with no time to end it.
    const open1 = await make()
    const now = Date.now()
    await first.runPromise(
      Database.use((db) =>
        Effect.sync(() =>
          db.run(
            "UPDATE task SET state = 'running', started_at = ?, first_reply_at = ? WHERE id = ?",
            now,
            now + 5,
            open1.id,
          ),
        ),
      ),
    )
    // The app closes in the middle of the task.
    await first.dispose()
    const second = open()
    const after = (id: string) => second.runPromise(Tasks.use((t) => t.get(id)))
    expect(taskTimes((await after(finished.id)).task)).toEqual(before)
    const stopped = (await after(open1.id)).task
    expect(stopped.error?.code).toBe("app_stopped")
    expect(taskTimes(stopped).wait).not.toBeNull()
    expect(taskTimes(stopped).firstReply).not.toBeNull()
    expect(taskTimes(stopped).total).toBeNull()
    await second.dispose()
  })

  test("after a restart, a task that waits for the user waits on, unless it cannot (spec 005)", async () => {
    const { platform, dataDir } = testPlatform()
    const file = join(dataDir, "robot.db")
    // The key of the API account stays across the restart, as in the keychain.
    const keys = new Map([[secretKey("api"), "sk-test"]])
    const secrets = Layer.succeed(
      Secrets,
      Secrets.of({
        get: (key) => keys.get(key) ?? null,
        set: (key, value) => void keys.set(key, value),
        remove: (key) => void keys.delete(key),
      }),
    )
    const open = () =>
      ManagedRuntime.make(
        appLayer({ platform, databaseFile: file, localServerName: "T", emit: () => {}, secrets }),
      )
    const first = open()
    const local = await first.runPromise(Servers.use((s) => s.local))
    const sql = (text: string, ...args: (string | number | null)[]) =>
      first.runPromise(Database.use((db) => Effect.sync(() => db.run(text, ...args))))
    await sql(
      "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('api', 'openai', 'Api', 'http://x', 1)",
    )
    await sql(
      "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('cli', 'claude_code', 'Cli', '', 1)",
    )
    const agent = async (name: string, account: string) => {
      const made = await first.runPromise(
        Agents.use((a) =>
          a.create({ serverId: local.id, name, role: "", instructions: "", model: null }),
        ),
      )
      await sql(
        "UPDATE agent SET model_account_id = ?, model_name = 'm' WHERE id = ?",
        account,
        made.id,
      )
      return made.id
    }
    const waitingCard = JSON.stringify([
      {
        kind: "tool",
        id: "c1",
        name: "run_command",
        label: "run_command",
        state: "waiting",
        input: JSON.stringify({ command: "rm /tmp/robot-unit-test-missing-file" }),
        output: "",
        ask: { kind: "approval", summary: "rm /tmp/robot-unit-test-missing-file", askedAt: 5 },
      },
    ])
    /** A task that waits at a card, as the app left it when it closed. */
    const waiting = async (
      id: string,
      agentId: string,
      extra: { source?: string; parent?: string | null; state?: string; parts?: string } = {},
    ) => {
      await sql(
        `INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES (?, ?, 'agent', ?, 'streaming', 1)`,
        `m-${id}`,
        agentId,
        extra.parts ?? waitingCard,
      )
      await sql(
        `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, message_id, state, created_at)
         VALUES (?, ?, 'p', 'p', ?, ?, ?, ?, ?, 1)`,
        id,
        agentId,
        extra.source ?? "chat",
        agentId,
        extra.parent ?? null,
        `m-${id}`,
        extra.state ?? "waiting",
      )
    }
    const ada = await agent("Ada", "api")
    const bob = await agent("Bob", "cli")
    const cy = await agent("Cy", "api")
    const di = await agent("Di", "api")
    const ed = await agent("Ed", "api")
    const fay = await agent("Fay", "api")
    await waiting("kept", ada)
    // A second task of the same agent is only queued: it fails with the reason.
    await waiting("queued", ada, { state: "queued", parts: "[]" })
    await waiting("runtime", bob)
    await waiting("child", cy, { parent: "kept" })
    await waiting("workflow", di, { source: "workflow" })
    // A task that waits for the user for another reason has no card to show again.
    await waiting("no-card", ed, { parts: "[]" })
    await waiting("running", fay, { state: "running", parts: "[]" })
    await first.dispose()

    const second = open()
    const states = Object.fromEntries(
      await Promise.all(
        ["kept", "queued", "runtime", "child", "workflow", "no-card", "running"].map(
          async (id) => [id, (await second.runPromise(Tasks.use((t) => t.get(id)))).task] as const,
        ),
      ),
    )
    expect(states.kept?.state).toBe("waiting")
    expect(states.kept?.error).toBeNull()
    for (const id of ["queued", "runtime", "child", "workflow", "no-card", "running"] as const) {
      expect(states[id]?.state).toBe("failed")
      expect(states[id]?.error?.code).toBe("app_stopped")
    }
    expect(
      (await second.runPromise(Tasks.use((t) => Effect.sync(() => t.waitingAfterRestart())))).map(
        (t) => t.id,
      ),
    ).toEqual(["kept"])
    // The turn started again and asks for the same card, so an answer reaches it.
    for (let i = 0; i < 100; i++) {
      if (await second.runPromise(Tools.use((t) => Effect.sync(() => t.isWaiting(ada, "c1")))))
        break
      await sleep(20)
    }
    expect(
      await second.runPromise(Tools.use((t) => Effect.sync(() => t.isWaiting(ada, "c1")))),
    ).toBe(true)
    const message = await second.runPromise(
      Database.use((db) =>
        Effect.sync(() =>
          db.get<{ status: string; parts: string }>("SELECT * FROM message WHERE id = 'm-kept'"),
        ),
      ),
    )
    // The reply keeps streaming, and the card keeps the time of its first ask.
    expect(message?.status).toBe("streaming")
    expect(JSON.parse(message?.parts ?? "[]")[0].ask.askedAt).toBe(5)
    await second.dispose()
  })
  test("a task starts at not sent, and its progress only goes up (spec 005)", async () => {
    const { run, agent, make } = await setup()
    const ada = await agent("Ada")
    const task = await make(ada.id, "p")
    const progress = async () => (await run(Tasks.use((t) => t.get(task.id)))).task.progress
    expect(task.progress).toBe("not_sent")
    const set = (value: "not_sent" | "sent" | "started") =>
      run(Tasks.use((t) => Effect.sync(() => t.setProgress(task.id, value))))
    await set("sent")
    expect(await progress()).toBe("sent")
    await set("started")
    expect(await progress()).toBe("started")
    // It never goes back.
    await set("sent")
    await set("not_sent")
    expect(await progress()).toBe("started")
  })

  test("a new task from Retry starts at not sent, however far the first one went", async () => {
    const { run, agent, make } = await setup()
    const ada = await agent("Ada")
    const first = await make(ada.id, "p")
    await run(Tasks.use((t) => Effect.sync(() => t.setProgress(first.id, "started"))))
    const again = await run(
      Tasks.use((t) =>
        t.create({
          agentId: ada.id,
          prompt: "p",
          source: "chat",
          sourceId: ada.id,
          retryOf: first.id,
        }),
      ),
    )
    expect(again.progress).toBe("not_sent")
    expect((await run(Tasks.use((t) => t.get(first.id)))).task.progress).toBe("started")
  })

  test("a task of the other computer keeps the progress that came with it", async () => {
    const { run, agent, make } = await setup()
    const ada = await agent("Ada")
    const task = await make(ada.id, "p")
    await run(
      Database.use((db) =>
        Effect.sync(() =>
          db.run("UPDATE task SET origin = 'other', progress = 'sent' WHERE id = ?", task.id),
        ),
      ),
    )
    await run(Tasks.use((t) => Effect.sync(() => t.setProgress(task.id, "started"))))
    expect((await run(Tasks.use((t) => t.get(task.id)))).task.progress).toBe("sent")
  })

  test("after a restart, the failed task keeps how far its turn went (spec 005)", async () => {
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
    const make = (prompt: string) =>
      first.runPromise(
        Tasks.use((t) => t.create({ agentId: ada.id, prompt, source: "chat", sourceId: ada.id })),
      )
    const queued = await make("queued")
    const sent = await make("sent")
    const started = await make("started")
    await first.runPromise(
      Tasks.use((t) =>
        Effect.sync(() => {
          t.setProgress(sent.id, "sent")
          t.setProgress(started.id, "started")
        }),
      ),
    )
    await first.runPromise(
      Database.use((db) =>
        Effect.sync(() =>
          db.run("UPDATE task SET state = 'running' WHERE id IN (?, ?)", sent.id, started.id),
        ),
      ),
    )
    await first.dispose()
    const second = open()
    const after = async (id: string) => (await second.runPromise(Tasks.use((t) => t.get(id)))).task
    for (const [id, progress] of [
      [queued.id, "not_sent"],
      [sent.id, "sent"],
      [started.id, "started"],
    ] as const) {
      const task = await after(id)
      expect(task.state).toBe("failed")
      expect(task.error?.code).toBe("app_stopped")
      expect(task.progress).toBe(progress)
    }
    await second.dispose()
  })
})
