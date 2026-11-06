import { afterAll, describe, expect, test } from "bun:test"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Memory } from "./Memory.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// The lead prompt and the note "not the lead" (spec 004, Rules).

const sse = (text: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
        )
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const seen: string[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: unknown[] }
    seen.push(JSON.stringify(body.messages))
    return sse("Ok.")
  },
})
afterAll(() => server.stop(true))

const NOT_LEAD = "You are not the lead of this channel."

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-lead-test-key",
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
  const [bo, cy] = await Promise.all([agent("Bo"), agent("Cy")])
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId: local.id,
        name: "Launch",
        topic: "",
        memberIds: [bo.id, cy.id],
        leadId: bo.id,
      }),
    ),
  )
  const setLead = (leadId: string | null) =>
    run(Channels.use((c) => c.update(channel.id, { leadId })))
  const setMembers = (memberIds: string[]) =>
    run(Channels.use((c) => c.update(channel.id, { memberIds })))
  const notes = async (agentId: string) =>
    (await run(Memory.use((m) => m.list(agentId)))).map((i) => i.text)
  const post = async (text: string) => {
    seen.length = 0
    await run(Channels.use((c) => c.send(channel.id, text)))
    const end = Date.now() + 5000
    while (Date.now() < end) {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      if (all.length > 0 && all.every((x) => !["queued", "running"].includes(x.state))) break
      await Bun.sleep(15)
    }
    return seen.join("\n")
  }
  return { bo, cy, setLead, setMembers, notes, post }
}

describe("the lead prompt", () => {
  test("the lead gets it in a turn of the channel, and a member that is not the lead gets none", async () => {
    const s = await setup()
    expect(await s.post("plan the launch")).toContain("You are the lead of this channel")
    await s.setLead(s.cy.id)
    expect(await s.post("@Bo plan the launch")).not.toContain("You are the lead of this channel")
  })
})

describe("the note when the lead changes", () => {
  test("the first lead gets one note; the new lead gets none", async () => {
    const s = await setup()
    await s.setLead(s.cy.id)
    expect(await s.notes(s.bo.id)).toEqual([NOT_LEAD])
    expect(await s.notes(s.cy.id)).toEqual([])
  })

  test("a second change makes no second note", async () => {
    const s = await setup()
    await s.setLead(s.cy.id)
    await s.setLead(s.bo.id)
    await s.setLead(s.cy.id)
    expect(await s.notes(s.bo.id)).toEqual([NOT_LEAD])
  })

  test("an agent that leads again loses the note", async () => {
    const s = await setup()
    await s.setLead(s.cy.id)
    await s.setLead(s.bo.id)
    expect(await s.notes(s.bo.id)).toEqual([])
    expect(await s.notes(s.cy.id)).toEqual([NOT_LEAD])
  })

  test("a lead that is set to nobody gets the note", async () => {
    const s = await setup()
    await s.setLead(null)
    expect(await s.notes(s.bo.id)).toEqual([NOT_LEAD])
  })

  test("a lead that leaves the channel gets no note: it cannot read it", async () => {
    const s = await setup()
    await s.setMembers([s.cy.id])
    expect(await s.notes(s.bo.id)).toEqual([])
  })
})
