import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChannelMessage } from "@robot/shared"
import { Effect } from "effect"
import { Activity } from "./Activity.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Decision } from "./Decision.ts"
import { Handbook } from "./Handbook.ts"
import { Memory } from "./Memory.ts"
import { PlaceMarks } from "./PlaceMarks.ts"
import { Places } from "./Places.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { fakeClock } from "./silence.testing.ts"
import { useClockForTests } from "./silence.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

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
const delta = (content: string) => ({ choices: [{ delta: { content } }] })

const plan = (parts: { member: string; label: string; prompt: string }[]) =>
  JSON.stringify({ plan: "Split in parts", parts })

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      messages: { role: string; content: string }[]
      tools?: unknown[]
    }
    const lastMessage = body.messages.at(-1)
    if (lastMessage?.role === "tool")
      return sse([
        { delay: 0, data: delta(`Tool result: ${lastMessage.content}`) },
        { delay: 0, data: "[DONE]" },
      ])
    const call = /TOOL (\w+) (\{.*\})/.exec(lastMessage?.content ?? "")
    if (call && body.tools)
      return sse([
        {
          delay: 0,
          data: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: call[1], arguments: call[2] } },
                  ],
                },
              },
            ],
          },
        },
        { delay: 0, data: "[DONE]" },
      ])
    const last = (body.messages.at(-1)?.content ?? "").split("\n").at(-1) ?? ""
    if (last.includes("FAIL")) return Response.json({ error: { message: "boom" } }, { status: 500 })
    // A model that shows no sign of life: the answer opens and nothing follows.
    if (last.includes("HANG"))
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
    let reply = `Echo: ${last}`
    if (last.includes("split two"))
      reply = plan([
        { member: "Bo", label: "Intro", prompt: "Write the intro" },
        { member: "Cy", label: "Facts", prompt: "Check the facts" },
      ])
    if (last.includes("split fail"))
      reply = plan([
        { member: "Bo", label: "Fine", prompt: "Do it" },
        { member: "Cy", label: "Broken", prompt: "FAIL it" },
      ])
    if (last.includes("split memory"))
      reply = plan([
        {
          member: "Bo",
          label: "Remember",
          prompt: `TOOL save_memory ${JSON.stringify({ text: "Bo answers yes" })}`,
        },
      ])
    if (last.includes("split slow"))
      reply = plan([{ member: "Bo", label: "Slow work", prompt: "SLOW work" }])
    const slow = last.includes("SLOW")
    return sse([
      ...(slow
        ? Array.from({ length: 80 }, () => ({ delay: 40, data: delta("tick ") }))
        : [{ delay: 0, data: delta(reply) }]),
      { delay: 0, data: { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } } },
      { delay: 0, data: "[DONE]" },
    ])
  },
})
// Some requests are held with no answer on purpose, so the stop must close them.
afterAll(() => server.stop(true))

// The service of the decision model (spec 013): what it was asked, and what it answers next.
const DECISION_KEY = "sk-or-channel-test-key"
const asked: { auth: string | null; body: string }[] = []
let decide: () => Response = () => new Response("none set", { status: 500 })
const decisionServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    asked.push({ auth: req.headers.get("authorization"), body: await req.text() })
    return decide()
  },
})
afterAll(() => decisionServer.stop(true))
/** An answer of the model for the options of a channel: the members in order, then "none". */
const picks = (choice: string, probability: number) =>
  Response.json({
    answers: {
      pick: {
        type: "choice",
        choice,
        confidence: probability,
        probabilities: {
          member_1: choice === "member_1" ? probability : (1 - probability) / 3,
          member_2: choice === "member_2" ? probability : (1 - probability) / 3,
          member_3: choice === "member_3" ? probability : (1 - probability) / 3,
          none: choice === "none" ? probability : (1 - probability) / 3,
        },
      },
    },
  })

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const setup = async (options: { lead?: boolean; decision?: boolean } = { lead: true }) => {
  const t = testRuntime(
    options.decision ? { decisionUrl: `http://127.0.0.1:${decisionServer.port}` } : {},
  )
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-channel-test-key",
      }),
    ),
  )
  if (options.decision) {
    await run(SettingsStore.use((x) => x.update({ decisionModel: "openrouter" })))
    await run(Decision.use((d) => d.keys({ openrouter: DECISION_KEY })))
    asked.length = 0
  }
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: `You are ${name}.`,
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  const [lead, bo, cy] = await Promise.all([agent("Lia"), agent("Bo"), agent("Cy")])
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId: local.id,
        name: "Launch",
        topic: "Ship it",
        memberIds: [lead.id, bo.id, cy.id],
        leadId: options.lead === false ? null : lead.id,
      }),
    ),
  )
  const history = () => run(Channels.use((c) => c.history(channel.id)))
  const send = (text: string) => run(Channels.use((c) => c.send(channel.id, text)))
  const idle = () =>
    until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      return all.length > 0 && all.every((x) => !["queued", "running"].includes(x.state))
    })
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  return {
    run,
    local,
    lead,
    bo,
    cy,
    channel,
    history,
    send,
    idle,
    tasks,
    runtime: t.runtime,
    dataDir: t.dataDir,
  }
}

const kinds = (list: readonly ChannelMessage[]) => list.map((m) => `${m.author}:${m.kind}`)

afterEach(() => useClockForTests(undefined))

describe("channel jobs", () => {
  test("the lead splits a job; members reply under their name; one summary ends it", async () => {
    const s = await setup()
    expect(await s.send("split two things")).toEqual({ awaiting: false })
    await s.idle()
    const list = await s.history()
    expect(kinds(list)).toEqual([
      "user:text",
      "agent:plan",
      "agent:text",
      "agent:text",
      "agent:summary",
    ])
    const planMessage = list[1] as ChannelMessage
    expect(planMessage.agentId).toBe(s.lead.id)
    expect(planMessage.parts[0]).toMatchObject({ text: expect.stringContaining("1. Bo: Intro") })
    expect(planMessage.chips.map((c) => [c.memberName, c.label, c.state, c.replies])).toEqual([
      ["Bo", "Intro", "done", 1],
      ["Cy", "Facts", "done", 1],
    ])
    const newest = planMessage.chips[0]?.newestReplyId
    expect(list.find((m) => m.id === newest)?.agentId).toBe(s.bo.id)
    expect(
      list
        .map((m) => m.agentId)
        .slice(2, 4)
        .sort(),
    ).toEqual([s.bo.id, s.cy.id].sort())
    expect(list[4]?.agentId).toBe(s.lead.id)

    const tasks = await s.tasks()
    expect(tasks).toHaveLength(3)
    expect(tasks.every((t) => t.state === "done" && t.source === "channel")).toBe(true)
    expect(tasks.filter((t) => t.parentId !== null)).toHaveLength(2)
    const sections = await s.run(Places.use((p) => p.list(s.local.id)))
    expect(sections[0]?.places[0]).toMatchObject({
      kind: "channel",
      name: "Launch",
      working: false,
    })
    expect(sections[0]?.places[0]?.unread).toBeGreaterThan(0)
  })

  test("a failed part shows its error, and the lead still sums up", async () => {
    const s = await setup()
    await s.send("split fail now")
    await s.idle()
    const list = await s.history()
    const failed = list.find((m) => m.status === "failed")
    expect(failed?.agentId).toBe(s.cy.id)
    expect(failed?.error?.code).toBe("provider_error")
    expect(list.at(-1)?.kind).toBe("summary")
    const parts = (await s.tasks()).filter((t) => t.parentId !== null)
    expect(parts.map((t) => t.state).sort()).toEqual(["done", "failed"])
    // The summary asked for the facts about the failure.
    expect(list.at(-1)?.status).toBe("done")
  })

  test("a part that shows no sign of life fails at the silent limit, with how far it went (spec 005)", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ silentLimit: 1 })))
    await s.send("@bo HANG here")
    await until(async () => (await s.tasks())[0]?.progress === "sent")
    fake.advance(59_000)
    expect((await s.tasks())[0]?.state).toBe("running")
    fake.advance(1_000)
    await until(async () => (await s.tasks())[0]?.state === "failed")
    const task = (await s.tasks())[0]
    expect(task?.error).toEqual({ code: "silent_limit_1", detail: "1" })
    const failed = (await s.history()).find((m) => m.status === "failed")
    expect(failed?.error?.code).toBe("silent_limit_1")
    expect(failed?.progress).toBe("sent")
  })

  test("a part that shows no sign of life is quiet; the plan step finds it by the task (spec 005, 004)", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ silentLimit: 10 })))
    await s.send("@bo HANG here")
    await until(async () => (await s.tasks())[0]?.progress === "sent")
    const quiet = () => s.run(Activity.use((a) => Effect.sync(() => a.quietTurns().turns)))
    fake.advance(89_000)
    expect(await quiet()).toEqual([])
    fake.advance(1_000)
    const turns = await quiet()
    const task = (await s.tasks())[0]
    expect(turns).toHaveLength(1)
    // The turn names the task, the member, and the channel that it belongs to. A channel part is
    // not the turn of a chat.
    expect(turns[0]).toMatchObject({
      taskId: task?.id,
      agentId: s.bo.id,
      threadId: null,
      source: "channel",
      sourceId: s.channel.id,
      name: "M",
    })
    expect(task?.state).toBe("running")
    // Stop ends the turn, and the line goes with it.
    await s.run(Channels.use((c) => c.stopAll(s.channel.id)))
    await until(async () => (await quiet()).length === 0)
  })

  test("an ordinary answer of the lead is no plan", async () => {
    const s = await setup()
    await s.send("hello team")
    await s.idle()
    expect(kinds(await s.history())).toEqual(["user:text", "agent:text"])
  })

  test("@Name sends the message to that member only", async () => {
    const s = await setup()
    await s.send("@bo say hi")
    await s.idle()
    const list = await s.history()
    expect(kinds(list)).toEqual(["user:text", "agent:text"])
    expect(list[1]?.agentId).toBe(s.bo.id)
    expect((await s.tasks()).map((t) => t.agentId)).toEqual([s.bo.id])
  })

  test("@all gives every member its own task, and the lead does not read it first", async () => {
    const s = await setup()
    await s.send("@all say hi")
    await s.idle()
    const list = await s.history()
    // The lead is a member too: it answers as a member, and it makes no plan.
    expect(kinds(list)).toEqual(["user:text", "agent:text", "agent:text", "agent:text"])
    expect(
      list
        .slice(1)
        .map((m) => m.agentId)
        .sort(),
    ).toEqual([s.lead.id, s.bo.id, s.cy.id].sort())
    const tasks = await s.tasks()
    expect(tasks).toHaveLength(3)
    expect(tasks.every((t) => t.source === "channel" && t.parentId === null)).toBe(true)
  })

  test("@all wins over a name, and it works with no lead and in any letter case", async () => {
    const s = await setup({ lead: false })
    expect(await s.send("hey @ALL, and @bo too")).toEqual({ awaiting: false })
    await s.idle()
    // Bo is named and called by @all: it gets one task, not two.
    expect((await s.tasks()).map((t) => t.agentId).sort()).toEqual(
      [s.lead.id, s.bo.id, s.cy.id].sort(),
    )
    expect((await s.history()).filter((m) => m.author === "agent")).toHaveLength(3)
  })

  test("@all skips an archived member, and a word that only starts with @all is no mention", async () => {
    const s = await setup()
    await s.run(Agents.use((a) => a.archive(s.cy.id)))
    await s.send("@all say hi")
    await s.idle()
    expect((await s.tasks()).map((t) => t.agentId).sort()).toEqual([s.lead.id, s.bo.id].sort())

    // "@allan" is plain text: the lead reads the job, as for any job with no mention.
    await s.send("@allan please")
    await until(async () => (await s.tasks()).length === 3)
    await s.idle()
    expect((await s.tasks()).filter((t) => t.agentId === s.lead.id)).toHaveLength(2)
  })

  test("@all with no member that can answer fails, and the message stays out", async () => {
    const s = await setup()
    for (const agent of [s.lead, s.bo, s.cy]) await s.run(Agents.use((a) => a.archive(agent.id)))
    const failure = await s.run(
      Channels.use((c) => c.send(s.channel.id, "@all hi")).pipe(Effect.flip),
    )
    expect(failure.code).toBe("channel_empty")
    expect(await s.history()).toHaveLength(0)
  })

  test("without a lead and a mention, the user picks who takes the job", async () => {
    const s = await setup({ lead: false })
    expect(await s.send("who does this")).toEqual({ awaiting: true })
    let list = await s.history()
    expect(list).toHaveLength(1)
    expect(list[0]?.awaiting).toBe(true)
    await s.run(Channels.use((c) => c.assign(s.channel.id, list[0]?.id ?? "", s.cy.id)))
    await s.idle()
    list = await s.history()
    expect(list[0]?.awaiting).toBe(false)
    expect(list[1]?.agentId).toBe(s.cy.id)
    const again = await s.run(
      Channels.use((c) => c.assign(s.channel.id, list[0]?.id ?? "", s.cy.id)).pipe(Effect.flip),
    )
    expect(again.code).toBe("job_already_taken")
  })

  test("stopping the channel cancels the running parts and no summary follows", async () => {
    const s = await setup()
    await s.send("split slow job")
    await until(async () => (await s.tasks()).some((t) => t.state === "running" && t.parentId))
    const activity = await s.run(Channels.use((c) => c.activity(s.channel.id)))
    const leadCard = activity.members.find((m) => m.agentId === s.lead.id)
    expect(leadCard?.steps.map((x) => [x.label, x.state])).toEqual([["Slow work", "running"]])
    expect(activity.members.find((m) => m.agentId === s.bo.id)?.state).toBe("working")
    // A member that works cannot be removed.
    const refused = await s.run(
      Channels.use((c) => c.update(s.channel.id, { memberIds: [s.lead.id, s.cy.id] })).pipe(
        Effect.flip,
      ),
    )
    expect(refused.code).toBe("member_working")

    await s.run(Channels.use((c) => c.stopAll(s.channel.id)))
    await s.idle()
    const tasks = await s.tasks()
    expect(tasks.every((t) => t.state === "cancelled")).toBe(true)
    expect(kinds(await s.history())).not.toContain("agent:summary")
    // The steps leave the panel when the work ends.
    const after = await s.run(Channels.use((c) => c.activity(s.channel.id)))
    expect(after.members.every((m) => m.steps.length === 0)).toBe(true)
    // Now the member can be removed.
    const next = await s.run(
      Channels.use((c) => c.update(s.channel.id, { memberIds: [s.lead.id, s.cy.id] })),
    )
    expect(next.memberIds).toEqual([s.lead.id, s.cy.id])
  })
})

describe("channel settings", () => {
  test("names are unique, the lead is a member, and removing the lead clears it", async () => {
    const s = await setup()
    const dup = await s.run(
      Channels.use((c) =>
        c.create({ serverId: s.local.id, name: "launch", topic: "", memberIds: [], leadId: null }),
      ).pipe(Effect.flip),
    )
    expect(dup.code).toBe("channel_name_taken")
    const badLead = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Other",
          topic: "",
          memberIds: [s.bo.id],
          leadId: s.cy.id,
        }),
      ).pipe(Effect.flip),
    )
    expect(badLead.code).toBe("invalid_lead")
    const updated = await s.run(
      Channels.use((c) =>
        c.update(s.channel.id, { memberIds: [s.bo.id, s.cy.id], topic: " New " }),
      ),
    )
    expect(updated).toMatchObject({ topic: "New", leadId: null, memberIds: [s.bo.id, s.cy.id] })
    await s.run(Channels.use((c) => c.remove(s.channel.id)))
    expect(await s.run(Channels.use((c) => c.list(s.local.id)))).toEqual([])
  })
})

describe("tools in channels", () => {
  test("a member writes a file in its workspace and the card shows in the channel", async () => {
    const s = await setup({ lead: false })
    await s.send(`@Bo TOOL write_file ${JSON.stringify({ path: "out.txt", content: "hi" })}`)
    await s.idle()
    const list = await s.history()
    const reply = list.find((m) => m.author === "agent")
    const part = reply?.parts.find((p) => p.kind === "tool")
    expect(part).toMatchObject({ name: "write_file", state: "done" })
    expect(readFileSync(join(s.bo.workspace, "out.txt"), "utf8")).toBe("hi")
  })

  test("a risky step waits for the user; the task shows waiting; stop ends it", async () => {
    const s = await setup({ lead: false })
    await s.send(`@Bo TOOL run_command ${JSON.stringify({ command: "sudo ls" })}`)
    await until(async () => (await s.tasks()).some((t) => t.state === "waiting"))
    const waiting = (await s.history())
      .find((m) => m.author === "agent")
      ?.parts.find((p) => p.kind === "tool")
    expect(waiting).toMatchObject({ state: "waiting", ask: { kind: "approval" } })
    await s.run(Channels.use((c) => c.stopAll(s.channel.id)))
    await s.idle()
    const ended = (await s.history()).find((m) => m.author === "agent")
    expect(ended?.status).toBe("stopped")
    expect(ended?.parts.find((p) => p.kind === "tool")).toMatchObject({ state: "failed" })
  })

  // Spec 007, "Outside content": a part of a channel job holds outside content from its start only
  // when the job came from an outside program, or when the lead held outside content before it
  // made the part. The message of the lead that makes the part is not outside content by itself.
  test("a part of a job of the user holds no outside content: a memory save runs", async () => {
    const s = await setup()
    await s.send("split memory")
    await s.idle()
    expect((await s.tasks()).some((t) => t.state === "waiting")).toBe(false)
    expect((await s.run(Memory.use((m) => m.list(s.bo.id)))).map((i) => i.text)).toEqual([
      "Bo answers yes",
    ])
    const card = (await s.history())
      .find((m) => m.agentId === s.bo.id)
      ?.parts.find((p) => p.kind === "tool")
    expect(card).toMatchObject({ name: "save_memory", state: "done" })
    expect((card as { ask?: unknown }).ask).toBeUndefined()
  })

  test("a part holds outside content from its start when the channel holds it: a memory save asks", async () => {
    const s = await setup()
    // The lead read a page earlier, and no one cleared the mark of the channel.
    await s.run(
      PlaceMarks.use((marks) =>
        Effect.sync(() =>
          marks.holdOutside(
            { kind: "channel", id: s.channel.id },
            { kind: "page", host: "a.test" },
          ),
        ),
      ),
    )
    await s.send("split memory")
    await until(async () => (await s.tasks()).some((t) => t.state === "waiting"))
    const card = (await s.history())
      .find((m) => m.agentId === s.bo.id)
      ?.parts.find((p) => p.kind === "tool")
    expect(card).toMatchObject({
      name: "save_memory",
      state: "waiting",
      ask: { kind: "approval", once: true, outside: { kind: "page", host: "a.test" } },
    })
    await s.run(Channels.use((c) => c.stopAll(s.channel.id)))
    await s.idle()
    expect(await s.run(Memory.use((m) => m.list(s.bo.id)))).toEqual([])
  })

  test("a mention: a save asks only when the history holds a message of another agent", async () => {
    const s = await setup({ lead: false })
    const save = `@Bo TOOL save_memory ${JSON.stringify({ text: "Ship on Friday" })}`
    await s.send(save)
    await s.idle()
    expect((await s.run(Memory.use((m) => m.list(s.bo.id)))).map((i) => i.text)).toEqual([
      "Ship on Friday",
    ])
    // Cy is asked next. Cy reads the message of Bo, so the same save of Cy asks (the mock
    // model repeats the request that it reads in the channel).
    await s.send(`@Cy ${save.slice(4)}`)
    await until(async () => (await s.tasks()).some((t) => t.state === "waiting"))
    const waiting = (await s.history())
      .filter((m) => m.agentId === s.cy.id)
      .at(-1)
      ?.parts.find((p) => p.kind === "tool")
    expect(waiting).toMatchObject({
      name: "save_memory",
      state: "waiting",
      ask: { once: true, outside: { kind: "agent", name: "Bo" } },
    })
    await s.run(Channels.use((c) => c.stopAll(s.channel.id)))
    await s.idle()
  })
})

describe("fast pick (spec 004)", () => {
  const channelLog = (dir: string) => {
    try {
      return readFileSync(join(dir, "logs", "channels.log"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  test("a sure answer sends the job to that member, not to the lead; one log line, no job text", async () => {
    decide = () => picks("member_3", 0.9)
    const s = await setup({ decision: true })
    expect(await s.send("Please check the budget")).toEqual({ awaiting: false })
    await s.idle()
    const list = await s.history()
    expect(kinds(list)).toEqual(["user:text", "agent:text"])
    expect(list[1]?.agentId).toBe(s.cy.id)
    expect((await s.tasks()).map((t) => t.agentId)).toEqual([s.cy.id])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.auth).toBe(`Bearer ${DECISION_KEY}`)
    expect(asked[0]?.body).toContain("Please check the budget")
    const log = channelLog(s.dataDir)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ event: "fast_pick", chosen: true, probability: 0.9 })
    expect(JSON.stringify(log)).not.toContain("budget")
    expect(JSON.stringify(log)).not.toContain(DECISION_KEY)
  })

  test("the request to the decision model holds neither the handbook nor the instructions of the channel (spec 002, 004)", async () => {
    decide = () => picks("member_3", 0.9)
    const s = await setup({ decision: true })
    await s.run(Handbook.use((h) => h.save(s.local.id, "Answer in Korean.", "page")))
    await s.run(
      Channels.use((c) => c.update(s.channel.id, { instructions: "Write the answer as a list." })),
    )
    await s.send("Please check the budget")
    await s.idle()
    expect(asked).toHaveLength(1)
    // The pick still got the job, and the job went to the member that it chose.
    expect(asked[0]?.body).toContain("Please check the budget")
    expect((await s.history())[1]?.agentId).toBe(s.cy.id)
    expect(asked[0]?.body).not.toContain("Answer in Korean.")
    expect(asked[0]?.body).not.toContain("Write the answer as a list.")
    // The own instructions of a member do not go to the pick either.
    expect(asked[0]?.body).not.toContain("You are Bo.")
  })

  test("an unsure answer: the lead reads the job as if the pick did not exist", async () => {
    decide = () => picks("member_2", 0.4)
    const s = await setup({ decision: true })
    await s.send("Please check the budget")
    await s.idle()
    const list = await s.history()
    expect(list[1]?.agentId).toBe(s.lead.id)
    expect(channelLog(s.dataDir)[0]).toMatchObject({
      chosen: false,
      reason: "below_threshold",
    })
  })

  test("a failing service, with no lead: the user picks, and the job waits", async () => {
    decide = () => new Response("down", { status: 503 })
    const s = await setup({ lead: false, decision: true })
    expect(await s.send("Who takes this")).toEqual({ awaiting: false })
    await until(async () => (await s.history())[0]?.awaiting === true)
    expect(channelLog(s.dataDir)[0]).toMatchObject({
      chosen: false,
      reason: "service_error",
      code: 503,
    })
    expect(await s.tasks()).toHaveLength(0)
  })

  test("a mention skips the pick; so do a channel with open work and a channel with one member", async () => {
    decide = () => picks("member_3", 0.9)
    const s = await setup({ decision: true })
    await s.send("@bo say hi")
    await s.idle()
    expect(asked).toHaveLength(0)

    // A part that still runs is open work: a new message may continue it.
    await s.send("@bo SLOW work")
    await until(async () => (await s.tasks()).some((t) => t.state === "running"))
    await s.send("and then this")
    expect(asked).toHaveLength(0)
    await s.run(Channels.use((c) => c.stopAll(s.channel.id)))
    await s.idle()

    await s.run(
      Channels.use((c) => c.update(s.channel.id, { memberIds: [s.lead.id], leadId: s.lead.id })),
    )
    await s.send("a job for one member")
    await s.idle()
    expect(asked).toHaveLength(0)
  })

  test("off by default: nothing is asked and the lead reads the job", async () => {
    const s = await setup()
    await s.send("Please check the budget")
    await s.idle()
    expect((await s.history())[1]?.agentId).toBe(s.lead.id)
    expect(channelLog(s.dataDir)).toEqual([])
  })
})
