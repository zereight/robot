import { afterAll, describe, expect, test } from "bun:test"
import { messageText } from "@robot/shared"
import { Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Places } from "./Places.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

const KEY = "sk-chat-test"
let failNext = true
/** The last message of each request that reached the model. */
const asked: string[] = []

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
afterAll(() => server.stop())

const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

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
