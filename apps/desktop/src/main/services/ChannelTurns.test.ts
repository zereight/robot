import { afterAll, describe, expect, test } from "bun:test"
import {
  ASKING_CUT,
  CHANNEL_SUMMARY_SYSTEM,
  contextShare,
  estimateTokens,
  splitAssignment,
} from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// What a member reads in a turn of a channel (spec 004, "What a member reads").

const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks)
          controller.enqueue(
            enc.encode(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`),
          )
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
const delta = (content: string) => ({ choices: [{ delta: { content } }] })

interface Request {
  system: string
  turns: { role: string; content: string }[]
}
/** The requests of members, and of the summary call, that the stand-in model got. */
const members: Request[] = []
const summaryCalls: Request[] = []
/** The size of the context that the stand-in model tells, or none. */
let contextLength: number | null = null
/** While true, the call that writes the summary fails. */
let summaryFails = false

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [{ id: "mock", ...(contextLength ? { context_length: contextLength } : {}) }],
      })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const [system, ...turns] = body.messages
    const request = { system: system?.content ?? "", turns }
    if (request.system.startsWith(CHANNEL_SUMMARY_SYSTEM)) {
      summaryCalls.push(request)
      if (summaryFails) return Response.json({ error: { message: "boom" } }, { status: 400 })
      return sse([delta("Older: the team chose the blue plan."), "[DONE]"])
    }
    members.push(request)
    return sse([delta("Noted."), "[DONE]"])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean> | boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const setup = async (options: { size: number | null; instructions?: string }) => {
  contextLength = options.size
  summaryFails = false
  members.length = 0
  summaryCalls.length = 0
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-turns-test-key",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string, instructions: string) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions,
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  const bo = await agent("Bo", options.instructions ?? "Bo writes short answers.")
  const cy = await agent("Cy", "Cy checks facts.")
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId: local.id,
        name: "Launch",
        topic: "",
        instructions: "Write the answer as a list.",
        memberIds: [bo.id, cy.id],
        leadId: null,
      }),
    ),
  )
  const post = (text: string) => run(Channels.use((c) => c.post(channel.id, text)))
  const posts = async (n: number, make: (i: number) => string) => {
    for (let i = 1; i <= n; i++) await post(make(i))
  }
  const send = (text: string) => run(Channels.use((c) => c.send(channel.id, text)))
  const idle = () =>
    until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      return all.length > 0 && all.every((x) => !["queued", "running"].includes(x.state))
    })
  const states = async () => (await run(Tasks.use((x) => x.list(local.id)))).map((x) => x.state)
  const failure = async () =>
    (await run(Tasks.use((x) => x.list(local.id)))).find((x) => x.state === "failed")?.error
  return { ...t, post, posts, send, idle, states, failure }
}

/**
 * The text of the turns, one string. The provider joins turns of the user that follow each other,
 * with a blank line, so a test reads the blocks of the text and not the turns.
 */
const turnsText = (r: Request) => r.turns.map((x) => x.content).join("\n\n")

describe("the text of a member", () => {
  test("the assignment comes first, then the instructions, then the newest messages", async () => {
    const s = await setup({ size: null })
    await s.posts(3, (i) => `chatter ${i}`)
    await s.send("@Bo list the colours")
    await s.idle()
    const request = members.at(-1) as Request
    // The assignment is the head of the text. The instructions of the member come first among the
    // instructions, then the ones of the channel.
    const parts = splitAssignment(request.system)
    expect(parts?.assignment).toBe("@Bo list the colours")
    const rest = parts?.instructions ?? ""
    expect(rest.indexOf("Bo writes short answers.")).toBeGreaterThanOrEqual(0)
    expect(rest.indexOf("Bo writes short answers.")).toBeLessThan(
      rest.indexOf("Write the answer as a list."),
    )
    // The newest messages follow: the asking message first as a block, then the channel.
    const text = turnsText(request)
    expect(text.startsWith("Messages that asked you")).toBe(true)
    expect(text.indexOf("Messages that asked you")).toBeLessThan(text.indexOf("chatter 1"))
    expect(text.indexOf("chatter 3")).toBeLessThan(text.lastIndexOf("@Bo list the colours"))
    // With 10 or fewer newest messages there is no reminder.
    expect(text).not.toContain("Reminder of your assignment")
    expect(text.endsWith("@Bo list the colours")).toBe(true)
  })

  test("a turn of a channel holds the instructions of the channel", async () => {
    const s = await setup({ size: null })
    await s.send("@Bo hello")
    await s.idle()
    expect((members.at(-1) as Request).system).toContain("Write the answer as a list.")
  })

  test("with no known size the member reads the last 20 messages, and a reminder after 10", async () => {
    const s = await setup({ size: null })
    await s.posts(29, (i) => `note ${i}`)
    await s.send("@Bo what is up")
    await s.idle()
    const request = members.at(-1) as Request
    const text = turnsText(request)
    // 30 messages in the channel; the last 20 are read: note 11 to note 29 and the job.
    expect(text).toContain("note 11")
    expect(text).not.toMatch(/note 10\b/)
    expect(text.match(/note \d+/g)?.length).toBe(19)
    // More than 10 newest messages: the request ends with the reminder of the assignment.
    expect(text.endsWith("Reminder of your assignment:\n@Bo what is up")).toBe(true)
    // The size is not known, so no summary is written.
    expect(summaryCalls).toHaveLength(0)
  })

  test("a message that asked the member is cut to 2000 characters, and only the newest 5 stay", async () => {
    const s = await setup({ size: null })
    await s.post(`@Bo old ask ${"a".repeat(3000)}`)
    for (let i = 1; i <= 5; i++) await s.post(`@Bo ask ${i} ${"b".repeat(50)}`)
    await s.post("@Cy this one is for Cy")
    await s.send("@Bo go")
    await s.idle()
    const block = turnsText(members.at(-1) as Request).split("\n\n")[0] ?? ""
    expect(block.startsWith("Messages that asked you")).toBe(true)
    // Five messages: ask 2 to ask 5 and the job (the oldest ask fell out of the five).
    expect(block).not.toContain("old ask")
    expect(block).not.toContain("for Cy")
    expect(block.match(/\[User\]:/g)?.length).toBe(5)
    expect(block.indexOf("ask 2")).toBeLessThan(block.indexOf("ask 5"))
    expect(block.trimEnd().endsWith("@Bo go")).toBe(true)
  })

  test("a long asking message is cut at 2000 characters", async () => {
    const s = await setup({ size: null })
    await s.send(`@Bo ${"c".repeat(5000)}`)
    await s.idle()
    const block = turnsText(members.at(-1) as Request).split("\n\n")[0] ?? ""
    const line = block.split("\n")[1] ?? ""
    expect(line).toBe(`[User]: ${`@Bo ${"c".repeat(5000)}`.slice(0, ASKING_CUT)}`)
  })
})

describe("a small context", () => {
  const SIZE = 8000

  test("the summary and the newest messages each fill at most a quarter of the context", async () => {
    const s = await setup({ size: SIZE })
    await s.posts(200, (i) => `message ${i} ${"w".repeat(120)}`)
    await s.send("@Bo what now")
    await s.idle()
    expect(summaryCalls).toHaveLength(1)
    // The call that writes the summary reads older messages only, oldest first.
    const asked = summaryCalls[0]?.turns[0]?.content ?? ""
    expect(asked).toContain("message 1 ")
    expect(asked).not.toContain("message 200 ")
    const blocks = turnsText(members.at(-1) as Request).split("\n\n")
    const at = blocks.findIndex((b) => b.startsWith("Summary of the older messages"))
    expect(at).toBeGreaterThan(0)
    expect(blocks[at]).toBe(
      "Summary of the older messages of this channel:\nOlder: the team chose the blue plan.",
    )
    const share = contextShare(SIZE) as number
    expect(estimateTokens(blocks[at] ?? "")).toBeLessThanOrEqual(share)
    // The newest messages, between the summary and the reminder, stay under a quarter.
    const newest = blocks.slice(at + 1, -1)
    expect(newest.length).toBeGreaterThan(10)
    const used = newest.reduce((sum, b) => sum + estimateTokens(b) + 4, 0)
    expect(used).toBeLessThanOrEqual(share)
    expect(newest.at(-1)).toBe("@Bo what now")
    expect(blocks.at(-1)).toBe("Reminder of your assignment:\n@Bo what now")
  })

  test("a summary that cannot be written leaves the newest messages and does not fail the part", async () => {
    const s = await setup({ size: SIZE })
    await s.posts(200, (i) => `message ${i} ${"w".repeat(120)}`)
    summaryFails = true
    await s.send("@Bo what now")
    await s.idle()
    expect(summaryCalls.length).toBeGreaterThan(0)
    const request = members.at(-1) as Request
    expect(turnsText(request)).not.toContain("Summary of the older")
    expect(turnsText(request)).toContain("message 199")
    expect(await s.states()).toEqual(["done"])
  })

  test("parts that start together share one summary call", async () => {
    const s = await setup({ size: SIZE })
    await s.posts(200, (i) => `message ${i} ${"w".repeat(120)}`)
    await s.send("@all what now")
    await s.idle()
    expect(members).toHaveLength(2)
    expect(summaryCalls).toHaveLength(1)
  })

  test("a channel with no older messages writes no summary", async () => {
    const s = await setup({ size: SIZE })
    await s.posts(5, (i) => `short ${i}`)
    await s.send("@Bo what now")
    await s.idle()
    expect(summaryCalls).toHaveLength(0)
  })

  test("the assignment and the instructions together larger than the context fail the part", async () => {
    const s = await setup({ size: 1000, instructions: "r".repeat(8000) })
    await s.send("@Bo hello")
    await until(async () => (await s.states()).includes("failed"))
    expect((await s.failure())?.code).toBe("channel_context_too_small")
    // The model is never asked.
    expect(members).toHaveLength(0)
  })
})
