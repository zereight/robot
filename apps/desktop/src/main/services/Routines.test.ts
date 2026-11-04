import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { messageText, ROUTINES_MAX, type Watch } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Notifier } from "./Notifier.ts"
import { Providers } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
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

/** The model of each request, and the text of its last message. */
const requests: { model: string; last: string }[] = []
/** While true, a prompt with BLOCKME gets a reply that ends with a Blocked line (spec 005). */
let blockReplies = false

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { model: string; messages: { content: string }[] }
    requests.push({ model: body.model, last: body.messages.at(-1)?.content ?? "" })
    const last = body.messages.at(-1)?.content ?? ""
    if (blockReplies && last.includes("BLOCKME"))
      return sse([{ delay: 0, text: "I looked.\nBlocked: no access to the folder" }])
    if (last.includes("SLOW"))
      return sse(Array.from({ length: 100 }, () => ({ delay: 30, text: "tick " })))
    return sse([{ delay: 0, text: `Report: ${last}` }])
  },
})
const folders = mkdtempSync(join(tmpdir(), "robot-routines-"))
afterAll(() => {
  server.stop()
  rmSync(folders, { recursive: true, force: true })
})

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
  const asked = async () =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages
      .filter((m) => m.author === "user")
      .map(messageText)
  const watch = (target: Watch["target"], extra: Partial<Watch> = {}, more: object = {}) =>
    run(
      Routines.use((r) =>
        r.create({
          serverId: local.id,
          agentId: agent.id,
          name: "Watcher",
          prompt: "Look at the change.",
          watch: { minutes: 5, target, postUnchanged: false, ...extra },
          place: { kind: "agent" },
          ...more,
        }),
      ),
    )
  const routine = async (id: string) =>
    (await run(Routines.use((r) => r.list(local.id)))).find((r) => r.id === id)
  return {
    t,
    run,
    local,
    agent,
    account,
    create,
    watch,
    routine,
    tick,
    tasks,
    idle,
    calendar,
    replies,
    asked,
  }
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

describe("watch routines", () => {
  test("a folder: the first check does not run; a new file runs it with its name; no change makes no task", async () => {
    const s = await setup()
    const dir = mkdtempSync(join(folders, "inbox-"))
    writeFileSync(join(dir, "old.txt"), "old")
    const r = await s.watch({ kind: "path", path: dir })
    expect(r.schedule).toBeNull()
    expect(r.nextRuns).toEqual([])
    expect(r.nextCheck).not.toBeNull()
    const t0 = Date.now()
    await s.tick(t0)
    expect(await s.tasks()).toHaveLength(0)
    // Not due yet: 5 minutes have not passed.
    writeFileSync(join(dir, "new-report.txt"), "new")
    await s.tick(t0 + 2 * MIN)
    expect(await s.tasks()).toHaveLength(0)
    await s.tick(t0 + 5 * MIN)
    await s.idle()
    const runs = (await s.tasks()).filter((t) => t.source === "routine")
    expect(runs).toHaveLength(1)
    expect(runs[0]?.state).toBe("done")
    const text = (await s.asked()).at(-1) ?? ""
    expect(text.startsWith("Look at the change.")).toBe(true)
    expect(text).toContain("Added: new-report.txt")
    // The next check sees no change: no task, and no line while the switch is off.
    await s.tick(t0 + 10 * MIN)
    await s.idle()
    expect((await s.tasks()).filter((t) => t.source === "routine")).toHaveLength(1)
    expect(await s.replies()).toHaveLength(1)
    // The calendar has the run and no planned runs.
    const entries = await s.calendar()
    expect(entries.map((e) => e.state)).toEqual(["done"])
  })

  test('"Record only": a change starts no task and calls no model; the calendar shows it as Recorded', async () => {
    const s = await setup()
    const dir = mkdtempSync(join(folders, "record-"))
    writeFileSync(join(dir, "old.txt"), "old")
    const r = await s.watch({ kind: "path", path: dir }, { recordOnly: true })
    expect(r.watch?.recordOnly).toBe(true)
    const t0 = Date.now()
    await s.tick(t0)
    writeFileSync(join(dir, "new-report.txt"), "new")
    const asked = requests.length
    await s.tick(t0 + 5 * MIN)
    expect(await s.tasks()).toHaveLength(0)
    expect(requests.length).toBe(asked)
    const entries = await s.calendar()
    expect(entries.map((e) => e.state)).toEqual(["recorded"])
    expect(entries[0]?.change).toContain("Added: new-report.txt")
    expect(entries[0]?.reason ?? null).toBeNull()
    // A recorded run is no failure: the routine stays on.
    expect((await s.routine(r.id))?.enabled).toBe(true)
    expect((await s.routine(r.id))?.pausedAfterFailures ?? null).toBeNull()
    // The switch off again: the next change runs the routine.
    await s.run(
      Routines.use((x) =>
        x.update(r.id, {
          watch: { minutes: 5, target: { kind: "path", path: dir }, postUnchanged: false },
        }),
      ),
    )
    writeFileSync(join(dir, "third.txt"), "3")
    await s.tick(t0 + 10 * MIN)
    await s.idle()
    expect((await s.tasks()).filter((t) => t.source === "routine")).toHaveLength(1)
  })

  test('"Post when nothing changed" posts one muted line with no task', async () => {
    const s = await setup()
    const dir = mkdtempSync(join(folders, "same-"))
    const r = await s.watch({ kind: "path", path: dir }, { postUnchanged: true })
    const t0 = Date.now()
    await s.tick(t0)
    await s.tick(t0 + 5 * MIN)
    const replies = await s.replies()
    expect(replies).toHaveLength(1)
    expect(replies[0]?.parts).toEqual([{ kind: "note", note: "watch_unchanged", routine: r.name }])
    expect(await s.tasks()).toHaveLength(0)
  })

  test("a command that ends with a code that is not 0 is no failure", async () => {
    const s = await setup()
    const r = await s.watch({ kind: "command", command: "cat missing.txt" })
    const t0 = Date.now()
    for (let i = 0; i < 4; i++) await s.tick(t0 + i * 5 * MIN)
    expect((await s.calendar()).filter((e) => e.state === "failed")).toHaveLength(0)
    expect((await s.routine(r.id))?.enabled).toBe(true)
    expect(await s.tasks()).toHaveLength(0)
  })

  test("a path that does not exist fails 3 checks in a row: the routine pauses itself", async () => {
    const s = await setup()
    const r = await s.watch({ kind: "path", path: join(folders, "not-there") })
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) await s.tick(t0 + i * 5 * MIN)
    const failed = (await s.calendar()).filter((e) => e.state === "failed")
    expect(failed).toHaveLength(3)
    expect(failed[0]?.reason?.code).toBe("watch_missing")
    const paused = await s.routine(r.id)
    expect(paused?.enabled).toBe(false)
    expect(paused?.pausedAfterFailures?.code).toBe("watch_missing")
    expect(paused?.nextCheck).toBeNull()
    // No check while paused.
    await s.tick(t0 + 60 * MIN)
    expect((await s.calendar()).filter((e) => e.state === "failed")).toHaveLength(3)
    // Resume sets the count to 0: two more failures do not pause it.
    await s.run(Routines.use((x) => x.update(r.id, { enabled: true })))
    expect((await s.routine(r.id))?.pausedAfterFailures).toBeNull()
    const t1 = Date.now()
    await s.tick(t1)
    await s.tick(t1 + 5 * MIN)
    expect((await s.routine(r.id))?.enabled).toBe(true)
  })

  test("a check waits while the last run goes, then runs once", async () => {
    const s = await setup()
    const dir = mkdtempSync(join(folders, "slow-"))
    const r = await s.watch({ kind: "path", path: dir })
    await s.run(Routines.use((x) => x.update(r.id, { prompt: "SLOW look" })))
    const t0 = Date.now()
    await s.tick(t0)
    writeFileSync(join(dir, "a.txt"), "a")
    await s.tick(t0 + 5 * MIN)
    await until(async () => (await s.tasks()).some((t) => t.state === "running"))
    writeFileSync(join(dir, "b.txt"), "b")
    await s.tick(t0 + 10 * MIN)
    // The check waited: still one task, and nothing was skipped.
    expect((await s.tasks()).filter((t) => t.source === "routine")).toHaveLength(1)
    expect((await s.calendar()).filter((e) => e.state === "skipped")).toHaveLength(0)
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await s.idle()
    await s.tick(t0 + 10 * MIN + 1000)
    await s.idle()
    expect((await s.tasks()).filter((t) => t.source === "routine")).toHaveLength(2)
    expect((await s.asked()).at(-1)).toContain("Added: b.txt")
  })

  test("one trigger only: a schedule and a watch together are refused", async () => {
    const s = await setup()
    const both = await s
      .watch({ kind: "path", path: "x" }, {}, { schedule: { kind: "cron", expr: "* * * * *" } })
      .then(
        () => "ok",
        (e) => e,
      )
    expect(both).toMatchObject({ code: "invalid_schedule" })
    const bad = await s.watch({ kind: "path", path: "x" }, { minutes: 7 }).then(
      () => "ok",
      (e) => e,
    )
    expect(bad).toMatchObject({ code: "invalid_watch" })
  })
})

describe("late runs and the model of a routine", () => {
  test("a run 40 minutes late gets the planned time and the start time", async () => {
    const s = await setup()
    const routine = await s.create("Say good morning", 60)
    await s.tick(routine.createdAt + 100 * MIN)
    await s.idle()
    const text = (await s.asked()).at(-1) ?? ""
    expect(text.startsWith("Say good morning")).toBe(true)
    expect(text).toContain("this run was planned for")
    expect(text).toContain("It runs late.")
  })

  test("a run on time gets the prompt only", async () => {
    const s = await setup()
    const routine = await s.create("On time", 60)
    await s.tick(routine.createdAt + 60 * MIN + 1000)
    await s.idle()
    expect((await s.asked()).at(-1)).toBe("On time")
  })

  test("a routine with its own model uses it, while its agent uses another", async () => {
    const s = await setup()
    const routine = await s.create("Cheap check", 2, {
      model: { accountId: s.account.id, model: "mock-small", effort: null },
    })
    expect(routine.model).toEqual({ accountId: s.account.id, model: "mock-small", effort: null })
    const before = requests.length
    await s.tick(routine.createdAt + 2 * MIN + 1000)
    await s.idle()
    const sent = requests.slice(before)
    expect(sent.map((r) => r.model)).toEqual(["mock-small"])
    // The chat of the agent still uses the model of the agent.
    await s.run(Chat.use((c) => c.send({ agentId: s.agent.id, text: "hello", replyTo: null })))
    await s.idle()
    expect(requests.at(-1)?.model).toBe("mock")
  })

  test("a routine whose model account is not connected fails, and does not use another model", async () => {
    const s = await setup()
    const routine = await s.create("No account", 2, {
      model: { accountId: "gone-account", model: "other", effort: null },
    })
    const before = requests.length
    const t0 = routine.createdAt
    for (let i = 1; i <= 3; i++) await s.tick(t0 + i * 2 * MIN + 1000)
    expect(requests.length).toBe(before)
    const failed = (await s.calendar()).filter((e) => e.state === "failed")
    expect(failed).toHaveLength(3)
    expect(failed[0]?.reason?.code).toBe("provider_not_connected")
    expect((await s.routine(routine.id))?.pausedAfterFailures?.code).toBe("provider_not_connected")
  })
  test("a Blocked run shows Blocked with its reason, and 3 in a row pause the routine (spec 009)", async () => {
    blockReplies = true
    try {
      const s = await setup()
      const routine = await s.create("BLOCKME in the folder", 2)
      const t0 = routine.createdAt
      for (let i = 1; i <= 3; i++) {
        await s.tick(t0 + i * 2 * MIN + 1000)
        await s.idle()
      }
      const runs = (await s.calendar()).filter((e) => e.state === "blocked")
      expect(runs).toHaveLength(3)
      expect(runs[0]?.reason).toEqual({ code: "blocked", detail: "no access to the folder" })
      const paused = await s.routine(routine.id)
      expect(paused?.enabled).toBe(false)
      expect(paused?.pausedAfterFailures).toEqual({
        code: "blocked",
        detail: "no access to the folder",
      })
      // The line stays in the reply, and the task is Blocked.
      expect((await s.tasks()).every((t) => t.state === "blocked")).toBe(true)
      expect(messageText((await s.replies()).at(-1) as never)).toContain("Blocked: no access")
    } finally {
      blockReplies = false
    }
  })

  test("Retry of a blocked run starts a new run that links to the old task (spec 005)", async () => {
    blockReplies = true
    try {
      const s = await setup()
      const routine = await s.create("BLOCKME in the folder", 2)
      await s.tick(routine.createdAt + 2 * MIN + 1000)
      await s.idle()
      const [blocked] = await s.tasks()
      expect(blocked?.state).toBe("blocked")
      const result = await s.run(Tasks.use((t) => t.retry(blocked?.id ?? "", { confirmed: true })))
      expect(result.started).toBe(true)
      await until(async () => (await s.tasks()).length === 2)
      await s.idle()
      expect((await s.tasks()).find((t) => t.id !== blocked?.id)?.retryOf).toBe(blocked?.id)
    } finally {
      blockReplies = false
    }
  })

  test("a blocked run counts as a failed run: a Done run in between sets the count to 0", async () => {
    const s = await setup()
    const routine = await s.create("BLOCKME in the folder", 2)
    const t0 = routine.createdAt
    const round = async (n: number, blocked: boolean) => {
      blockReplies = blocked
      await s.tick(t0 + n * 2 * MIN + 1000)
      await s.idle()
    }
    try {
      await round(1, true)
      await round(2, true)
      await round(3, false)
      await round(4, true)
      expect((await s.tasks()).map((t) => t.state).sort()).toEqual([
        "blocked",
        "blocked",
        "blocked",
        "done",
      ])
      // Two blocked runs, one Done, one blocked: the routine is not paused.
      const after = await s.routine(routine.id)
      expect(after?.enabled).toBe(true)
      expect(after?.pausedAfterFailures).toBeNull()
    } finally {
      blockReplies = false
    }
  })

  test("a reply with no Blocked line ends the run as Done", async () => {
    const s = await setup()
    const routine = await s.create("BLOCKME in the folder", 2)
    await s.tick(routine.createdAt + 2 * MIN + 1000)
    await s.idle()
    expect((await s.tasks()).map((t) => t.state)).toEqual(["done"])
  })
})

describe("routine limits (spec 009)", () => {
  /** The refusal of `create`, or undefined when it worked. */
  const refusal = (s: Awaited<ReturnType<typeof setup>>, over: object = {}) =>
    s.run(
      Routines.use((r) =>
        r
          .create({
            serverId: s.local.id,
            agentId: s.agent.id,
            name: "One more",
            prompt: "Look.",
            schedule: { kind: "daily", times: ["09:00"] },
            place: { kind: "agent" },
            ...over,
          })
          .pipe(
            Effect.map(() => undefined),
            Effect.catch((e) => Effect.succeed(e)),
          ),
      ),
    )
  const fill = async (s: Awaited<ReturnType<typeof setup>>, count: number) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++)
      ids.push(
        (
          await s.run(
            Routines.use((r) =>
              r.create({
                serverId: s.local.id,
                agentId: s.agent.id,
                name: `R${i}`,
                prompt: "Look.",
                schedule: { kind: "daily", times: ["09:00"] },
                place: { kind: "agent" },
              }),
            ),
          )
        ).id,
      )
    return ids
  }
  const count = async (s: Awaited<ReturnType<typeof setup>>) =>
    (await s.run(Routines.use((r) => r.list(s.local.id)))).length

  test("with 50 routines the 51st is refused, with the limit as its reason; delete one and it works", async () => {
    const s = await setup()
    expect(ROUTINES_MAX).toBe(50)
    const ids = await fill(s, 50)
    const error = await refusal(s)
    expect(error).toMatchObject({ code: "routines_full", detail: "50" })
    expect(await count(s)).toBe(50)
    await s.run(Routines.use((r) => r.remove(ids[0] ?? "")))
    expect(await refusal(s)).toBeUndefined()
    expect(await count(s)).toBe(50)
    expect(await refusal(s)).toMatchObject({ code: "routines_full" })
  })

  test("a paused routine and a watch count in the limit", async () => {
    const s = await setup()
    const ids = await fill(s, 49)
    // The 50th is a watch that starts paused.
    await s.run(
      Routines.use((r) =>
        r.create(
          {
            serverId: s.local.id,
            agentId: s.agent.id,
            name: "Watcher",
            prompt: "Look.",
            watch: { minutes: 60, target: { kind: "path", path: "x.txt" }, postUnchanged: false },
            place: { kind: "agent" },
          },
          { paused: true },
        ),
      ),
    )
    expect(await refusal(s)).toMatchObject({ code: "routines_full" })
    // Pausing the others changes nothing.
    for (const id of ids) await s.run(Routines.use((r) => r.update(id, { enabled: false })))
    expect(await refusal(s)).toMatchObject({ code: "routines_full" })
  })

  test("an edit of a routine, and Resume, are not refused at 50", async () => {
    const s = await setup()
    const ids = await fill(s, 50)
    const first = ids[0] ?? ""
    const edited = await s.run(Routines.use((r) => r.update(first, { name: "Renamed" })))
    expect(edited.name).toBe("Renamed")
    await s.run(Routines.use((r) => r.update(first, { enabled: false })))
    await s.run(Routines.use((r) => r.update(first, { enabled: true })))
    expect(await count(s)).toBe(50)
  })

  test("a refused routine makes no row", async () => {
    const s = await setup()
    await fill(s, 50)
    await refusal(s)
    await refusal(s)
    expect(await count(s)).toBe(50)
  })
})

describe("a routine that pauses itself (spec 009, Repeated failure)", () => {
  const notices = (s: Awaited<ReturnType<typeof setup>>) => s.t.shell.notices

  test("the third failed run pauses it: one notice says so, the fourth run does not start, Resume goes on", async () => {
    blockReplies = true
    try {
      const s = await setup()
      s.t.shell.focused = false
      const routine = await s.create("BLOCKME in the folder", 2)
      const t0 = routine.createdAt
      for (let i = 1; i <= 3; i++) {
        await s.tick(t0 + i * 2 * MIN + 1000)
        await s.idle()
      }
      // A failed run that does not pause the routine has its own notice. The third failed run has
      // only the notice that says the routine is paused, not two notices.
      expect(notices(s).map((n) => n.title)).toEqual(["Ada", "Ada", "Ada"])
      expect(notices(s)[0]?.body).not.toContain("paused")
      expect(notices(s)[1]?.body).not.toContain("paused")
      expect(notices(s)[2]?.body).toBe("Check is paused after 3 failed runs.")
      const paused = await s.routine(routine.id)
      expect(paused?.enabled).toBe(false)
      expect(paused?.pausedAfterFailures?.code).toBe("blocked")

      // The fourth run does not start, and no notice comes for it.
      await s.tick(t0 + 4 * 2 * MIN + 1000)
      await s.idle()
      expect(await s.tasks()).toHaveLength(3)
      expect(notices(s)).toHaveLength(3)

      // Resume starts the checks again, and the count of failed runs starts at 0.
      await s.run(Routines.use((r) => r.update(routine.id, { enabled: true })))
      const resumed = await s.routine(routine.id)
      expect(resumed?.enabled).toBe(true)
      expect(resumed?.pausedAfterFailures).toBeNull()
      await s.tick(Date.now() + 2 * MIN + 1000)
      await s.idle()
      expect(await s.tasks()).toHaveLength(4)
      // One failed run after the resume does not pause it.
      expect((await s.routine(routine.id))?.enabled).toBe(true)
    } finally {
      blockReplies = false
    }
  })

  test("runs that cannot start make no task, and the third failure still sends the one notice", async () => {
    const s = await setup()
    s.t.shell.focused = false
    const routine = await s.create("No account", 2, {
      model: { accountId: "gone-account", model: "other", effort: null },
    })
    for (let i = 1; i <= 3; i++) await s.tick(routine.createdAt + i * 2 * MIN + 1000)
    expect(notices(s)).toHaveLength(1)
    expect(notices(s)[0]?.body).toBe("Check is paused after 3 failed runs.")
    // The fourth run does not start: no new failed entry in the calendar.
    await s.tick(routine.createdAt + 4 * 2 * MIN + 1000)
    expect((await s.calendar()).filter((e) => e.state === "failed")).toHaveLength(3)
    expect(notices(s)).toHaveLength(1)
    // Resume starts the checks again.
    await s.run(Routines.use((r) => r.update(routine.id, { enabled: true })))
    await s.tick(Date.now() + 2 * MIN + 1000)
    expect((await s.calendar()).filter((e) => e.state === "failed")).toHaveLength(4)
    expect((await s.routine(routine.id))?.enabled).toBe(true)
  })

  test("the notice is in the language of the interface", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(SettingsStore.use((x) => x.update({ language: "ko" })))
    const routine = await s.create("No account", 2, {
      model: { accountId: "gone-account", model: "other", effort: null },
    })
    for (let i = 1; i <= 3; i++) await s.tick(routine.createdAt + i * 2 * MIN + 1000)
    expect(notices(s)).toHaveLength(1)
    expect(notices(s)[0]?.body).toBe("Check이(가) 3번 연속 실패해서 일시 중지됐어요.")
  })

  test("a notice names the routine paused, and a muted server gets none", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(Notifier.use((n) => n.setMute("server", s.local.id, "1h")))
    const routine = await s.create("No account", 2, {
      model: { accountId: "gone-account", model: "other", effort: null },
    })
    for (let i = 1; i <= 3; i++) await s.tick(routine.createdAt + i * 2 * MIN + 1000)
    expect(notices(s)).toHaveLength(0)
    expect((await s.routine(routine.id))?.enabled).toBe(false)
  })

  test("a Skipped run and a Cancelled run do not change the count: two failures, both, one failure pause it", async () => {
    const s = await setup()
    const routine = await s.create("BLOCKME SLOW", 2)
    const t0 = routine.createdAt
    const round = async (n: number, blocked: boolean) => {
      blockReplies = blocked
      await s.tick(t0 + n * 2 * MIN + 1000)
    }
    try {
      await round(1, true)
      await s.idle()
      await round(2, true)
      await s.idle()
      // A slow run goes. The next check finds it running: it is Skipped.
      await round(3, false)
      await until(async () => (await s.tasks()).some((x) => x.state === "running"))
      await round(4, false)
      expect((await s.calendar()).filter((e) => e.state === "skipped")).toHaveLength(1)
      // The user stops the slow run: it is Cancelled.
      await s.run(Chat.use((c) => c.stop(s.agent.id)))
      await s.idle()
      expect((await s.routine(routine.id))?.enabled).toBe(true)
      // The third failed run pauses it, as if the Skipped and the Cancelled run were not there.
      await round(5, true)
      await s.idle()
      expect((await s.tasks()).map((x) => x.state).sort()).toEqual([
        "blocked",
        "blocked",
        "blocked",
        "cancelled",
      ])
      expect((await s.routine(routine.id))?.enabled).toBe(false)
    } finally {
      blockReplies = false
    }
  })

  test("a run of Run now that fails counts like a run of the schedule", async () => {
    blockReplies = true
    try {
      const s = await setup()
      const routine = await s.create("BLOCKME in the folder", 2)
      for (let i = 1; i <= 3; i++) {
        await s.run(Routines.use((r) => r.runNow(routine.id)))
        await s.idle()
      }
      expect((await s.routine(routine.id))?.enabled).toBe(false)
      expect((await s.routine(routine.id))?.pausedAfterFailures?.code).toBe("blocked")
    } finally {
      blockReplies = false
    }
  })

  test("an edit of the prompt, the trigger, the agent or the place sets the count to 0", async () => {
    blockReplies = true
    try {
      const s = await setup()
      const routine = await s.create("BLOCKME in the folder", 2)
      const fail = async (n: number) => {
        await s.tick(Date.now() + n * 2 * MIN + 1000)
        await s.idle()
      }
      await fail(1)
      await fail(2)
      // Two failed runs, then an edit of the prompt: the next failed run is the first of three.
      await s.run(Routines.use((r) => r.update(routine.id, { prompt: "BLOCKME again" })))
      await fail(3)
      expect((await s.routine(routine.id))?.enabled).toBe(true)
      await fail(4)
      expect((await s.routine(routine.id))?.enabled).toBe(true)
      await fail(5)
      expect((await s.routine(routine.id))?.enabled).toBe(false)
    } finally {
      blockReplies = false
    }
  })
})
