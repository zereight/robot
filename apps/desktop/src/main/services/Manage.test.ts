import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import {
  type ChatMessage,
  type MessagePart,
  newTurnMark,
  type PermissionLevel,
} from "@robot/shared"
import { Effect } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { Chat, type TaskOrigin } from "./Chat.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
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

/** The request bodies that reached the model, newest last. */
const bodies: { model: string; tools?: { function: { name: string } }[] }[] = []

/** A model that calls the tools listed in the user text ("CALLS [...]"), then answers. */
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [
          { id: "mock-fast" },
          { id: "o3-mini" },
          { id: "claude-sonnet-4-5" },
          { id: "claude-haiku-5-5" },
          { id: "claude-3-5-haiku-latest" },
        ],
      })
    const body = (await req.json()) as {
      model: string
      messages: { role: string; content: string | null }[]
    }
    bodies.push(body)
    const last = body.messages.at(-1)
    if (last?.role === "tool")
      return sse([{ choices: [{ delta: { content: "Done." } }] }, "[DONE]"])
    const match = /CALLS (\[.*\])/.exec(String(last?.content ?? ""))
    if (!match) return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])
    const calls = JSON.parse(match[1] as string) as { name: string; args: unknown }[]
    return sse([
      {
        choices: [
          {
            delta: {
              tool_calls: calls.map((c, index) => ({
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

const call = (name: string, args: unknown) => `CALLS ${JSON.stringify([{ name, args }])}`

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const NEW_AGENT = {
  name: "Rita",
  role: "Reviewer",
  instructions: "Read the diff. ".repeat(300),
  model: "o3-mini",
}

/** One agent, "Ada", that is the main agent of the server when `main` is true. */
const setup = async (permission: PermissionLevel = "ask_risky", main = true) => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-manage-test-key",
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
        model: { accountId: account.id, model: "mock-fast", effort: null },
      }),
    ),
  )
  await run(
    Agents.use((a) => a.update(agent.id, { permission, ...(main ? { isMain: true } : {}) })),
  )
  mkdirSync(agent.workspace, { recursive: true })
  const send = (text: string, origin?: TaskOrigin) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null }, origin)))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages
      .filter((m) => m.author === "agent")
      .at(-1)
  const part = async (callId = "call_1") =>
    (await reply())?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === callId)
  const agents = () => run(Agents.use((a) => a.list(local.id, false)))
  const names = async () => (await agents()).map((a) => a.name).sort()
  /** Sends a text and waits until the call of the tool waits for the user, or the reply is done. */
  const sendAndSettle = async (text: string) => {
    await send(text)
    await until(async () => {
      const p = await part()
      return p?.state === "waiting" || p?.state === "done" || p?.state === "failed"
    })
    return part()
  }
  const answer = async (value: "allow" | "deny") => {
    await run(Tools.use((x) => x.respond(agent.id, "call_1", value)))
    await until(async () => (await reply())?.status === "done")
    return part()
  }
  return { t, run, agent, local, account, send, reply, part, names, agents, sendAndSettle, answer }
}

describe('the manage tool "make_agent" of the main agent (spec 037)', () => {
  test('the call asks with the whole change; Allow makes the agent with the mark "Made by"', async () => {
    const s = await setup()
    const waiting = await s.sendAndSettle(call("make_agent", NEW_AGENT))
    expect(waiting?.state).toBe("waiting")
    expect(waiting?.ask).toMatchObject({ kind: "approval", once: true })
    const summary = (waiting?.ask as unknown as { summary: string } | undefined)?.summary ?? ""
    expect(summary).toContain("Rita")
    expect(summary).toContain("Reviewer")
    // The card cuts no value, also a long instruction.
    expect(summary).toContain(NEW_AGENT.instructions)
    expect(await s.names()).toEqual(["Ada"])

    const done = await s.answer("allow")
    expect(done?.state).toBe("done")
    expect(done?.output).toContain("Rita")
    expect(await s.names()).toEqual(["Ada", "Rita"])
    const made = (await s.agents()).find((a) => a.name === "Rita")
    expect(made).toMatchObject({
      role: "Reviewer",
      instructions: NEW_AGENT.instructions,
      madeBy: "Ada",
      model: { accountId: s.account.id, model: "o3-mini" },
    })
    // The level and the workspace are the defaults of the form of a new agent.
    expect(made?.permission).toBe("ask_risky")
    expect(await s.run(ActionLog.use((l) => l.list()))).toMatchObject([
      { kind: "manage", decidedBy: "user", result: "ran" },
    ])
  })

  test("Deny makes no agent, and the step fails", async () => {
    const s = await setup()
    await s.sendAndSettle(call("make_agent", NEW_AGENT))
    const done = await s.answer("deny")
    expect(done?.state).toBe("failed")
    expect(await s.names()).toEqual(["Ada"])
    expect(await s.run(ActionLog.use((l) => l.list()))).toMatchObject([
      { kind: "manage", decidedBy: "user", result: "refused" },
    ])
  })

  test("Full access still asks", async () => {
    const s = await setup("full")
    const waiting = await s.sendAndSettle(call("make_agent", NEW_AGENT))
    expect(waiting?.state).toBe("waiting")
    expect(await s.names()).toEqual(["Ada"])
  })

  test("a turn that holds outside content shows its source on the card", async () => {
    const s = await setup()
    // A turn that a watch routine starts holds outside content from its start (spec 007).
    await s.send(call("make_agent", NEW_AGENT), {
      source: "routine",
      sourceId: "r1",
      outside: { kind: "routine", name: "Watch prices" },
    })
    await until(async () => (await s.part())?.state === "waiting")
    expect((await s.part())?.ask).toMatchObject({
      kind: "approval",
      once: true,
      outside: { kind: "routine", name: "Watch prices" },
    })
  })

  test("at Read only the call is refused with no card, and the log says so", async () => {
    const s = await setup("read_only")
    const part = await s.sendAndSettle(call("make_agent", NEW_AGENT))
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("Refused: read only")
    expect(await s.names()).toEqual(["Ada"])
    expect(await s.run(ActionLog.use((l) => l.list()))).toMatchObject([
      { kind: "manage", decidedBy: "level", result: "refused" },
    ])
  })

  test("a call that fails a check makes no card and no agent", async () => {
    const s = await setup()
    const part = await s.sendAndSettle(call("make_agent", { ...NEW_AGENT, name: "Ada" }))
    expect(part?.state).toBe("failed")
    expect(part?.output).toStartWith("Nothing made.")
    expect(part?.output).toContain("Another agent")
    const field = await s.sendAndSettle(call("make_agent", { ...NEW_AGENT, permission: "full" }))
    expect(field?.state).toBe("failed")
    expect(field?.output).toContain("permission")
    expect(await s.names()).toEqual(["Ada"])
    expect(await s.run(ActionLog.use((l) => l.list()))).toEqual([])
  })

  test("only the main agent has the tools", async () => {
    const main = await setup()
    const other = await setup("ask_risky", false)
    const names = (s: typeof main, manage: boolean) =>
      s.run(
        Tools.use((x) =>
          Effect.sync(() => x.defs({ memory: true, knowledge: false, manage }).map((d) => d.name)),
        ),
      )
    expect(await names(main, true)).toEqual(expect.arrayContaining(["make_agent", "read_agent"]))
    expect(await names(other, false)).not.toContain("make_agent")
    expect(await names(other, false)).not.toContain("read_agent")
    // The chat offers the tools to the main agent only.
    const offered = (name: string) =>
      bodies.some((b) => b.tools?.some((tool) => tool.function.name === name))
    bodies.length = 0
    await other.sendAndSettle(call("list_agents", {}))
    expect(offered("make_agent")).toBe(false)
    bodies.length = 0
    await main.sendAndSettle(call("list_agents", {}))
    expect(offered("make_agent")).toBe(true)
    expect(offered("read_agent")).toBe(true)
    // A model that is not the main agent calls the tool anyway: the app does not know it.
    const part = await other.sendAndSettle(call("make_agent", NEW_AGENT))
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("Unknown tool")
    expect(await other.names()).toEqual(["Ada"])
  })
})

describe('the manage tool "read_agent" (spec 037)', () => {
  test("it reads the fields of another agent and needs no card, also at Read only", async () => {
    const s = await setup("read_only")
    await s.run(
      Agents.use((a) =>
        a.create({
          serverId: s.local.id,
          name: "Bo",
          role: "Tester",
          instructions: "Run the tests.",
          model: { accountId: s.account.id, model: "mock-fast", effort: null },
        }),
      ),
    )
    const part = await s.sendAndSettle(call("read_agent", { name: "bo" }))
    expect(part?.state).toBe("done")
    expect(part?.output).toContain("Bo")
    expect(part?.output).toContain("Tester")
    expect(part?.output).toContain("Run the tests.")
    expect(part?.output).toContain("mock-fast")
    expect(await s.run(ActionLog.use((l) => l.list()))).toEqual([])
    const missing = await s.sendAndSettle(call("read_agent", { name: "Nobody" }))
    expect(missing?.state).toBe("failed")
  })
})

describe("an agent on a vendor runtime (the tools that the program calls through the app)", () => {
  const bridgeOf = (s: Awaited<ReturnType<typeof setup>>) => {
    const context: ToolContext = {
      agentId: s.agent.id,
      workspace: s.agent.workspace,
      permission: "full",
      signal: new AbortController().signal,
      onWaiting: () => {},
      onMemory: () => {},
      onKnowledge: () => {},
      knowledgeChanges: { count: 0 },
      turn: newTurnMark("user"),
      taskId: null,
    }
    return s.run(Tools.use((x) => Effect.succeed(x.bridge(context, () => {}))))
  }

  test("the main agent gets the manage tools, and a read works", async () => {
    const s = await setup()
    const bridge = await bridgeOf(s)
    const names = bridge.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["make_agent", "read_agent", "list_agents"]))
    const signal = new AbortController().signal
    const read = await bridge.call("read_agent", { name: "Ada" }, signal)
    expect(read.failed).toBe(false)
    expect(read.output).toContain("Be brief.")
  })

  test("another agent does not get them, and a call is unknown to the app", async () => {
    const s = await setup("ask_risky", false)
    const bridge = await bridgeOf(s)
    const names = bridge.tools.map((t) => t.name)
    expect(names).not.toContain("make_agent")
    expect(names).not.toContain("read_agent")
    const signal = new AbortController().signal
    const made = await bridge.call("make_agent", NEW_AGENT, signal)
    expect(made.failed).toBe(true)
    expect(made.output).toContain("Unknown tool")
    expect(await s.names()).toEqual(["Ada"])
  })
})
