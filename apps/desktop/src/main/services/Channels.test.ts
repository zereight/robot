import { afterAll, describe, expect, test } from "bun:test"
import type { ChannelMessage } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Places } from "./Places.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
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
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const last = (body.messages.at(-1)?.content ?? "").split("\n").at(-1) ?? ""
    if (last.includes("FAIL")) return Response.json({ error: { message: "boom" } }, { status: 500 })
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
afterAll(() => server.stop())

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const setup = async (options: { lead?: boolean } = { lead: true }) => {
  const t = testRuntime()
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
  return { run, local, lead, bo, cy, channel, history, send, idle, tasks, runtime: t.runtime }
}

const kinds = (list: readonly ChannelMessage[]) => list.map((m) => `${m.author}:${m.kind}`)

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
