import { afterAll, describe, expect, test } from "bun:test"
import type { ChannelMessage } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Channels, SUMMARY_RULE } from "./Channels.ts"
import { asOldShape } from "./channelTurns.testing.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// Review of parts and Blocked in a channel (spec 004, 005): when the summary waits, what the lead
// reads, and what "Accept", "Request changes" and "End the request" do.

const sse = (text: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const send = (data: unknown) =>
          controller.enqueue(
            enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`),
          )
        send({ choices: [{ delta: { content: text } }] })
        send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })
        send("[DONE]")
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const plan = (parts: { member: string; label: string; prompt: string }[]) =>
  JSON.stringify({ plan: "Split in parts", parts })

/** What the model got: the system text and the last message of each request. */
const requests: { system: string; last: string; all: string }[] = []

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = asOldShape((await req.json()) as { messages: { role: string; content: string }[] })
    const system = body.messages.find((m) => m.role === "system")?.content ?? ""
    const lastMessage = body.messages.at(-1)?.content ?? ""
    const last = lastMessage.split("\n").at(-1) ?? ""
    requests.push({ system, last, all: lastMessage })
    if (last.includes("split two"))
      return sse(
        plan([
          { member: "Bo", label: "Intro", prompt: "Write the intro" },
          { member: "Cy", label: "Facts", prompt: "Check the facts" },
        ]),
      )
    if (last.includes("split block"))
      return sse(
        plan([
          { member: "Bo", label: "Intro", prompt: "Write the intro" },
          { member: "Cy", label: "Repo", prompt: "BLOCK the repo" },
        ]),
      )
    if (lastMessage.includes("All parts have ended")) return sse("Summary done.")
    if (last.includes("BLOCK")) return sse("I tried.\nBlocked: no access to the repository")
    return sse(`Echo: ${last}`)
  },
})
afterAll(() => server.stop())

const until = async (check: () => Promise<boolean> | boolean, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const setup = async (options: { review?: boolean } = {}) => {
  requests.length = 0
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-review-test-key",
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
        leadId: lead.id,
      }),
    ),
  )
  if (options.review) await run(Channels.use((c) => c.update(channel.id, { reviewParts: true })))
  const history = () => run(Channels.use((c) => c.history(channel.id)))
  const send = (text: string) => run(Channels.use((c) => c.send(channel.id, text)))
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const parts = async () => (await tasks()).filter((t) => t.parentId !== null)
  const inState = (label: string, state: string) => async () =>
    (await parts()).some((t) => t.label === label && t.state === state)
  const settled = () =>
    until(async () => (await tasks()).every((x) => !["queued", "running"].includes(x.state)))
  return { run, local, lead, bo, cy, channel, history, send, tasks, parts, inState, settled }
}

const kinds = (list: readonly ChannelMessage[]) => list.map((m) => `${m.author}:${m.kind}`)

describe("the setting Review parts", () => {
  test("it is off by default and can be turned on and off", async () => {
    const s = await setup()
    expect(s.channel.reviewParts).toBe(false)
    const on = await s.run(Channels.use((c) => c.update(s.channel.id, { reviewParts: true })))
    expect(on.reviewParts).toBe(true)
    // Another change leaves it as it is.
    const renamed = await s.run(Channels.use((c) => c.update(s.channel.id, { topic: "New" })))
    expect(renamed.reviewParts).toBe(true)
    const off = await s.run(Channels.use((c) => c.update(s.channel.id, { reviewParts: false })))
    expect(off.reviewParts).toBe(false)
  })

  test("with it off, the parts end as Done and the lead sums up", async () => {
    const s = await setup()
    await s.send("split two things")
    await s.settled()
    await until(async () => kinds(await s.history()).includes("agent:summary"))
    expect((await s.parts()).map((t) => t.state)).toEqual(["done", "done"])
  })
})

describe("review of parts", () => {
  test("both parts wait in review with no summary; accept and request changes end the wait", async () => {
    const s = await setup({ review: true })
    await s.send("split two things")
    await until(async () => (await s.parts()).filter((t) => t.state === "review").length === 2)
    // The lead posts no summary while a part is in review.
    await Bun.sleep(700)
    let list = await s.history()
    expect(kinds(list).filter((k) => k === "agent:summary")).toHaveLength(0)
    // The last message of each part carries its state, for the bar under it.
    const partInfos = list.flatMap((m) => (m.part ? [m.part] : []))
    expect(partInfos.map((p) => p.state)).toEqual(["review", "review"])
    expect(list[1]?.chips.map((c) => c.state)).toEqual(["review", "review"])
    // The plan steps show them in review.
    const activity = await s.run(Channels.use((c) => c.activity(s.channel.id)))
    expect(
      activity.members.find((m) => m.agentId === s.lead.id)?.steps.map((x) => x.state),
    ).toEqual(["review", "review"])
    const parts = await s.parts()
    const first = parts.find((t) => t.label === "Intro")
    const second = parts.find((t) => t.label === "Facts")
    // Accept the first part: it is done. No summary yet.
    await s.run(Tasks.use((x) => x.accept(first?.id ?? "")))
    expect((await s.parts()).find((t) => t.id === first?.id)?.state).toBe("done")
    await Bun.sleep(500)
    expect(kinds(await s.history())).not.toContain("agent:summary")

    // Request changes on the second part: the old part is done, a new part runs and goes to review.
    await s.run(Tasks.use((x) => x.requestChanges(second?.id ?? "", "Add a title")))
    await until(s.inState("Changes: Facts", "review"))
    const all = await s.parts()
    const old = all.find((t) => t.id === second?.id)
    const next = all.find((t) => t.label === "Changes: Facts")
    expect(old?.state).toBe("done")
    expect(next?.agentId).toBe(s.cy.id)
    expect(next?.prompt).toBe("Add a title")
    expect(next?.retryOf).toBe(second?.id)
    // The new part belongs to the same request.
    expect(next?.parentId).toBe(second?.parentId)
    // The member got the text of the user as its part.
    expect(requests.some((r) => r.last === "Add a title")).toBe(true)
    await Bun.sleep(500)
    expect(kinds(await s.history())).not.toContain("agent:summary")

    // Accept it: the lead posts one summary.
    await s.run(Tasks.use((x) => x.accept(next?.id ?? "")))
    await until(async () => kinds(await s.history()).includes("agent:summary"))
    await Bun.sleep(400)
    list = await s.history()
    expect(kinds(list).filter((k) => k === "agent:summary")).toHaveLength(1)
    expect((await s.tasks()).every((t) => t.state === "done")).toBe(true)
  })

  test("End the request cancels a part in review, and the lead posts no summary", async () => {
    const s = await setup({ review: true })
    await s.send("split two things")
    await until(async () => (await s.parts()).filter((t) => t.state === "review").length === 2)
    const first = (await s.parts())[0]
    await s.run(Tasks.use((x) => x.endRequest(first?.id ?? "")))
    await until(async () => (await s.tasks()).every((t) => t.state === "cancelled"))
    await Bun.sleep(600)
    expect(kinds(await s.history())).not.toContain("agent:summary")
    // The steps of a plan that ended leave the panel.
    const activity = await s.run(Channels.use((c) => c.activity(s.channel.id)))
    expect(activity.members.flatMap((m) => m.steps)).toEqual([])
  })

  test("Stop on the channel does not change a part in review", async () => {
    const s = await setup({ review: true })
    await s.send("split two things")
    await until(async () => (await s.parts()).filter((t) => t.state === "review").length === 2)
    await s.run(Channels.use((c) => c.stopAll(s.channel.id)))
    await Bun.sleep(300)
    expect((await s.parts()).map((t) => t.state)).toEqual(["review", "review"])
    // The lead task stopped; the parts still wait for the user.
    expect(kinds(await s.history())).not.toContain("agent:summary")
  })

  test("turning the setting off does not change a part that is in review", async () => {
    const s = await setup({ review: true })
    await s.send("split two things")
    await until(async () => (await s.parts()).filter((t) => t.state === "review").length === 2)
    await s.run(Channels.use((c) => c.update(s.channel.id, { reviewParts: false })))
    await Bun.sleep(300)
    expect((await s.parts()).map((t) => t.state)).toEqual(["review", "review"])
  })

  test("the setting counts only for parts: a mention is never in review", async () => {
    const s = await setup({ review: true })
    await s.send("@Bo say hi")
    await s.settled()
    await until(
      async () => (await s.tasks()).length === 1 && (await s.tasks())[0]?.state === "done",
    )
    expect((await s.tasks()).map((t) => t.state)).toEqual(["done"])
    const list = await s.history()
    expect(list.flatMap((m) => (m.part ? [m.part] : []))).toEqual([])
  })

  test("a part in review is not busy: its member takes other work", async () => {
    const s = await setup({ review: true })
    await s.send("split two things")
    await until(async () => (await s.parts()).filter((t) => t.state === "review").length === 2)
    await s.send("@Bo and now this")
    await until(async () =>
      (await s.tasks()).some(
        (t) => t.agentId === s.bo.id && t.prompt === "@Bo and now this" && t.state === "done",
      ),
    )
    // Bo's first part is still in review.
    expect((await s.parts()).find((t) => t.agentId === s.bo.id)?.state).toBe("review")
  })
})

describe("blocked parts", () => {
  test("a part that ends with a Blocked line is blocked, shows its reason, and the summary names it", async () => {
    const s = await setup()
    await s.send("split block it")
    await until(async () => kinds(await s.history()).includes("agent:summary"))
    const blocked = (await s.parts()).find((t) => t.label === "Repo")
    expect(blocked?.state).toBe("blocked")
    expect(blocked?.error).toEqual({ code: "blocked", detail: "no access to the repository" })
    const list = await s.history()
    // The line stays in the reply.
    const reply = list.find((m) => m.agentId === s.cy.id && m.kind === "text")
    expect(JSON.stringify(reply?.parts)).toContain("Blocked: no access to the repository")
    // The last message of the part carries the state and the reason, for the card.
    expect(reply?.part).toMatchObject({
      state: "blocked",
      error: { code: "blocked", detail: "no access to the repository" },
    })
    expect(list[1]?.chips.map((c) => c.state)).toEqual(["done", "blocked"])
    // The lead reads the part and its reason, and is asked to name it. The summary message is
    // saved before its request reaches the model, so the test waits for the request.
    await until(() => requests.some((r) => r.all.includes("All parts have ended")))
    const ask = requests.find((r) => r.all.includes("All parts have ended"))
    expect(ask?.all).toContain("Repo (Cy): blocked (reason: no access to the repository)")
    expect(ask?.all).toContain("If a part was blocked, name the part and give its reason.")
    // The summary gives what the user can use, short, and not how the work was done (spec 004).
    expect(ask?.all).toContain(SUMMARY_RULE)
  })

  test("a blocked part is final: the lead does not wait for it", async () => {
    const s = await setup({ review: true })
    await s.send("split block it")
    // Bo's part goes to review. Cy's part is blocked, not in review. The two members work at the
    // same time, so the test waits for each state: one may come before the other.
    await until(s.inState("Intro", "review"))
    await until(s.inState("Repo", "blocked"))
    const bo = (await s.parts()).find((t) => t.label === "Intro")
    await s.run(Tasks.use((x) => x.accept(bo?.id ?? "")))
    await until(async () => kinds(await s.history()).includes("agent:summary"))
  })

  test("only a part of a plan is told how to say that it is blocked", async () => {
    const s = await setup()
    await s.send("split two things")
    await until(async () => kinds(await s.history()).includes("agent:summary"))
    const part = requests.find((r) => r.last === "Write the intro")
    expect(part?.system).toContain('"Blocked:"')
    // The lead that makes the plan, and the summary of the lead, get no such text.
    const planRequest = requests.find((r) => r.last === "split two things")
    expect(planRequest?.system).not.toContain('"Blocked:"')
    // A reply to a mention is no part.
    requests.length = 0
    await s.send("@Bo say hi")
    await until(async () => requests.some((r) => r.last === "@Bo say hi"))
    expect(requests.find((r) => r.last === "@Bo say hi")?.system).not.toContain('"Blocked:"')
  })
})

describe("a reply to a part (spec question of 004)", () => {
  test("a reply with no mention goes to the member of the part as a new part, with its done test", async () => {
    const s = await setup()
    await s.send("split two things")
    await until(async () => kinds(await s.history()).includes("agent:summary"))
    const intro = (await s.parts()).find((t) => t.label === "Intro")
    const boReply = (await s.history()).find((m) => m.taskId === intro?.id)
    expect(boReply).toBeDefined()
    requests.length = 0
    await s.run(Channels.use((c) => c.send(s.channel.id, "make it shorter", boReply?.id ?? null)))
    await until(async () => (await s.parts()).some((t) => t.retryOf === intro?.id))
    await s.settled()
    const follow = (await s.parts()).find((t) => t.retryOf === intro?.id)
    expect(follow?.agentId).toBe(s.bo.id)
    expect(follow?.label).toBe("Changes: Intro")
    expect(follow?.parentId).toBe(intro?.parentId)
    expect(follow?.doneTest).toBe(intro?.doneTest)
    // The member got the reply, and the lead made no new plan for it.
    expect(
      requests.some((r) => r.all.includes("make it shorter") && r.system.includes("You are Bo")),
    ).toBe(true)
    expect(
      requests.some((r) => r.last === "make it shorter" && r.system.includes("You are Lia")),
    ).toBe(false)
  })

  test("a reply with a mention follows the mention, and a reply to a message of no part goes to the lead", async () => {
    const s = await setup()
    await s.send("split two things")
    await until(async () => kinds(await s.history()).includes("agent:summary"))
    const intro = (await s.parts()).find((t) => t.label === "Intro")
    const boReply = (await s.history()).find((m) => m.taskId === intro?.id)
    const before = (await s.parts()).length
    await s.run(Channels.use((c) => c.send(s.channel.id, "@Cy check this", boReply?.id ?? null)))
    await s.settled()
    expect((await s.parts()).length).toBe(before)
    const summary = (await s.history()).find((m) => m.kind === "summary")
    requests.length = 0
    await s.run(Channels.use((c) => c.send(s.channel.id, "thanks", summary?.id ?? null)))
    await until(() => requests.some((r) => r.last === "thanks"))
    expect(requests.find((r) => r.last === "thanks")?.system).toContain("You are Lia")
  })
})
