import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatMessage, MessagePart } from "@robot/shared"
import { Effect } from "effect"
import type { ToolEvent } from "../providers/agent.ts"
import { BRIDGE_TOOL_NAMES } from "../runtimes/bridge.ts"
import { Agents } from "./Agents.ts"
import { CurrentActor } from "./actor.ts"
import { Chat } from "./Chat.ts"
import { Memory } from "./Memory.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { type ToolContext, Tools } from "./Tools.ts"
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
  /** The answer of a linked device: the request runs with that device as the actor. */
  const respondAs = (name: string, answer: string) =>
    run(
      Tools.use((x) => x.respond(agent.id, "call_1", answer)).pipe(
        Effect.provideService(CurrentActor, { id: `device-${name}`, name }),
      ),
    )
  const waitingCard = async () => {
    await until(async () => (await toolPart())?.state === "waiting")
    return (await toolPart())?.ask
  }
  return { run, agent, local, send, reply, toolPart, finished, respond, respondAs, waitingCard, t }
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

  test("an approval answered by a linked device says who: Allowed by, Denied by", async () => {
    const s = await setup()
    const keep = join(s.t.dataDir, "keep.txt")
    const gone = join(s.t.dataDir, "gone2.txt")
    writeFileSync(keep, "1")
    writeFileSync(gone, "2")

    await s.send(call("run_command", { command: `rm "${gone}"` }))
    await s.waitingCard()
    await s.respondAs("MacBook 1", "allow")
    await s.finished()
    expect(existsSync(gone)).toBe(false)
    expect((await s.toolPart())?.decision).toEqual({ answer: "allow", by: "MacBook 1" })

    await s.send(call("run_command", { command: `rm "${keep}"` }))
    await until(async () => (await s.toolPart())?.state === "waiting")
    await s.respondAs("MacBook 1", "deny")
    await s.finished()
    expect(existsSync(keep)).toBe(true)
    expect((await s.toolPart())?.decision).toEqual({ answer: "deny", by: "MacBook 1" })
  })

  test("an approval answered in this window has no name; always-allow from a device is one allow, not remembered", async () => {
    const s = await setup()
    const first = join(s.t.dataDir, "w1.txt")
    writeFileSync(first, "1")
    await s.send(call("run_command", { command: `rm "${first}"` }))
    await s.waitingCard()
    await s.respond("allow")
    await s.finished()
    expect((await s.toolPart())?.decision).toBeUndefined()

    const second = join(s.t.dataDir, "w2.txt")
    writeFileSync(second, "2")
    await s.send(call("run_command", { command: `rm "${second}"` }))
    await until(async () => (await s.toolPart())?.state === "waiting")
    await s.respondAs("Phone", "always")
    await s.finished()
    // The step runs, and the card says who allowed it.
    expect(existsSync(second)).toBe(false)
    expect((await s.toolPart())?.decision).toEqual({ answer: "allow", by: "Phone" })

    // But a device cannot make "always": the next step of that kind asks again.
    const third = join(s.t.dataDir, "w3.txt")
    writeFileSync(third, "3")
    await s.send(call("run_command", { command: `rm "${third}"` }))
    expect(await s.waitingCard()).toMatchObject({ kind: "approval" })
    expect(existsSync(third)).toBe(true)
    await s.respond("deny")
    await s.finished()
  })

  test("a question answered by a linked device gives its answer to the model", async () => {
    const s = await setup()
    await s.send(call("ask_user", { question: "Colour?", choices: ["red", "blue"] }))
    expect(await s.waitingCard()).toMatchObject({ kind: "question" })
    await s.respondAs("MacBook 1", "blue")
    await s.finished()
    expect((await s.toolPart())?.output).toBe("blue")
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
      askedAt: expect.any(Number),
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

describe("browser", () => {
  test("pages open, read and act; the user holds the controls; stop closes the window", async () => {
    const s = await setup("full")
    await s.send(call("browser_open", { url: "https://example.com/a" }))
    await s.finished()
    expect(s.t.browserLog).toContain(`${s.agent.id}:open https://example.com/a`)
    const state = await s.run(Tools.use((x) => Effect.succeed(x.browserState(s.agent.id))))
    expect(state).toEqual({ open: true, control: false })
    await s.send(call("browser_read", {}))
    await s.finished()
    expect((await s.toolPart())?.output).toContain("Text of https://example.com/a")

    // While the user holds the controls, a step waits; giving back lets it go on.
    await s.run(Tools.use((x) => Effect.sync(() => x.setBrowserControl(s.agent.id, true))))
    await s.send(call("browser_click", { selector: "#go" }))
    await Bun.sleep(500)
    expect(s.t.browserLog.some((l) => l.endsWith("click #go"))).toBe(false)
    await s.run(Tools.use((x) => Effect.sync(() => x.setBrowserControl(s.agent.id, false))))
    await s.finished()
    expect(s.t.browserLog.some((l) => l.endsWith("click #go"))).toBe(true)

    // Stop while the user holds the controls closes the window within 2 seconds.
    await s.run(Tools.use((x) => Effect.sync(() => x.setBrowserControl(s.agent.id, true))))
    await s.send(call("browser_click", { selector: "#again" }))
    await Bun.sleep(300)
    const started = Date.now()
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(s.t.browserLog.at(-1)).toBe(`${s.agent.id}:close`)
  })

  test("a non-web address fails without opening", async () => {
    const s = await setup("full")
    await s.send(call("browser_open", { url: "file:///etc/passwd" }))
    await s.finished()
    expect((await s.toolPart())?.state).toBe("failed")
    expect(s.t.browserLog).toEqual([])
  })
})

describe("browser for an agent runtime", () => {
  // The program has no browser of its own. It calls the app, which answers like it does for an API agent.
  const open = async (permission: "ask_all" | "ask_risky" | "full") => {
    const s = await setup(permission)
    const shown: ToolEvent[] = []
    const asks: { callId: string; ask: unknown }[] = []
    const controller = new AbortController()
    const context: ToolContext = {
      agentId: s.agent.id,
      workspace: s.agent.workspace,
      permission,
      signal: controller.signal,
      onWaiting: (callId, ask) => asks.push({ callId, ask }),
      onMemory: () => {},
      onKnowledge: () => {},
      knowledgeChanges: { count: 0 },
    }
    const bridge = await s.run(
      Tools.use((x) => Effect.succeed(x.bridge(context, (event) => shown.push(event)))),
    )
    const states = () => shown.map((e) => `${e.state} ${e.call.id} ${e.call.name}`)
    return { s, bridge, shown, asks, controller, states }
  }

  test("offers the browser tools and nothing else", async () => {
    const { bridge } = await open("full")
    expect(bridge.tools.map((t) => t.name)).toEqual([...BRIDGE_TOOL_NAMES])
    expect(bridge.tools.every((t) => t.description && t.schema.type === "object")).toBe(true)
  })

  test("a call opens and reads the page, and shows one card for each call", async () => {
    const { s, bridge, states } = await open("full")
    const signal = new AbortController().signal
    const opened = await bridge.call("browser_open", { url: "https://example.com/a" }, signal)
    expect(opened.failed).toBe(false)
    expect(opened.output).toContain("Opened https://example.com/a")
    expect(s.t.browserLog).toContain(`${s.agent.id}:open https://example.com/a`)
    const read = await bridge.call("browser_read", {}, signal)
    expect(read.output).toContain("Text of https://example.com/a")
    expect(states()).toEqual([
      "running app-1 browser_open",
      "done app-1 browser_open",
      "running app-2 browser_read",
      "done app-2 browser_read",
    ])
    // The user sees the same window and can take the controls, as for an API agent.
    expect(await s.run(Tools.use((x) => Effect.succeed(x.browserState(s.agent.id))))).toEqual({
      open: true,
      control: false,
    })
  })

  test("a non-web address fails without opening, and the card says failed", async () => {
    const { s, bridge, states } = await open("full")
    const out = await bridge.call(
      "browser_open",
      { url: "file:///etc/passwd" },
      new AbortController().signal,
    )
    expect(out.failed).toBe(true)
    expect(s.t.browserLog).toEqual([])
    expect(states()).toEqual(["running app-1 browser_open", "failed app-1 browser_open"])
  })

  test("at ask for everything the app asks the user, and a deny keeps the browser closed", async () => {
    const { s, bridge, asks, states } = await open("ask_all")
    const signal = new AbortController().signal
    const first = bridge.call("browser_open", { url: "https://example.com/b" }, signal)
    await until(() => asks.some((a) => a.ask !== null))
    expect(asks[0]).toMatchObject({ callId: "app-1", ask: { kind: "approval" } })
    expect(s.t.browserLog).toEqual([])
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "allow")))
    expect((await first).failed).toBe(false)
    expect(s.t.browserLog).toContain(`${s.agent.id}:open https://example.com/b`)

    const second = bridge.call("browser_read", {}, signal)
    await until(() => asks.some((a) => a.callId === "app-2" && a.ask !== null))
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-2", "deny")))
    expect(await second).toEqual({ output: "The user denied this step.", failed: true })
    expect(states().at(-1)).toBe("failed app-2 browser_read")
  })

  test("at ask for risky steps a browser step does not ask", async () => {
    const { s, bridge, asks } = await open("ask_risky")
    await bridge.call(
      "browser_open",
      { url: "https://example.com/c" },
      new AbortController().signal,
    )
    expect(asks).toEqual([])
    expect(s.t.browserLog).toContain(`${s.agent.id}:open https://example.com/c`)
  })

  test("stop while a card waits ends the call, and the card is not left running", async () => {
    const { bridge, asks, controller, shown } = await open("ask_all")
    const pending = bridge.call(
      "browser_open",
      { url: "https://example.com/d" },
      new AbortController().signal,
    )
    await until(() => asks.some((a) => a.ask !== null))
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(shown.at(-1)).toMatchObject({ state: "failed", output: "Stopped." })
  })
})
