import { afterAll, describe, expect, test } from "bun:test"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Providers } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

const sse = (chunks: { delay: number; text: string }[]) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks) {
          await Bun.sleep(c.delay)
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: c.text } }] })}\n\n`,
            ),
          )
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    if (last.includes("SLOW"))
      return sse(Array.from({ length: 100 }, () => ({ delay: 30, text: "tick " })))
    return sse([{ delay: 0, text: `Report: ${last}` }])
  },
})
afterAll(() => server.stop())

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}
const MIN = 60_000

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-routine-test-key",
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
        instructions: "Work.",
        model: { accountId: account.id, model: "mock", effort: null },
      }),
    ),
  )
  const create = (prompt: string, minutes = 2, extra: object = {}) =>
    run(
      Routines.use((r) =>
        r.create({
          serverId: local.id,
          agentId: agent.id,
          name: "Check",
          prompt,
          schedule: { kind: "every", minutes, from: Date.now() },
          place: { kind: "agent" },
          ...extra,
        }),
      ),
    )
  const tick = (now: number) => run(Routines.use((r) => r.tick(now)))
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const idle = () =>
    until(async () =>
      (await tasks()).every((x) => !["queued", "running", "waiting"].includes(x.state)),
    )
  const calendar = () =>
    run(
      Routines.use((r) =>
        r.calendar(local.id, Date.now() - 86_400_000, Date.now() + 86_400_000 * 3),
      ),
    )
  const replies = async () =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages.filter((m) => m.author === "agent")
  return { run, local, agent, create, tick, tasks, idle, calendar, replies }
}

describe("routines", () => {
  test("an every-2-minutes routine runs twice in 5 minutes and posts both results", async () => {
    const s = await setup()
    const routine = await s.create("daily check")
    const start = routine.createdAt
    expect(routine.nextRuns).toHaveLength(3)
    await s.tick(start + 2 * MIN + 1000)
    await s.idle()
    await s.tick(start + 4 * MIN + 1000)
    await s.idle()
    const list = await s.tasks()
    expect(list.filter((t) => t.source === "routine" && t.sourceId === routine.id)).toHaveLength(2)
    expect(list.every((t) => t.state === "done")).toBe(true)
    const replies = await s.replies()
    expect(replies).toHaveLength(2)
    expect(replies[0]?.parts[0]).toMatchObject({ text: "Report: daily check" })
  })

  test("after sleeping through 3 runs, one starts and two show Missed", async () => {
    const s = await setup()
    const routine = await s.create("wake up", 2)
    await s.tick(routine.createdAt + 6 * MIN + 1000)
    await s.idle()
    const entries = (await s.calendar()).filter((e) => e.state !== "planned")
    expect(entries.filter((e) => e.state === "done")).toHaveLength(1)
    expect(entries.filter((e) => e.state === "missed")).toHaveLength(2)
  })

  test("a run does not start while the previous one goes; it shows Skipped", async () => {
    const s = await setup()
    const routine = await s.create("SLOW work", 2)
    await s.tick(routine.createdAt + 2 * MIN + 1000)
    await until(async () => (await s.tasks()).some((t) => t.state === "running"))
    await s.tick(routine.createdAt + 4 * MIN + 1000)
    const entries = await s.calendar()
    expect(entries.filter((e) => e.state === "skipped")).toHaveLength(1)
    expect((await s.tasks()).filter((t) => t.source === "routine")).toHaveLength(1)
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
  })

  test("a paused routine does not run, and resuming does not count the pause as missed", async () => {
    const s = await setup()
    const routine = await s.create("pause me", 2)
    await s.run(Routines.use((r) => r.update(routine.id, { enabled: false })))
    await s.tick(routine.createdAt + 10 * MIN)
    expect(await s.tasks()).toHaveLength(0)
    expect((await s.calendar()).filter((e) => e.state !== "planned")).toHaveLength(0)
    const resumed = await s.run(Routines.use((r) => r.update(routine.id, { enabled: true })))
    expect(resumed.enabled).toBe(true)
    await s.tick(Date.now() + 1000)
    expect(await s.tasks()).toHaveLength(0)
  })

  test("run now starts a run at once; it is refused while one goes", async () => {
    const s = await setup()
    const routine = await s.create("SLOW now", 60)
    await s.run(Routines.use((r) => r.runNow(routine.id)))
    await until(async () => (await s.tasks()).some((t) => t.state === "running"))
    const again = await s.run(Routines.use((r) => r.runNow(routine.id))).then(
      () => "ok",
      (e) => e,
    )
    expect(again).toMatchObject({ code: "routine_running" })
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
  })

  test("bad schedules and foreign agents are refused", async () => {
    const s = await setup()
    const bad = await s.create("x", 2, { schedule: { kind: "cron", expr: "nope" } }).then(
      () => "ok",
      (e) => e,
    )
    expect(bad).toMatchObject({ code: "invalid_schedule" })
  })

  test("a routine can post in a channel the agent belongs to", async () => {
    const s = await setup()
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Ops",
          topic: "",
          memberIds: [s.agent.id],
          leadId: null,
        }),
      ),
    )
    const routine = await s.create("channel check", 2, {
      place: { kind: "channel", channelId: channel.id },
    })
    await s.tick(routine.createdAt + 2 * MIN + 1000)
    await s.idle()
    const task = (await s.tasks()).find((t) => t.source === "routine")
    expect(task?.state).toBe("done")
    const history = await s.run(Channels.use((c) => c.history(channel.id)))
    expect(history.some((m) => m.author === "agent")).toBe(true)
    // An agent outside the channel is refused.
    const other = await s.run(
      Agents.use((a) =>
        a.create({ serverId: s.local.id, name: "Bo", role: "", instructions: "", model: null }),
      ),
    )
    const refused = await s
      .create("x", 2, { agentId: other.id, place: { kind: "channel", channelId: channel.id } })
      .then(
        () => "ok",
        (e) => e,
      )
    expect(refused).toMatchObject({ code: "agent_not_in_channel" })
  })
})
