import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatMessage, MessagePart } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Memory } from "./Memory.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

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

/** A model that calls the tool named in the user text ("CALL name {json}"), then repeats the result. */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      tools?: { function: { name: string } }[]
      messages: { role: string; content: string | null }[]
    }
    const last = body.messages.at(-1)
    if (last?.role === "tool")
      return sse([
        { choices: [{ delta: { content: `Result: ${last.content}` } }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        "[DONE]",
      ])
    const match = /CALL (\w+) (\{.*\})/.exec(String(last?.content ?? ""))
    if (match && body.tools?.some((t) => t.function.name === match[1]))
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: match[1], arguments: "" } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: match[2] } }] } }] },
        "[DONE]",
      ])
    return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])
  },
})
afterAll(() => server.stop())

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const setup = async (permission: "ask_all" | "ask_risky" | "full" = "ask_risky") => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-tools-test-key",
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
  await run(Agents.use((a) => a.update(agent.id, { permission })))
  mkdirSync(agent.workspace, { recursive: true })
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const history = () => run(Chat.use((c) => c.history(agent.id)))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await history()).messages.filter((m) => m.author === "agent").at(-1)
  const toolPart = async () =>
    (await reply())?.parts.find(
      (p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool",
    )
  const finished = () =>
    until(async () => (await reply())?.status !== "streaming" && !!(await reply()))
  const respond = (answer: string) => run(Tools.use((x) => x.respond(agent.id, "call_1", answer)))
  const waitingCard = async () => {
    await until(async () => (await toolPart())?.state === "waiting")
    return (await toolPart())?.ask
  }
  return { run, agent, local, send, reply, toolPart, finished, respond, waitingCard, t }
}

const call = (name: string, args: object) => `CALL ${name} ${JSON.stringify(args)}`

describe("tools in a chat turn", () => {
  test("a write inside the workspace runs without a question, and the model sees the result", async () => {
    const s = await setup()
    await s.send(call("write_file", { path: "notes/a.txt", content: "hi" }))
    await s.finished()
    expect(readFileSync(join(s.agent.workspace, "notes/a.txt"), "utf8")).toBe("hi")
    const part = await s.toolPart()
    expect(part).toMatchObject({ name: "write_file", state: "done" })
    expect((await s.reply())?.parts.at(-1)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Result: Wrote 2"),
    })
  })

  test("ask for risky steps: rm outside the workspace waits and does nothing until allowed", async () => {
    const s = await setup()
    const outside = join(s.t.dataDir, "outside.txt")
    writeFileSync(outside, "keep me")
    await s.send(call("run_command", { command: `rm "${outside}"` }))
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({ kind: "approval", summary: expect.stringContaining("outside.txt") })
    expect(existsSync(outside)).toBe(true)
    const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
    expect(tasks[0]?.state).toBe("waiting")
    await s.respond("allow")
    await s.finished()
    expect(existsSync(outside)).toBe(false)
    expect((await s.toolPart())?.state).toBe("done")
    expect((await s.run(Tasks.use((x) => x.list(s.local.id))))[0]?.state).toBe("done")
  })

  test("deny keeps the file, tells the model, and the turn goes on", async () => {
    const s = await setup()
    const outside = join(s.t.dataDir, "outside2.txt")
    writeFileSync(outside, "keep me")
    await s.send(call("run_command", { command: `rm "${outside}"` }))
    await s.waitingCard()
    await s.respond("deny")
    await s.finished()
    expect(existsSync(outside)).toBe(true)
    const part = await s.toolPart()
    expect(part).toMatchObject({ state: "failed", output: "The user denied this step." })
    expect((await s.reply())?.status).toBe("done")
  })

  test("always allow remembers the step for this agent", async () => {
    const s = await setup()
    const first = join(s.t.dataDir, "f1.txt")
    const second = join(s.t.dataDir, "f2.txt")
    writeFileSync(first, "1")
    writeFileSync(second, "2")
    await s.send(call("run_command", { command: `rm "${first}"` }))
    await s.waitingCard()
    await s.respond("always")
    await s.finished()
    expect(existsSync(first)).toBe(false)
    await s.send(call("run_command", { command: `rm "${second}"` }))
    await until(() => !existsSync(second))
    await s.finished()
  })

  test("ask for everything also asks for a write inside the workspace; full access asks nothing", async () => {
    const all = await setup("ask_all")
    await all.send(call("write_file", { path: "x.txt", content: "x" }))
    expect(await all.waitingCard()).toMatchObject({ kind: "approval" })
    expect(existsSync(join(all.agent.workspace, "x.txt"))).toBe(false)
    await all.respond("allow")
    await all.finished()
    expect(existsSync(join(all.agent.workspace, "x.txt"))).toBe(true)

    const full = await setup("full")
    const outside = join(full.t.dataDir, "gone.txt")
    writeFileSync(outside, "x")
    await full.send(call("run_command", { command: `rm "${outside}"` }))
    await full.finished()
    expect(existsSync(outside)).toBe(false)
  })

  test("a question card waits for the answer, which goes to the model", async () => {
    const s = await setup("full")
    await s.send(call("ask_user", { question: "Which colour?", choices: ["red", "blue"] }))
    expect(await s.waitingCard()).toEqual({
      kind: "question",
      question: "Which colour?",
      choices: ["red", "blue"],
    })
    await s.respond("blue")
    await s.finished()
    expect((await s.reply())?.parts.at(-1)).toMatchObject({ text: "Result: blue" })
  })

  test("stop while a card waits ends the turn at once", async () => {
    const s = await setup()
    const outside = join(s.t.dataDir, "stay.txt")
    writeFileSync(outside, "x")
    await s.send(call("run_command", { command: `rm "${outside}"` }))
    await s.waitingCard()
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await s.finished()
    expect((await s.reply())?.status).toBe("stopped")
    expect(existsSync(outside)).toBe(true)
  })

  test("a failed tool shows its error and does not end the turn", async () => {
    const s = await setup("full")
    await s.send(call("read_file", { path: "missing.txt" }))
    await s.finished()
    const part = await s.toolPart()
    expect(part?.state).toBe("failed")
    expect((await s.reply())?.status).toBe("done")
  })

  test("a command runs in the workspace and shows its output", async () => {
    const s = await setup()
    await s.send(call("run_command", { command: "echo hello > made.txt && cat made.txt" }))
    await s.finished()
    expect((await s.toolPart())?.output).toContain("hello")
    expect(existsSync(join(s.agent.workspace, "made.txt"))).toBe(true)
  })
})

describe("memory", () => {
  test("the agent saves a fact; the next turn gets it; off or deleted, it does not", async () => {
    const s = await setup("full")
    await s.send(call("save_memory", { text: "The user prefers green tea" }))
    await s.finished()
    const part = await s.toolPart()
    expect(part?.memoryId).toBeTruthy()
    const items = await s.run(Memory.use((m) => m.list(s.agent.id)))
    expect(items.map((i) => [i.text, i.source])).toEqual([["The user prefers green tea", "agent"]])
    const given = await s.run(
      Memory.use((m) => Effect.succeed(m.forTurn(s.agent.id, "which tea?"))),
    )
    expect(given.map((i) => i.text)).toEqual(["The user prefers green tea"])

    await s.run(Agents.use((a) => a.update(s.agent.id, { memoryEnabled: false })))
    expect(await s.run(Memory.use((m) => Effect.succeed(m.forTurn(s.agent.id, "tea"))))).toEqual([])
    await s.run(Agents.use((a) => a.update(s.agent.id, { memoryEnabled: true })))
    await s.run(Memory.use((m) => m.remove(items[0]?.id ?? "")))
    expect(await s.run(Memory.use((m) => m.list(s.agent.id)))).toEqual([])
  })
})
