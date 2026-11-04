import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  ChatMessage,
  MessagePart,
  PermissionLevel,
  ToolAsk,
  ToolConnectionInput,
} from "@robot/shared"
import { Effect } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Connections } from "./Connections.ts"
import { Providers } from "./Providers.ts"
import { Rules } from "./Rules.ts"
import { Servers } from "./Servers.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

// The path of the connection tools in a turn (spec 018, 007), with the test program of the spec as
// the connection: card, rules, the level, outside content, the log, and the step "Search tools".

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

/** The names of the tools that each request of the model carried, in order. */
const requests: string[][] = []

/** A model that calls, in one reply, the tools listed in the user text ("CALLS [...]"), then answers. */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      tools?: { function: { name: string } }[]
      messages: { role: string; content: string | null }[]
    }
    requests.push((body.tools ?? []).map((t) => t.function.name))
    const last = body.messages.at(-1)
    if (last?.role === "tool")
      return sse([{ choices: [{ delta: { content: "Done." } }] }, "[DONE]"])
    const match = /CALLS (\[.*\])/.exec(String(last?.content ?? ""))
    if (!match) return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])
    const list = JSON.parse(match[1] as string) as { name: string; args: unknown }[]
    return sse([
      {
        choices: [
          {
            delta: {
              tool_calls: list.map((c, index) => ({
                index,
                id: `call_${index + 1}`,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
          },
        ],
      },
      "[DONE]",
    ])
  },
})
afterAll(() => server.stop())

const SERVER = join(import.meta.dir, "../../../e2e/fakes/mcp-server.mjs")
const calls = (...list: { name: string; args: unknown }[]) => `CALLS ${JSON.stringify(list)}`
const echo = (text = "hello") => ({ name: "mcp__notes__echo", args: { text } })

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const setup = async (permission: PermissionLevel = "ask_risky", tools = 0) => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-connections-test-key",
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
  const log = join(t.dataDir, "mcp-calls.jsonl")
  writeFileSync(log, "")
  const connect = async (name = "Notes") => {
    const connection: ToolConnectionInput = {
      name,
      kind: "program",
      command: process.execPath,
      args: [SERVER],
      // Not the temp folder: Bun starts slowly in a folder whose parent holds very many entries.
      folder: process.cwd(),
      env: [
        { name: "MCP_TEST_CALLS", value: log, secret: false },
        { name: "MCP_TEST_TOOLS", value: String(tools), secret: false },
      ],
      address: "",
      headers: [],
      agents: "all",
    }
    // A Test of the form, then Save: the tools that the Test showed are the reviewed tools, so a
    // turn gets them (spec 018, "Flows", "Tool review").
    await run(Connections.use((c) => c.test({ connection })))
    return await run(Connections.use((c) => c.save({ connection, confirmed: true })))
  }
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages
      .filter((m) => m.author === "agent")
      .at(-1)
  const part = async (callId: string) =>
    (await reply())?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === callId)
  const finished = () =>
    until(async () => !!(await reply()) && (await reply())?.status !== "streaming")
  const card = async (callId: string): Promise<ToolAsk | undefined> => {
    await until(async () => (await part(callId))?.state === "waiting")
    return (await part(callId))?.ask
  }
  const respond = (callId: string, answer: string) =>
    run(Tools.use((x) => x.respond(agent.id, callId, answer)))
  const entries = () => run(ActionLog.use((l) => l.list({})))
  const rules = () => run(Rules.use((r) => r.list()))
  /** What the test program got, as the connection called it. */
  const programCalls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> })
  return {
    run,
    agent,
    local,
    connect,
    send,
    reply,
    part,
    finished,
    card,
    respond,
    entries,
    rules,
    programCalls,
    t,
  }
}

describe("a call of a connection tool at Ask for risky steps", () => {
  test("asks with the connection, the tool and the arguments; Always allow saves one rule; the second call asks nothing; the log has two entries and no arguments", async () => {
    const s = await setup()
    await s.connect()
    await s.send(calls(echo("secret-looking-argument")))
    const ask = await s.card("call_1")
    // The card shows the connection name, the tool name and the arguments the agent wrote.
    expect(ask).toMatchObject({ kind: "approval" })
    expect((ask as { summary: string }).summary).toContain("Notes · echo")
    expect((ask as { summary: string }).summary).toContain("secret-looking-argument")
    expect((ask as { once?: boolean }).once).toBeUndefined()
    // The card knows which connection and tool it is about.
    expect((await s.part("call_1"))?.connection).toEqual({
      kind: "call",
      connection: "Notes",
      tool: "echo",
    })
    await s.respond("call_1", "always")
    await s.finished()
    const first = await s.part("call_1")
    expect(first?.state).toBe("done")
    // The agent got the result as data from outside.
    expect(first?.output).toContain("Echo: secret-looking-argument")
    expect(first?.output).toContain("data from outside")
    // One Allow rule for that one tool.
    const rules = await s.rules()
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      kind: "connection",
      text: "Notes",
      detail: "echo",
      decision: "allow",
      agentId: s.agent.id,
    })
    // A second call runs with no question.
    await s.send(calls(echo("again")))
    await s.finished()
    const second = await s.part("call_1")
    expect(second?.state).toBe("done")
    expect(second?.ruleAllowed).toBe(true)
    expect(s.programCalls()).toHaveLength(2)
    // The log has two entries, with the names and never the arguments.
    const log = await s.entries()
    expect(log).toHaveLength(2)
    for (const entry of log) {
      expect(entry).toMatchObject({ kind: "connection", target: "Notes · echo", result: "ran" })
      expect(JSON.stringify(entry)).not.toContain("again")
      expect(JSON.stringify(entry)).not.toContain("secret-looking-argument")
    }
    expect(log.map((e) => e.decidedBy).sort()).toEqual(["allow_rule", "user"])
  })

  test("Allow once saves no rule, and Deny gives the agent a failed step", async () => {
    const s = await setup()
    await s.connect()
    await s.send(calls(echo()))
    await s.card("call_1")
    await s.respond("call_1", "allow")
    await s.finished()
    expect(await s.rules()).toEqual([])
    await s.send(calls(echo("no")))
    await s.card("call_1")
    await s.respond("call_1", "deny")
    await s.finished()
    expect((await s.part("call_1"))?.output).toContain("denied")
    // The connection got only the first call.
    expect(s.programCalls()).toHaveLength(1)
    const log = await s.entries()
    expect(log.map((e) => e.result).sort()).toEqual(["ran", "refused"])
  })

  test("a Deny rule for any tool wins at Full access, and the card says it was denied by a rule", async () => {
    const s = await setup("full")
    await s.connect()
    await s.run(
      Rules.use((r) =>
        r.add({ agentId: null, kind: "connection", text: "Notes", detail: null, decision: "deny" }),
      ),
    )
    await s.send(calls(echo()))
    await s.finished()
    const card = await s.part("call_1")
    expect(card).toMatchObject({ state: "failed", refused: "rule" })
    expect(s.programCalls()).toEqual([])
    const entry = (await s.entries())[0]
    expect(entry).toMatchObject({ kind: "connection", decidedBy: "deny_rule", result: "refused" })
  })

  test("at Full access with no rule it runs with no question", async () => {
    const s = await setup("full")
    await s.connect()
    await s.send(calls(echo()))
    await s.finished()
    expect((await s.part("call_1"))?.state).toBe("done")
    expect(s.programCalls()).toHaveLength(1)
  })

  test("at Read only the call is refused, and an Allow rule does not open it", async () => {
    const s = await setup("read_only")
    await s.connect()
    await s.run(
      Rules.use((r) =>
        r.add({
          agentId: null,
          kind: "connection",
          text: "Notes",
          detail: "echo",
          decision: "allow",
        }),
      ),
    )
    await s.send(calls(echo()))
    await s.finished()
    expect(await s.part("call_1")).toMatchObject({ state: "failed", refused: "read_only" })
    expect(s.programCalls()).toEqual([])
    // The log names the connection and the tool also for a call that was refused.
    expect((await s.entries())[0]).toMatchObject({
      kind: "connection",
      target: "Notes · echo",
      decidedBy: "level",
      result: "refused",
    })
  })

  test("at Ask for everything it asks, also with an Allow rule for another tool", async () => {
    const s = await setup("ask_all")
    await s.connect()
    await s.send(calls(echo()))
    expect(await s.card("call_1")).toMatchObject({ kind: "approval" })
    await s.respond("call_1", "allow")
    await s.finished()
  })

  test("a Deny rule for one tool refuses that tool and not the others", async () => {
    const s = await setup("full")
    await s.connect()
    await s.run(
      Rules.use((r) =>
        r.add({
          agentId: null,
          kind: "connection",
          text: "notes",
          detail: "echo",
          decision: "deny",
        }),
      ),
    )
    await s.send(calls({ name: "mcp__notes__lookup", args: { word: "x" } }))
    await s.finished()
    expect((await s.part("call_1"))?.state).toBe("done")
    await s.send(calls(echo()))
    await s.finished()
    expect(await s.part("call_1")).toMatchObject({ refused: "rule" })
  })
})

describe("the result of a tool", () => {
  test("is outside content: the turn holds the mark, and a save to memory asks with the connection and the tool", async () => {
    const s = await setup("ask_risky")
    await s.connect()
    await s.run(
      Rules.use((r) =>
        r.add({
          agentId: null,
          kind: "connection",
          text: "Notes",
          detail: "echo",
          decision: "allow",
        }),
      ),
    )
    await s.send(calls(echo(), { name: "save_memory", args: { text: "The user likes tea." } }))
    const ask = await s.card("call_2")
    expect(ask).toMatchObject({
      kind: "approval",
      once: true,
      outside: { kind: "connection", connection: "Notes", tool: "echo" },
    })
    await s.respond("call_2", "deny")
    await s.finished()
    const log = await s.entries()
    expect(log.find((e) => e.kind === "memory")).toMatchObject({
      result: "refused",
      outside: { kind: "connection", connection: "Notes", tool: "echo" },
    })
  })

  test("is cut at 100000 characters, and the agent is told", async () => {
    const s = await setup("full")
    await s.connect()
    await s.send(calls({ name: "mcp__notes__big", args: {} }))
    await s.finished()
    const output = (await s.part("call_1"))?.output ?? ""
    expect(output).toContain("x".repeat(100_000))
    expect(output).not.toContain("x".repeat(100_001))
    expect(output).toContain("was cut")
  })

  test("a tool that says it failed is a failed step with its text", async () => {
    const s = await setup("full")
    await s.connect()
    await s.send(calls({ name: "mcp__notes__broken", args: {} }))
    await s.finished()
    const card = await s.part("call_1")
    expect(card?.state).toBe("failed")
    expect(card?.output).toContain("It failed on purpose.")
  })
})

describe("the tools an agent gets", () => {
  test("the first request holds the tools of the connection, and not the ones that are off", async () => {
    const s = await setup()
    const saved = await s.connect()
    await s.run(Connections.use((c) => c.setTool(saved.id, "slow", false)))
    requests.length = 0
    await s.send("hello")
    await s.finished()
    const names = requests[0] ?? []
    expect(names).toContain("mcp__notes__echo")
    expect(names).toContain("mcp__notes__lookup")
    expect(names).not.toContain("mcp__notes__slow")
    expect(names).not.toContain("search_tools")
    // The tools of the app are there as before.
    expect(names).toContain("read_file")
  })

  test("a connection that is down at the start: one muted line, the turn goes on, the other tools work", async () => {
    const s = await setup()
    const saved = await s.connect()
    await s.run(
      Connections.use((c) =>
        c.save({
          id: saved.id,
          connection: {
            name: "Notes",
            kind: "program",
            command: join(s.t.dataDir, "no-such-program"),
            args: [],
            folder: process.cwd(),
            env: [],
            address: "",
            headers: [],
            agents: "all",
          },
          confirmed: true,
        }),
      ),
    )
    requests.length = 0
    await s.send("hello")
    await s.finished()
    const parts = (await s.reply())?.parts ?? []
    const notes = parts.filter((p) => p.kind === "note")
    expect(notes).toEqual([{ kind: "note", note: "connection_down", name: "Notes" }])
    expect(parts.some((p) => p.kind === "text" && p.text === "ok")).toBe(true)
    expect(requests[0]).not.toContain("mcp__notes__echo")
    expect(requests[0]).toContain("read_file")
    expect((await s.run(Connections.use((c) => c.list)))[0]).toMatchObject({
      state: "error",
      failure: "not_found",
    })
  })

  test("a connection with no reviewed tools: one muted line, the turn goes on without its tools, the tools of the app work; Accept gives them (spec 018, Tool review)", async () => {
    const s = await setup()
    // Saved with no Test: nothing is reviewed, so every tool is held at the first start.
    const saved = await s.run(
      Connections.use((c) =>
        c.save({
          connection: {
            name: "Notes",
            kind: "program",
            command: process.execPath,
            args: [SERVER],
            folder: process.cwd(),
            env: [
              {
                name: "MCP_TEST_CALLS",
                value: join(s.t.dataDir, "mcp-calls.jsonl"),
                secret: false,
              },
            ],
            address: "",
            headers: [],
            agents: "all",
          },
          confirmed: true,
        }),
      ),
    )
    requests.length = 0
    await s.send("hello")
    await s.finished()
    const parts = (await s.reply())?.parts ?? []
    expect(parts.filter((p) => p.kind === "note")).toEqual([
      { kind: "note", note: "connection_held", name: "Notes" },
    ])
    expect(parts.some((p) => p.kind === "text" && p.text === "ok")).toBe(true)
    expect((requests[0] ?? []).some((n) => n.startsWith("mcp__"))).toBe(false)
    expect(requests[0]).toContain("read_file")
    // Accept all: the next turn has the tools and no line.
    const held = await s.run(Connections.use((c) => c.held(saved.id)))
    expect(held.length).toBeGreaterThan(0)
    await s.run(
      Connections.use((c) =>
        c.accept(
          saved.id,
          held.map(({ name, key }) => ({ name, key })),
        ),
      ),
    )
    requests.length = 0
    await s.send("hello again")
    await s.finished()
    expect(requests[0]).toContain("mcp__notes__echo")
    expect(((await s.reply())?.parts ?? []).filter((p) => p.kind === "note")).toEqual([])
  })

  test("an agent on a vendor runtime gets no connection", async () => {
    // The turn code asks the connections only for an agent of an API provider; the service gives
    // nothing to anyone else because Chat and Channels do not call it. Here: no agent uses it.
    const s = await setup()
    await s.connect()
    expect(await s.run(Connections.use((c) => Effect.sync(() => c.running())))).toEqual([])
  })
})

describe("many tools: the step Search tools", () => {
  test("with more than 20 tools the first request holds the step and none of the tools; a found tool asks as any tool; the log has one entry for the call and none for the search", async () => {
    // The test program offers 7 tools of its own and 20 more.
    const s = await setup("ask_risky", 20)
    await s.connect()
    requests.length = 0
    await s.send(
      calls(
        { name: "search_tools", args: { query: "weather" } },
        { name: "mcp__notes__weather_now", args: { city: "Seoul" } },
      ),
    )
    // The step "Search tools" needs no card; the call of the tool it found does.
    const ask = await s.card("call_2")
    expect(ask).toMatchObject({ kind: "approval" })
    expect(requests[0]).toEqual(expect.arrayContaining(["search_tools"]))
    expect(requests[0]).not.toContain("mcp__notes__echo")
    expect(requests[0]).not.toContain("mcp__notes__weather_now")
    await s.respond("call_2", "allow")
    await s.finished()
    const search = await s.part("call_1")
    expect(search?.state).toBe("done")
    expect(search?.output).toContain("mcp__notes__weather_now")
    expect(search?.connection).toEqual({ kind: "search", words: "weather", found: 1 })
    expect((await s.part("call_2"))?.output).toContain("Echo:")
    const log = await s.entries()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ kind: "connection", target: "Notes · weather_now" })
    // The request after the search holds the tool that was found.
    expect(requests[1]).toContain("mcp__notes__weather_now")
  })

  test("a search with no match says so; a tool that was not found fails and the connection gets no call", async () => {
    const s = await setup("full", 20)
    await s.connect()
    await s.send(
      calls(
        { name: "search_tools", args: { query: "zzzzqqqq" } },
        { name: "mcp__notes__echo", args: { text: "x" } },
      ),
    )
    await s.finished()
    expect((await s.part("call_1"))?.output).toBe("No tool found.")
    const second = await s.part("call_2")
    expect(second).toMatchObject({ state: "failed", output: "Unknown tool. Search for it first." })
    expect(s.programCalls()).toEqual([])
    // Nothing ran. (The entry count of a search is checked in the test above.)
    expect((await s.entries()).every((e) => e.result !== "ran")).toBe(true)
  })

  test("a tool found in one turn is not open in the next turn", async () => {
    const s = await setup("full", 20)
    await s.connect()
    await s.send(calls({ name: "search_tools", args: { query: "echo" } }))
    await s.finished()
    await s.send(calls(echo()))
    await s.finished()
    expect(await s.part("call_1")).toMatchObject({
      state: "failed",
      output: "Unknown tool. Search for it first.",
    })
    expect(s.programCalls()).toEqual([])
  })

  test("a Deny rule for any tool refuses a tool that was found", async () => {
    const s = await setup("full", 20)
    await s.connect()
    await s.run(
      Rules.use((r) =>
        r.add({ agentId: null, kind: "connection", text: "Notes", detail: null, decision: "deny" }),
      ),
    )
    await s.send(calls({ name: "search_tools", args: { query: "echo" } }, echo()))
    await s.finished()
    expect(await s.part("call_2")).toMatchObject({ state: "failed", refused: "rule" })
    expect(s.programCalls()).toEqual([])
  })

  test("with 20 tools or fewer there is no search step", async () => {
    const s = await setup("full", 0)
    await s.connect()
    await s.send(calls({ name: "search_tools", args: { query: "echo" } }))
    await s.finished()
    expect((await s.part("call_1"))?.output).toBe("Unknown tool: search_tools")
  })
})
