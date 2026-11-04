import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { type TaskSource, taskTimes } from "@robot/shared"
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { AppError } from "./errors.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
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

  test("a chat task starts before a routine task that was made first (spec 005, Queue)", async () => {
    const { run, agent, make } = await setup()
    const ada = await agent("Ada")
    const long = await make(ada.id, "long")
    const routine = await run(
      Tasks.use((t) =>
        t.create({ agentId: ada.id, prompt: "routine", source: "routine", sourceId: "r1" }),
      ),
    )
    const chat = await make(ada.id, "chat")
    const gate = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const job = (id: string, name: string) =>
      run(
        Tasks.use((t) =>
          t.run(
            id,
            ada.id,
            Effect.sync(() => order.push(name)),
          ),
        ),
      )
    const one = run(
      Tasks.use((t) =>
        t.run(
          long.id,
          ada.id,
          Deferred.await(gate).pipe(Effect.tap(() => Effect.sync(() => order.push("long")))),
        ),
      ),
    )
    await sleep(20)
    const two = job(routine.id, "routine")
    await sleep(20)
    const three = job(chat.id, "chat")
    await sleep(20)
    await run(Deferred.succeed(gate, undefined))
    await Promise.all([one, two, three])
    expect(order).toEqual(["long", "chat", "routine"])
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

// Spec 005, "Queue": the order, "Run next", the limit of the queue and the slots (S71, S72).
describe("Tasks queue and slots", () => {
  const queueSetup = async (agentsAtOnce: number) => {
    const base = await setup()
    await base.run(SettingsStore.use((s) => s.update({ agentsAtOnce })))
    const makeFrom = (agentId: string, prompt: string, source: TaskSource) =>
      base.run(Tasks.use((t) => t.create({ agentId, prompt, source, sourceId: agentId })))
    /** Starts a task whose work records its prompt and then waits for the gate. */
    const start = (
      task: { id: string; agentId: string; prompt: string },
      order: string[],
      gate?: Deferred.Deferred<void>,
    ) =>
      base.run(
        Tasks.use((t) =>
          t.run(
            task.id,
            task.agentId,
            Effect.gen(function* () {
              order.push(task.prompt)
              if (gate) yield* Deferred.await(gate)
            }),
          ),
        ),
      )
    return { ...base, makeFrom, start }
  }

  test("a task of a normal source starts before a routine, and routines start oldest first", async () => {
    const { run, agent, makeFrom, start } = await queueSetup(1)
    const [ada, bo, cy, di] = [
      await agent("Ada"),
      await agent("Bo"),
      await agent("Cy"),
      await agent("Di"),
    ]
    const gate = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const first = start(await makeFrom(ada.id, "running", "chat"), order, gate)
    await sleep(20)
    const routineOld = start(await makeFrom(bo.id, "routine old", "routine"), order)
    const routineNew = start(await makeFrom(cy.id, "routine new", "workflow"), order)
    const chat = start(await makeFrom(di.id, "chat", "chat"), order)
    await sleep(20)
    await run(Deferred.succeed(gate, undefined))
    await Promise.all([first, routineOld, routineNew, chat])
    expect(order).toEqual(["running", "chat", "routine old", "routine new"])
  })

  test("Run next moves a queued task to the front; the latest pick goes first", async () => {
    const { run, agent, makeFrom, start, state } = await queueSetup(4)
    const ada = await agent("Ada")
    const gate = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const running = await makeFrom(ada.id, "running", "chat")
    const p1 = start(running, order, gate)
    await sleep(20)
    const two = await makeFrom(ada.id, "two", "chat")
    const three = await makeFrom(ada.id, "three", "routine")
    const four = await makeFrom(ada.id, "four", "chat")
    const rest = [start(two, order), start(three, order), start(four, order)]
    await sleep(20)
    await run(Tasks.use((t) => t.runNext(three.id)))
    await run(Tasks.use((t) => t.runNext(four.id)))
    // The running task goes on; a task that is not queued has no "Run next".
    expect(await state(running.id)).toBe("running")
    const refused = await run(Tasks.use((t) => t.runNext(running.id))).catch(
      (e: AppError) => e.code,
    )
    expect(refused).toBe("task_not_queued")
    await run(Deferred.succeed(gate, undefined))
    await Promise.all([p1, ...rest])
    expect(order).toEqual(["running", "four", "three", "two"])
  })

  test("a full slot count makes a task wait; Stop and a higher number start it at once", async () => {
    const { run, agent, makeFrom, state } = await queueSetup(2)
    const [ada, bo, cy] = [await agent("Ada"), await agent("Bo"), await agent("Cy")]
    const a = await makeFrom(ada.id, "a", "chat")
    const b = await makeFrom(bo.id, "b", "chat")
    const c = await makeFrom(cy.id, "c", "chat")
    const runs = [a, b, c].map((task) =>
      run(Tasks.use((t) => t.run(task.id, task.agentId, Effect.never))).catch(() => {}),
    )
    await sleep(30)
    expect(await state(a.id)).toBe("running")
    expect(await state(b.id)).toBe("running")
    expect(await state(c.id)).toBe("queued")
    expect(await run(Tasks.use((t) => Effect.sync(() => t.behindOf(c.id))))).toEqual({
      kind: "slot",
      count: 2,
    })
    // Stop of a task frees its slot at once.
    await run(Tasks.use((t) => t.stop(a.id)))
    await sleep(30)
    expect(await state(a.id)).toBe("cancelled")
    expect(await state(c.id)).toBe("running")

    // A new number applies at once to the tasks that wait.
    const d = await makeFrom(ada.id, "d", "chat")
    runs.push(run(Tasks.use((t) => t.run(d.id, ada.id, Effect.never))).catch(() => {}))
    await sleep(30)
    expect(await state(d.id)).toBe("queued")
    await run(SettingsStore.use((s) => s.update({ agentsAtOnce: 3 })))
    await sleep(30)
    expect(await state(d.id)).toBe("running")
    expect(await state(b.id)).toBe("running")
    for (const task of [b, c, d]) await run(Tasks.use((t) => t.stop(task.id)))
    await Promise.all(runs)
  })

  test("the tasks of a busy agent keep their place, and the next free agent starts", async () => {
    const { run, agent, makeFrom, start } = await queueSetup(2)
    const [ada, bo, cy] = [await agent("Ada"), await agent("Bo"), await agent("Cy")]
    const gateA = Deferred.makeUnsafe<void>()
    const gateB = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const p = [
      start(await makeFrom(ada.id, "a1", "chat"), order, gateA),
      start(await makeFrom(bo.id, "b1", "chat"), order, gateB),
    ]
    await sleep(20)
    p.push(start(await makeFrom(ada.id, "a2", "chat"), order))
    p.push(start(await makeFrom(cy.id, "c1", "chat"), order))
    await sleep(20)
    await run(Deferred.succeed(gateB, undefined))
    await sleep(20)
    expect(order).toEqual(["a1", "b1", "c1"])
    await run(Deferred.succeed(gateA, undefined))
    await Promise.all(p)
    expect(order).toEqual(["a1", "b1", "c1", "a2"])
  })

  test("a task that waits for the user uses no slot, and waits as queued for a slot after the answer", async () => {
    const { run, agent, makeFrom, state } = await queueSetup(1)
    const [ada, bo] = [await agent("Ada"), await agent("Bo")]
    const a = await makeFrom(ada.id, "a", "chat")
    const b = await makeFrom(bo.id, "b", "chat")
    const answer = Deferred.makeUnsafe<void>()
    const gateB = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const pa = run(
      Tasks.use((t) =>
        t.run(
          a.id,
          ada.id,
          Effect.gen(function* () {
            yield* Effect.promise(() => t.setWaiting(a.id, true))
            yield* Deferred.await(answer)
            yield* Effect.promise(() => t.setWaiting(a.id, false))
            order.push("a goes on")
          }),
        ),
      ),
    )
    await sleep(20)
    expect(await state(a.id)).toBe("waiting")
    const pb = run(
      Tasks.use((t) =>
        t.run(
          b.id,
          bo.id,
          Effect.gen(function* () {
            order.push("b")
            yield* Deferred.await(gateB)
          }),
        ),
      ),
    )
    await sleep(20)
    expect(await state(b.id)).toBe("running")
    await run(Deferred.succeed(answer, undefined))
    await sleep(20)
    expect(await state(a.id)).toBe("queued")
    await run(Deferred.succeed(gateB, undefined))
    await Promise.all([pa, pb])
    expect(order).toEqual(["b", "a goes on"])
    expect(await state(a.id)).toBe("done")
  })

  test("a parent that waits for its child uses no slot, also when the number is 1", async () => {
    const { run, agent, makeFrom, make, state } = await queueSetup(1)
    const [ada, bo] = [await agent("Ada"), await agent("Bo")]
    const parent = await makeFrom(ada.id, "parent", "chat")
    const child = await make(bo.id, "child", parent.id)
    await run(
      Tasks.use((t) =>
        t.run(parent.id, ada.id, t.withoutSlot(parent.id, t.run(child.id, bo.id, Effect.void))),
      ),
    )
    expect(await state(child.id)).toBe("done")
    expect(await state(parent.id)).toBe("done")
  })

  test("a turn of a parent that waits takes one slot while it runs and frees it after", async () => {
    const { run, agent, makeFrom, start } = await queueSetup(1)
    const [ada, bo] = [await agent("Ada"), await agent("Bo")]
    const parent = await makeFrom(ada.id, "parent", "chat")
    const other = await makeFrom(bo.id, "other", "chat")
    const gateLook = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const parentRun = run(
      Tasks.use((t) =>
        t.run(
          parent.id,
          ada.id,
          t.withoutSlot(
            parent.id,
            t.withSlot(
              parent.id,
              Effect.gen(function* () {
                order.push("look starts")
                yield* Deferred.await(gateLook)
                order.push("look ends")
              }),
            ),
          ),
        ),
      ),
    )
    await sleep(30)
    // The look holds the only slot, so the task of Bo waits.
    const otherRun = start(other, order)
    await sleep(30)
    expect(order).toEqual(["look starts"])
    await run(Deferred.succeed(gateLook, undefined))
    await Promise.all([parentRun, otherRun])
    expect(order).toEqual(["look starts", "look ends", "other"])
  })

  test("a turn of a parent waits for a free slot, and an interrupt takes no slot", async () => {
    const { run, agent, makeFrom, start, state } = await queueSetup(2)
    const [ada, bo, cy, di] = [
      await agent("Ada"),
      await agent("Bo"),
      await agent("Cy"),
      await agent("Di"),
    ]
    const parent = await makeFrom(ada.id, "parent", "chat")
    const other = await makeFrom(bo.id, "other", "chat")
    const later = await makeFrom(cy.id, "later", "chat")
    const fourth = await makeFrom(di.id, "fourth", "chat")
    const gateOther = Deferred.makeUnsafe<void>()
    const gateLater = Deferred.makeUnsafe<void>()
    const gateStart = Deferred.makeUnsafe<void>()
    const gateEnd = Deferred.makeUnsafe<void>()
    const order: string[] = []
    // The task of Bo holds one slot. The parent runs, gives up its slot, and the task of Cy takes
    // that slot. The look of the parent then waits for a free slot.
    const otherRun = start(other, order, gateOther)
    const parentRun = run(
      Tasks.use((t) =>
        t.run(
          parent.id,
          ada.id,
          t.withoutSlot(
            parent.id,
            Effect.gen(function* () {
              yield* Deferred.await(gateStart)
              // A look that is cut short: it waits for a slot and is interrupted before it has one.
              yield* Effect.timeout(
                t.withSlot(
                  parent.id,
                  Effect.sync(() => order.push("look")),
                ),
                "80 millis",
              ).pipe(Effect.ignore)
              order.push("look cut")
              yield* Deferred.await(gateEnd)
            }),
          ),
        ),
      ),
    )
    await sleep(30)
    const laterRun = start(later, order, gateLater)
    await sleep(30)
    await run(Deferred.succeed(gateStart, undefined))
    await sleep(200)
    expect(order).toEqual(["other", "later", "look cut"])
    // The cut look left the queue: the slot that comes free goes to the next task, not to it.
    await run(Deferred.succeed(gateLater, undefined))
    const fourthRun = start(fourth, order)
    await sleep(60)
    expect(order).toEqual(["other", "later", "look cut", "fourth"])
    expect(await state(parent.id)).toBe("running")
    await run(Deferred.succeed(gateEnd, undefined))
    await run(Deferred.succeed(gateOther, undefined))
    await Promise.all([parentRun, otherRun, laterRun, fourthRun])
    expect(await state(parent.id)).toBe("done")
  })

  test("an agent takes at most 20 queued tasks; a part over the limit is made as Failed", async () => {
    const { run, agent, makeFrom } = await queueSetup(4)
    const ada = await agent("Ada")
    for (let i = 0; i < 19; i++) await makeFrom(ada.id, `t${i}`, "chat")
    expect(await run(Tasks.use((t) => Effect.sync(() => t.queueFull(ada.id))))).toBeNull()
    await makeFrom(ada.id, "t19", "chat")
    const full = await run(Tasks.use((t) => Effect.sync(() => t.queueFull(ada.id))))
    expect(full?.code).toBe("tasks_full")
    expect(full?.detail).toBe("Ada")
    const failed = await run(
      Tasks.use((t) =>
        t.create({
          agentId: ada.id,
          prompt: "over",
          source: "channel",
          sourceId: ada.id,
          failed: { code: "tasks_full", detail: "Ada" },
        }),
      ),
    )
    expect(failed.state).toBe("failed")
    expect(failed.error).toEqual({ code: "tasks_full", detail: "Ada" })
  })
})
