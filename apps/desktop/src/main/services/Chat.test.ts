import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { messageText, type TaskProgress, taskTimes } from "@robot/shared"
import { Effect, Exit, Layer } from "effect"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Places } from "./Places.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { fakeClock } from "./silence.testing.ts"
import { useClockForTests } from "./silence.ts"
import { Tasks } from "./Tasks.ts"
import { managedRuntime, testPlatform, testRuntime } from "./testing.ts"

const KEY = "sk-chat-test"
let failNext = true
/** The last message of each request that reached the model. */
const asked: string[] = []
/** What the server saw of the requests that it holds with no answer. */
const held = { opened: 0, closed: 0 }

const sse = (chunks: { delay: number; data: unknown }[]) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks) {
          await Bun.sleep(c.delay)
          controller.enqueue(
            enc.encode(`data: ${typeof c.data === "string" ? c.data : JSON.stringify(c.data)}\n\n`),
          )
        }
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const delta = (content: string, extra: object = {}) => ({
  choices: [{ delta: { content, ...extra } }],
})

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    asked.push(last)
    if (last.endsWith("fail") && failNext) {
      failNext = false
      return Response.json({ error: { message: "boom" } }, { status: 500 })
    }
    // A model that shows no sign of life: the answer opens and nothing follows. "partial" sends one
    // part first. The request ends when the app closes the connection.
    if (last.endsWith("hang") || last.endsWith("partial")) {
      held.opened++
      const enc = new TextEncoder()
      req.signal.addEventListener("abort", () => held.closed++)
      return new Response(
        new ReadableStream({
          start(controller) {
            if (last.endsWith("partial"))
              controller.enqueue(enc.encode(`data: ${JSON.stringify(delta("Starting "))}\n\n`))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (last.endsWith("limit")) {
      return Response.json(
        { error: { message: "slow down" } },
        { status: 429, headers: { "retry-after": "60" } },
      )
    }
    if (last.endsWith("slow")) {
      return sse([
        ...Array.from({ length: 40 }, (_, i) => ({ delay: 25, data: delta(`w${i} `) })),
        { delay: 0, data: "[DONE]" },
      ])
    }
    // Thinks at once, and the text that the user sees comes 300 ms later.
    if (last.endsWith("ponder")) {
      return sse([
        { delay: 0, data: { choices: [{ delta: { reasoning_content: "Hmm." } }] } },
        { delay: 300, data: delta("Ready.") },
        { delay: 0, data: "[DONE]" },
      ])
    }
    if (last.endsWith("think")) {
      return sse([
        { delay: 0, data: { choices: [{ delta: { reasoning_content: "Let me see." } }] } },
        { delay: 0, data: delta("Answer.") },
        { delay: 0, data: "[DONE]" },
      ])
    }
    return sse([
      { delay: 0, data: delta(`Echo (${body.messages.length}): `) },
      { delay: 5, data: delta(last.split("\n").at(-1) ?? "") },
      { delay: 0, data: { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } } },
      { delay: 0, data: "[DONE]" },
    ])
  },
})
// Some requests are held with no answer on purpose, so the stop must close them.
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

afterEach(() => useClockForTests(undefined))

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: KEY,
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: { accountId: account.id, model: "mock", effort: null },
      }),
    ),
  )
  const history = () => run(Chat.use((c) => c.history(agent.id)))
  const send = (text: string, replyTo: string | null = null) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo })))
  const settled = () =>
    until(async () => {
      const h = await history()
      return (
        h.messages.length > 0 &&
        h.messages.every((m) => m.status !== "streaming") &&
        h.queue.length === 0
      )
    })
  const setDuringTurn = (duringTurn: "join" | "queue") =>
    run(SettingsStore.use((s) => s.update({ duringTurn })))
  /** Waits until the reply streams, so that the turn runs. */
  const streaming = () =>
    until(async () => messageText((await history()).messages[1] ?? { parts: [] }).length > 0)
  return { ...t, run, agent, local, history, send, settled, setDuringTurn, streaming }
}

describe("Chat", () => {
  test("no two messages of a chat have the same time, so every computer shows them in one order", async () => {
    // A question and its reply are often made in the same millisecond. A computer that syncs gets
    // them in any order, and orders by time (spec 019), so equal times would swap them there.
    const t = await setup()
    for (let i = 0; i < 8; i++) {
      await t.send(`question ${i}`)
      await t.settled()
    }
    const times = (await t.history()).messages.map((m) => m.createdAt)
    expect(times).toHaveLength(16)
    for (let i = 1; i < times.length; i++)
      expect(times[i] as number).toBeGreaterThan(times[i - 1] as number)
  })

  test("a reply streams in and is stored with usage; the place list shows it", async () => {
    const t = await setup()
    await t.send("hello")
    await t.settled()
    const { messages } = await t.history()
    expect(messages.map((m) => [m.author, m.status])).toEqual([
      ["user", "done"],
      ["agent", "done"],
    ])
    expect(messageText(messages[1] as never)).toBe("Echo (2): hello")
    expect(messages[1]?.model).toBe("mock")
    const places = await t.run(Places.use((p) => p.list(t.local.id)))
    const row = places[1]?.places[0]
    expect(row?.lastMessage).toBe("Echo (2): hello")
    expect(row?.unread).toBe(1)
    await t.run(Chat.use((c) => c.markRead(t.agent.id)))
    expect((await t.run(Places.use((p) => p.list(t.local.id))))[1]?.places[0]?.unread).toBe(0)
  })

  test("stop keeps the partial reply marked stopped; the next send works", async () => {
    const t = await setup()
    await t.send("go slow")
    await until(
      async () => messageText((await t.history()).messages[1] ?? { parts: [] }).length > 0,
    )
    await t.run(Chat.use((c) => c.stop(t.agent.id)))
    let { messages } = await t.history()
    expect(messages[1]?.status).toBe("stopped")
    const partial = messageText(messages[1] as never)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial).not.toContain("w39")
    await t.send("again")
    await t.settled()
    ;({ messages } = await t.history())
    expect(messages.map((m) => m.status)).toEqual(["done", "stopped", "done", "done"])
  })

  test("a message sent while the agent works waits in the queue and goes when the turn ends", async () => {
    const t = await setup()
    await t.setDuringTurn("queue")
    await t.send("go slow")
    expect((await t.send("second")).queued).toBe(true)
    const third = await t.send("third")
    expect(third.queued).toBe(true)
    const { queue } = await t.history()
    await t.run(Chat.use((c) => c.removeQueued(t.agent.id, queue[1]?.id ?? "")))
    await t.run(Chat.use((c) => c.updateQueued(t.agent.id, queue[0]?.id ?? "", "second, edited")))
    await t.settled()
    const { messages } = await t.history()
    expect(messages.map((m) => (m.author === "user" ? messageText(m) : m.status))).toEqual([
      "go slow",
      "done",
      "second, edited",
      "done",
    ])
  })

  test("a failed reply shows the reason and can be retried", async () => {
    const t = await setup()
    failNext = true
    await t.send("please fail")
    await t.settled()
    let { messages } = await t.history()
    expect(messages[1]?.status).toBe("failed")
    expect(messages[1]?.error?.code).toBe("provider_error")
    await t.run(Chat.use((c) => c.retry(t.agent.id, messages[1]?.id ?? "")))
    await t.settled()
    ;({ messages } = await t.history())
    expect(messages.map((m) => m.status)).toEqual(["done", "done"])
    // The new turn tries the failed task again, so the Today page drops its row (spec 005, 021).
    const tasks = await t.run(Tasks.use((x) => x.list(t.local.id)))
    const failed = tasks.find((x) => x.state === "failed")
    expect(failed).toBeDefined()
    expect(tasks.find((x) => x.retryOf === failed?.id)?.state).toBe("done")
  })

  // Two taps on Retry (or a tap on the computer and one on the phone) give one reply, not two.
  test("a retry that is asked twice at once makes one new reply", async () => {
    const t = await setup()
    failNext = true
    await t.send("please fail")
    await t.settled()
    const failedId = (await t.history()).messages[1]?.id ?? ""
    const retry = () => t.runtime.runPromiseExit(Chat.use((c) => c.retry(t.agent.id, failedId)))
    const [a, b] = await Promise.all([retry(), retry()])
    await t.settled()
    // Exactly one of the two asks went through; the other found no failed reply to try again.
    expect([a, b].filter((exit) => Exit.isSuccess(exit))).toHaveLength(1)
    const { messages } = await t.history()
    expect(messages.map((m) => m.author)).toEqual(["user", "agent"])
    expect(messages[1]?.status).toBe("done")
    // The same ask again, after the reply is done, is refused too.
    expect(Exit.isFailure(await retry())).toBe(true)
  })

  test("a usage limit fails the turn with the reset time", async () => {
    const t = await setup()
    await t.send("hit the limit")
    await t.settled()
    const reply = (await t.history()).messages[1]
    expect(reply?.error?.code).toBe("provider_limit")
    expect(reply?.error?.resetsAt).toBeGreaterThan(Date.now() + 50_000)
  })

  test("thinking is kept as its own part", async () => {
    const t = await setup()
    await t.send("think")
    await t.settled()
    expect((await t.history()).messages[1]?.parts).toEqual([
      { kind: "thinking", text: "Let me see." },
      { kind: "text", text: "Answer." },
    ])
  })

  test("the first reply counts from the message, and thinking does not count (spec 005)", async () => {
    const t = await setup()
    await t.send("please ponder")
    await t.settled()
    const tasks = () => t.run(Tasks.use((s) => s.list(t.local.id)))
    const [done] = await tasks()
    const times = taskTimes(done as never)
    expect(done?.askedAt).not.toBeNull()
    expect(times.firstReply).toBeGreaterThanOrEqual(290)
    expect(times.total).toBeGreaterThanOrEqual(times.firstReply ?? 0)
    // A failed turn has no first reply. Its retry has its own times, from its own start.
    failNext = true
    await t.send("now fail")
    await t.settled()
    const [failed] = await tasks()
    expect(failed?.state).toBe("failed")
    expect(taskTimes(failed as never).firstReply).toBeNull()
    const reply = (await t.history()).messages.at(-1)
    await t.run(Chat.use((c) => c.retry(t.agent.id, reply?.id ?? "")))
    await t.settled()
    const [retried] = await tasks()
    expect(retried?.id).not.toBe(failed?.id)
    expect(retried?.askedAt).toBeNull()
    expect(taskTimes(retried as never).firstReply).not.toBeNull()
  })

  test("a queued message counts its first reply from when it was sent", async () => {
    const t = await setup()
    await t.setDuringTurn("queue")
    await t.send("go slow")
    const sent = Date.now()
    expect((await t.send("second")).queued).toBe(true)
    await t.settled()
    const [second] = await t.run(Tasks.use((s) => s.list(t.local.id)))
    expect(second?.prompt).toBe("second")
    expect(second?.askedAt).toBeGreaterThanOrEqual(sent - 5)
    expect(second?.askedAt).toBeLessThan(second?.createdAt ?? 0)
  })

  test("editing the last user message replaces the reply", async () => {
    const t = await setup()
    await t.send("first")
    await t.settled()
    const user = (await t.history()).messages[0]
    await t.run(Chat.use((c) => c.edit(t.agent.id, user?.id ?? "", "changed")))
    await t.settled()
    const { messages } = await t.history()
    expect(messages).toHaveLength(2)
    expect(messageText(messages[0] as never)).toBe("changed")
    expect(messages[0]?.editedAt).not.toBeNull()
    expect(messageText(messages[1] as never)).toBe("Echo (2): changed")
  })

  test("a reply quotes the message it answers", async () => {
    const t = await setup()
    await t.send("first")
    await t.settled()
    const reply = (await t.history()).messages[1]
    await t.send("about this", reply?.id ?? null)
    await t.settled()
    const { messages } = await t.history()
    expect(messages[2]?.replyTo).toBe(reply?.id ?? "")
    expect(messageText(messages[3] as never)).toBe("Echo (4): about this")
  })

  test("an agent without a connected account cannot get messages", async () => {
    const t = await setup()
    const accountId = t.agent.model?.accountId ?? ""
    await t.run(Providers.use((p) => p.disconnect(accountId)))
    const exit = await t.runtime.runPromiseExit(
      Chat.use((c) => c.send({ agentId: t.agent.id, text: "hi", replyTo: null })),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("a finished turn ends at started; a turn the server refuses ends at sent (spec 005)", async () => {
    const t = await setup()
    const progressOf = async (index: number) => {
      const reply = (await t.history()).messages[index]
      const task = await t.run(
        Database.use((db) =>
          Effect.sync(() =>
            db.get<{ progress: string }>(
              "SELECT progress FROM task WHERE message_id = ?",
              reply?.id ?? "",
            ),
          ),
        ),
      )
      return task?.progress
    }
    await t.send("hello")
    await t.settled()
    expect(await progressOf(1)).toBe("started")
    await t.send("hit the limit")
    await t.settled()
    expect(await progressOf(3)).toBe("sent")
    // The failed row of the chat gets the same value, for its line (spec 003).
    const { messages } = await t.history()
    expect(messages[1]?.progress).toBeUndefined()
    expect(messages[3]?.status).toBe("failed")
    expect(messages[3]?.progress).toBe("sent")
  })

  const tasksOf = (t: Awaited<ReturnType<typeof setup>>) =>
    t.run(Tasks.use((x) => x.list(t.local.id)))

  const waitForHeld = async (count: number) => {
    await until(async () => held.opened >= count)
  }

  test("a model that shows no sign of life is stopped at the silent limit, and the task fails (spec 005)", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const t = await setup()
    t.shell.focused = false
    await t.run(SettingsStore.use((s) => s.update({ silentLimit: 1 })))
    const before = held.opened
    const closedBefore = held.closed
    await t.send("stay quiet and hang")
    await waitForHeld(before + 1)
    // The request was handed over, and nothing came back.
    expect((await tasksOf(t))[0]?.progress).toBe("sent")
    fake.advance(59_000)
    expect((await tasksOf(t))[0]?.state).toBe("running")
    expect((await t.history()).messages[1]?.status).toBe("streaming")
    fake.advance(1_000)
    await until(async () => (await tasksOf(t))[0]?.state === "failed")
    const task = (await tasksOf(t))[0]
    expect(task?.error).toEqual({ code: "silent_limit_1", detail: "1" })
    expect(task?.progress).toBe("sent")
    const reply = (await t.history()).messages[1]
    expect(reply?.status).toBe("failed")
    expect(reply?.error?.code).toBe("silent_limit_1")
    expect(reply?.progress).toBe("sent")
    // The turn stopped like after a Stop: the connection to the model closed.
    await until(async () => held.closed > closedBefore)
    // One notification of the kind "task failed".
    expect(t.shell.notices).toHaveLength(1)
    // The failed reply can be tried again, and the agent answers the same request.
    const again = await t
      .run(Chat.use((c) => c.retry(t.agent.id, (reply?.id as string) ?? "")))
      .then(
        () => true,
        () => false,
      )
    expect(again).toBe(true)
  })

  test("the limit in minutes comes from the setting when the turn starts", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ silentLimit: 30 })))
    const before = held.opened
    await t.send("quiet hang")
    await waitForHeld(before + 1)
    // A change of the setting does not reach the turn that runs.
    await t.run(SettingsStore.use((s) => s.update({ silentLimit: 1 })))
    fake.advance(29 * 60_000)
    expect((await tasksOf(t))[0]?.state).toBe("running")
    fake.advance(60_000)
    await until(async () => (await tasksOf(t))[0]?.state === "failed")
    expect((await tasksOf(t))[0]?.error).toEqual({ code: "silent_limit", detail: "30" })
  })

  test("with the choice Never a silent turn does not fail by itself; Stop ends it", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ silentLimit: 0 })))
    const before = held.opened
    await t.send("quiet hang")
    await waitForHeld(before + 1)
    fake.advance(48 * 60 * 60_000)
    expect((await tasksOf(t))[0]?.state).toBe("running")
    await t.run(Chat.use((c) => c.stop(t.agent.id)))
    await until(async () => (await tasksOf(t))[0]?.state === "cancelled")
    // A Stop of the user shows no failure and no notice.
    expect((await t.history()).messages[1]?.status).toBe("stopped")
  })

  test("a part of the reply is a sign of life, and the turn goes to started", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ silentLimit: 1 })))
    const before = held.opened
    await t.send("begin the partial")
    await waitForHeld(before + 1)
    await until(async () => (await tasksOf(t))[0]?.progress === "started")
    // The limit counts from the last sign of life.
    fake.advance(59_000)
    expect((await tasksOf(t))[0]?.state).toBe("running")
    fake.advance(1_000)
    await until(async () => (await tasksOf(t))[0]?.state === "failed")
    const task = (await tasksOf(t))[0]
    expect(task?.error?.code).toBe("silent_limit_1")
    expect(task?.progress).toBe("started")
    expect(messageText((await t.history()).messages[1] as never)).toBe("Starting ")
  })

  describe("a request that a restart cut off", () => {
    /** Two runs of the app on one data folder. The key of the account stays, as in a keychain. */
    const restartable = async () => {
      const { platform, dataDir } = testPlatform()
      const file = join(dataDir, "robot.db")
      const keys = new Map<string, string>()
      const secrets = Layer.succeed(
        Secrets,
        Secrets.of({
          get: (key) => keys.get(key) ?? null,
          set: (key, value) => void keys.set(key, value),
          remove: (key) => void keys.delete(key),
        }),
      )
      const open = () =>
        managedRuntime(
          appLayer({ platform, databaseFile: file, localServerName: "T", emit: () => {}, secrets }),
        )
      const first = open()
      const account = await first.runPromise(
        Providers.use((p) =>
          p.connect({
            kind: "custom",
            name: "M",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            apiKey: KEY,
          }),
        ),
      )
      expect(keys.has(secretKey(account.id))).toBe(true)
      const local = await first.runPromise(Servers.use((s) => s.local))
      const agent = await first.runPromise(
        Agents.use((a) =>
          a.create({
            serverId: local.id,
            name: "Ada",
            role: "",
            instructions: "",
            model: { accountId: account.id, model: "mock", effort: null },
          }),
        ),
      )
      const sql = (text: string, ...args: (string | number | null)[]) =>
        first.runPromise(Database.use((db) => Effect.sync(() => db.run(text, ...args))))
      /** A request of the user that the app was working on when it stopped. */
      const cut = async (
        id: string,
        progress: TaskProgress,
        state: "queued" | "running",
        parts = "[]",
      ) => {
        await sql(
          `INSERT INTO message (id, agent_id, author, parts, status, created_at)
           VALUES (?, ?, 'user', ?, 'done', 1)`,
          `u-${id}`,
          agent.id,
          JSON.stringify([{ kind: "text", text: `ask ${id}` }]),
        )
        await sql(
          `INSERT INTO message (id, agent_id, author, parts, status, created_at)
           VALUES (?, ?, 'agent', ?, 'streaming', 2)`,
          `r-${id}`,
          agent.id,
          parts,
        )
        await sql(
          `INSERT INTO task (id, agent_id, prompt, label, source, source_id, message_id, state,
             created_at, progress)
           VALUES (?, ?, ?, ?, 'chat', ?, ?, ?, 2, ?)`,
          `t-${id}`,
          agent.id,
          `ask ${id}`,
          `ask ${id}`,
          agent.id,
          `r-${id}`,
          state,
          progress,
        )
      }
      return { first, open, agent, cut, sql }
    }

    test("the chat tells how far the request went, for each progress", async () => {
      for (const progress of ["not_sent", "sent", "started"] as const) {
        const r = await restartable()
        await r.cut("x", progress, progress === "not_sent" ? "queued" : "running")
        await r.first.dispose()
        const second = r.open()
        const history = await second.runPromise(Chat.use((c) => c.history(r.agent.id)))
        expect(history.cut).toEqual({ taskId: "t-x", messageId: "r-x", progress })
        // The reply that was cut counts as stopped, and the task as failed with the restart reason.
        expect(history.messages.at(-1)?.status).toBe("stopped")
        const task = (await second.runPromise(Tasks.use((x) => x.get("t-x")))).task
        expect(task.error?.code).toBe("app_stopped")
        expect(task.progress).toBe(progress)
        await second.dispose()
      }
    })

    test("a request the user wrote after the restart hides the notice", async () => {
      const r = await restartable()
      await r.cut("x", "started", "running", JSON.stringify([{ kind: "text", text: "Half" }]))
      await r.first.dispose()
      const second = r.open()
      const id = r.agent.id
      expect((await second.runPromise(Chat.use((c) => c.history(id)))).cut).not.toBeNull()
      await second.runPromise(
        Chat.use((c) => c.send({ agentId: id, text: "go on", replyTo: null })),
      )
      await until(async () => {
        const h = await second.runPromise(Chat.use((c) => c.history(id)))
        return h.messages.length === 4 && h.messages.every((m) => m.status !== "streaming")
      })
      expect((await second.runPromise(Chat.use((c) => c.history(id)))).cut).toBeNull()
      await second.dispose()
    })

    test("a Stop of the user is no cut request", async () => {
      const r = await restartable()
      await r.cut("x", "started", "running")
      await r.sql("UPDATE task SET state = 'cancelled' WHERE id = 't-x'")
      await r.sql("UPDATE message SET status = 'stopped' WHERE id = 'r-x'")
      await r.first.dispose()
      const second = r.open()
      expect((await second.runPromise(Chat.use((c) => c.history(r.agent.id)))).cut).toBeNull()
      await second.dispose()
    })

    test("Send again asks the same request in place when it never reached the model", async () => {
      const r = await restartable()
      await r.cut("x", "not_sent", "queued")
      await r.first.dispose()
      const second = r.open()
      const id = r.agent.id
      await second.runPromise(Chat.use((c) => c.retry(id, "r-x")))
      await until(async () => {
        const h = await second.runPromise(Chat.use((c) => c.history(id)))
        return h.messages.length === 2 && h.messages.every((m) => m.status !== "streaming")
      })
      const h = await second.runPromise(Chat.use((c) => c.history(id)))
      // The request was not written twice: the empty reply is gone and a new one answers it.
      expect(h.messages.map((m) => [m.author, m.status])).toEqual([
        ["user", "done"],
        ["agent", "done"],
      ])
      expect(messageText(h.messages[1] as never)).toContain("ask x")
      expect(h.cut).toBeNull()
      // The new task links to the one that the restart ended, and starts at not sent, then goes up.
      const tasks = await second.runPromise(Tasks.use((x) => x.list(r.agent.serverId)))
      const fresh = tasks.find((x) => x.id !== "t-x")
      expect(fresh?.retryOf).toBe("t-x")
      expect(fresh?.progress).toBe("started")
      await second.dispose()
    })

    test("a request that reached the model is not sent again in place", async () => {
      const r = await restartable()
      await r.cut("x", "sent", "running")
      await r.first.dispose()
      const second = r.open()
      const exit = await second.runPromiseExit(Chat.use((c) => c.retry(r.agent.id, "r-x")))
      expect(Exit.isFailure(exit)).toBe(true)
      await second.dispose()
    })
  })
})

describe("messages during a turn (spec 003)", () => {
  test("a message joins the running turn: the agent reads it at the next step, in one reply", async () => {
    const t = await setup()
    await t.send("go slow")
    await t.streaming()
    expect((await t.send("Use b.txt instead")).queued).toBe(false)
    const waiting = (await t.history()).messages.at(-1)
    expect(waiting?.unread).toBe("waiting")
    await t.settled()
    const { messages } = await t.history()
    expect(messages.map((m) => [m.author, m.status])).toEqual([
      ["user", "done"],
      ["agent", "done"],
      ["user", "done"],
    ])
    // The muted line has gone, and no second turn started.
    expect(messages[2]?.unread).toBeUndefined()
    const reply = messageText(messages[1] as never)
    expect(reply).toContain("w39")
    expect(reply).toEndWith("\n\nEcho (4): Use b.txt instead")
    expect(asked.filter((a) => a === "Use b.txt instead")).toHaveLength(1)
    // The task of the turn lists the message.
    const [task] = await t.run(Tasks.use((s) => s.list(t.local.id)))
    expect(await t.run(Tasks.use((s) => s.list(t.local.id)))).toHaveLength(1)
    const detail = await t.run(Tasks.use((s) => s.get(task?.id ?? "")))
    expect(detail.joined.map((j) => j.text)).toEqual(["Use b.txt instead"])
    expect(detail.joined[0]?.at).toBe(messages[2]?.createdAt as number)
  })

  test("a message deleted before the next step never reaches the model", async () => {
    const t = await setup()
    await t.send("go slow")
    await t.streaming()
    await t.send("forget this one")
    const message = (await t.history()).messages.at(-1)
    await t.run(Chat.use((c) => c.deleteUnread(t.agent.id, message?.id ?? "")))
    await t.settled()
    const { messages } = await t.history()
    expect(messages).toHaveLength(2)
    expect(asked.some((a) => a.includes("forget this one"))).toBe(false)
    // A message that the agent read cannot be deleted.
    const exit = await t.runtime.runPromiseExit(
      Chat.use((c) => c.deleteUnread(t.agent.id, messages[0]?.id ?? "")),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("after Stop, the messages that the agent did not read start the next turn as one", async () => {
    const t = await setup()
    await t.send("go slow")
    await t.streaming()
    await t.send("one")
    await t.send("and two")
    await t.run(Chat.use((c) => c.stop(t.agent.id)))
    await t.settled()
    const { messages } = await t.history()
    expect(messages.map((m) => (m.author === "user" ? messageText(m) : m.status))).toEqual([
      "go slow",
      "stopped",
      "one",
      "and two",
      "done",
    ])
    expect(messages.every((m) => m.unread === undefined)).toBe(true)
    expect(messageText(messages[4] as never)).toBe("Echo (4): and two")
    expect(asked.at(-1)).toBe("one\n\nand two")
    const tasks = await t.run(Tasks.use((s) => s.list(t.local.id)))
    expect(tasks[0]?.prompt).toBe("one\n\nand two")
  })

  test("with the queue setting, Send now puts a queued message into the turn", async () => {
    const t = await setup()
    await t.setDuringTurn("queue")
    await t.send("go slow")
    await t.streaming()
    expect((await t.send("now please")).queued).toBe(true)
    const [item] = (await t.history()).queue
    expect((await t.history()).hold).toBeNull()
    await t.run(Chat.use((c) => c.sendNow(t.agent.id, item?.id ?? "")))
    expect((await t.history()).queue).toHaveLength(0)
    await t.settled()
    const { messages } = await t.history()
    expect(messages.map((m) => m.author)).toEqual(["user", "agent", "user"])
    expect(messageText(messages[1] as never)).toEndWith("Echo (4): now please")
  })

  test("a message that comes when the agent is free starts a turn as before", async () => {
    const t = await setup()
    expect((await t.send("hello")).queued).toBe(false)
    await t.settled()
    expect((await t.history()).messages.map((m) => m.unread)).toEqual([undefined, undefined])
  })
})
