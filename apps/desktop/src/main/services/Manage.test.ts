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
import { AgentSettings } from "./AgentSettings.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat, type TaskOrigin } from "./Chat.ts"
import { Organizations } from "./Organizations.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { type ToolContext, Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

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
    // "THEN <text>" in a user text is the answer after the tool calls; "Done." when there is none.
    const then = body.messages
      .map((m) => /THEN (.*)$/s.exec(String(m.content ?? ""))?.[1])
      .findLast(Boolean)
    if (last?.role === "tool")
      return sse([{ choices: [{ delta: { content: then ?? "Done." } }] }, "[DONE]"])
    const match = /CALLS (\[.*?\])(?: THEN |$)/s.exec(String(last?.content ?? ""))
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

const NEW_WORKFLOW = {
  name: "Daily",
  steps: [
    { kind: "agent", agent: "Ada", prompt: "Summarize the day. ".repeat(200) },
    { kind: "notify", title: "Done" },
  ],
}

describe('the manage tool "make_workflow" of the main agent (spec 037, 010)', () => {
  const workflows = (s: Awaited<ReturnType<typeof setup>>) =>
    s.run(Workflows.use((w) => w.list(s.local.id)))

  test("the card shows the whole workflow; Allow makes it with the trigger manual", async () => {
    const s = await setup()
    const waiting = await s.sendAndSettle(call("make_workflow", NEW_WORKFLOW))
    expect(waiting?.state).toBe("waiting")
    const summary = (waiting?.ask as unknown as { summary: string } | undefined)?.summary ?? ""
    expect(summary).toContain("Daily")
    expect(summary).toContain(NEW_WORKFLOW.steps[0]?.prompt as string)
    expect(await workflows(s)).toEqual([])

    const done = await s.answer("allow")
    expect(done?.state).toBe("done")
    expect(done?.output).toContain("Daily")
    const [made] = await workflows(s)
    expect(made).toMatchObject({ name: "Daily", trigger: { kind: "manual" }, owner: null })
    expect(made?.steps.map((x) => x.kind)).toEqual(["agent", "notify"])
    expect(made?.edges).toHaveLength(1)
  })

  test("Deny makes no workflow", async () => {
    const s = await setup()
    await s.sendAndSettle(call("make_workflow", NEW_WORKFLOW))
    expect((await s.answer("deny"))?.state).toBe("failed")
    expect(await workflows(s)).toEqual([])
  })

  test("a second workflow with the same name gets a number", async () => {
    const s = await setup()
    await s.sendAndSettle(call("make_workflow", { name: "Daily" }))
    await s.answer("allow")
    await s.sendAndSettle(call("make_workflow", { name: "Daily" }))
    await s.answer("allow")
    expect((await workflows(s)).map((w) => w.name).sort()).toEqual(["Daily", "Daily 2"])
  })

  test("a call that fails a check makes no card and no workflow", async () => {
    const s = await setup()
    const part = await s.sendAndSettle(
      call("make_workflow", { name: "A", steps: [{ kind: "agent", agent: "Zed", prompt: "p" }] }),
    )
    expect(part?.state).toBe("failed")
    expect(part?.output).toStartWith("Nothing made.")
    expect(part?.output).toContain("Zed")
    expect(await workflows(s)).toEqual([])
  })

  test("at Read only the call is refused", async () => {
    const s = await setup("read_only")
    const part = await s.sendAndSettle(call("make_workflow", NEW_WORKFLOW))
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("Refused: read only")
    expect(await workflows(s)).toEqual([])
  })
})

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

describe("the team tools of a lead (spec 037, 030, 004)", () => {
  const madeBy = (s: Awaited<ReturnType<typeof setup>>, name: string, by: string | null) =>
    s.run(
      Agents.use((a) =>
        a.create(
          {
            serverId: s.local.id,
            name,
            role: "Writer",
            instructions: "Write.",
            model: { accountId: s.account.id, model: "mock-fast", effort: null },
          },
          by ? { madeBy: by } : undefined,
        ),
      ),
    )

  /** Ada leads the channel "Crew" with Bo; Ada is not the main agent. */
  const crew = async (permission: PermissionLevel = "ask_risky") => {
    const s = await setup(permission, false)
    const bo = await madeBy(s, "Bo", null)
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Crew",
          topic: "",
          memberIds: [s.agent.id, bo.id],
          leadId: s.agent.id,
        }),
      ),
    )
    const memberIds = async () => (await s.run(Channels.use((c) => c.get(channel.id)))).memberIds
    const find = async (name: string) =>
      (await s.run(Agents.use((a) => a.list(s.local.id, false)))).find((a) => a.name === name) ??
      (await s.run(Agents.use((a) => a.list(s.local.id, true)))).find((a) => a.name === name)
    const log = () => s.run(ActionLog.use((l) => l.list()))
    return { ...s, bo, channel, memberIds, find, log }
  }

  /** Ada leads the organization "Lab" with Bo, and leads no channel. */
  const lab = async () => {
    const s = await setup("ask_risky", false)
    const bo = await madeBy(s, "Bo", null)
    const org = await s.run(
      Organizations.use((o) =>
        o.create({
          serverId: s.local.id,
          name: "Lab",
          memberIds: [s.agent.id, bo.id],
          leadId: s.agent.id,
        }),
      ),
    )
    const memberIds = async () => (await s.run(Organizations.use((o) => o.get(org.id)))).memberIds
    return { ...s, bo, org, memberIds }
  }

  const offered = (name: string) =>
    bodies.some((b) => b.tools?.some((tool) => tool.function.name === name))

  test("make: no card; the member exists at once, joins the channel and shows Made by", async () => {
    const s = await crew()
    const part = await s.sendAndSettle(
      call("make_team_member", { ...NEW_AGENT, role: "Tester", permission: "ask_all" }),
    )
    expect(part?.state).toBe("done")
    expect(part?.ask).toBeUndefined()
    const rita = await s.find("Rita")
    expect(rita).toMatchObject({ role: "Tester", madeBy: "Ada", permission: "ask_all" })
    expect(await s.memberIds()).toContain(rita?.id ?? "")
    const [entry] = await s.log()
    expect(entry).toMatchObject({ kind: "team", decidedBy: "level", result: "ran" })
    expect(entry?.target).toContain("Crew")
    expect(entry?.target).toContain("Rita")
  })

  test("make: a permission level higher than the level of the lead is refused", async () => {
    const s = await crew()
    const part = await s.sendAndSettle(
      call("make_team_member", { ...NEW_AGENT, permission: "full" }),
    )
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("permission")
    expect(await s.find("Rita")).toBeUndefined()
  })

  test("change: the model changes at once, the chat shows a line, and Undo puts it back", async () => {
    const s = await crew()
    const part = await s.sendAndSettle(
      call("change_team_member", { member: "Bo", model: "o3-mini", role: "Editor" }),
    )
    expect(part?.state).toBe("done")
    expect(part?.ask).toBeUndefined()
    expect(await s.find("Bo")).toMatchObject({ role: "Editor", model: { model: "o3-mini" } })
    expect(part?.settings?.member?.id).toBe(s.bo.id)
    expect(part?.settings?.changes.map((c) => c.field).sort()).toEqual(["model", "role"])
    expect(await s.log()).toMatchObject([{ kind: "team", decidedBy: "level", result: "ran" }])
    const message = await s.reply()
    await s.run(AgentSettings.use((x) => x.undo(s.agent.id, message?.id ?? "", "call_1")))
    expect(await s.find("Bo")).toMatchObject({ role: "Writer", model: { model: "mock-fast" } })
  })

  test("change in a channel turn: the channel shows the line, and Undo puts it back", async () => {
    const s = await crew()
    await s.run(
      Channels.use((c) =>
        c.send(s.channel.id, call("change_team_member", { member: "Bo", role: "Editor" })),
      ),
    )
    const lead = async () =>
      (await s.run(Channels.use((c) => c.history(s.channel.id)))).find(
        (m) => m.agentId === s.agent.id && m.status === "done",
      )
    await until(async () => (await lead()) !== undefined)
    const message = await lead()
    const part = message?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === "call_1")
    expect(part?.state).toBe("done")
    expect((await s.find("Bo"))?.role).toBe("Editor")
    expect(part?.settings?.member?.id).toBe(s.bo.id)
    const id = message?.id ?? ""
    const state = (x: AgentSettings["Service"]) => x.lineState(s.agent.id, id, "call_1")
    expect(await s.run(AgentSettings.use(state))).toBe("ready")
    await s.run(AgentSettings.use((x) => x.undo(s.agent.id, id, "call_1")))
    expect((await s.find("Bo"))?.role).toBe("Writer")
    expect(await s.run(AgentSettings.use(state))).toBe("undone")
  })

  test("change in a channel turn, then a plan: the plan message keeps the line", async () => {
    const s = await crew()
    const plan = JSON.stringify({ plan: "Edit it.", parts: [{ member: "Bo", prompt: "Edit." }] })
    await s.run(
      Channels.use((c) =>
        c.send(
          s.channel.id,
          `${call("change_team_member", { member: "Bo", role: "Editor" })} THEN ${plan}`,
        ),
      ),
    )
    const planMessage = async () =>
      (await s.run(Channels.use((c) => c.history(s.channel.id)))).find((m) => m.kind === "plan")
    await until(async () => (await planMessage()) !== undefined)
    const message = await planMessage()
    const part = message?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === "call_1")
    expect(part?.settings?.member?.id).toBe(s.bo.id)
    expect(message?.parts.some((p) => p.kind === "text" && p.text.includes("Bo"))).toBe(true)
    const id = message?.id ?? ""
    await s.run(AgentSettings.use((x) => x.undo(s.agent.id, id, "call_1")))
    expect((await s.find("Bo"))?.role).toBe("Writer")
  })

  test("change: a permission level up to the level of the lead works, a higher one is refused", async () => {
    const s = await crew()
    const lower = await s.sendAndSettle(
      call("change_team_member", { member: "Bo", permission: "ask_all" }),
    )
    expect(lower?.state).toBe("done")
    expect((await s.find("Bo"))?.permission).toBe("ask_all")
    const higher = await s.sendAndSettle(
      call("change_team_member", { member: "Bo", permission: "full" }),
    )
    expect(higher?.state).toBe("failed")
    expect(higher?.output).toContain("permission")
    expect((await s.find("Bo"))?.permission).toBe("ask_all")
  })

  test("change: an app setting is not a field of a member", async () => {
    const s = await crew()
    const part = await s.sendAndSettle(call("change_team_member", { member: "Bo", theme: "dark" }))
    expect(part?.state).toBe("failed")
  })

  test("the lead itself, the main agent and an agent outside the team are refused", async () => {
    const s = await crew()
    const main = await madeBy(s, "Max", null)
    await s.run(Agents.use((a) => a.update(main.id, { isMain: true })))
    await s.run(
      Channels.use((c) => c.update(s.channel.id, { memberIds: [s.agent.id, s.bo.id, main.id] })),
    )
    await madeBy(s, "Zed", null)
    for (const member of ["Ada", "Max", "Zed"]) {
      for (const tool of [
        "change_team_member",
        "archive_team_member",
        "remove_team_member",
      ] as const) {
        const part = await s.sendAndSettle(
          call(tool, tool === "change_team_member" ? { member, role: "X" } : { member }),
        )
        expect(part?.state).toBe("failed")
      }
    }
    expect((await s.find("Max"))?.archived).toBe(false)
    expect((await s.find("Zed"))?.role).toBe("Writer")
    expect(await s.memberIds()).toContain(main.id)
  })

  test("remove: the member leaves the team and the agent stays", async () => {
    const s = await crew()
    const part = await s.sendAndSettle(call("remove_team_member", { member: "Bo" }))
    expect(part?.state).toBe("done")
    expect(await s.memberIds()).toEqual([s.agent.id])
    expect((await s.find("Bo"))?.archived).toBe(false)
    expect(await s.log()).toMatchObject([{ kind: "team", result: "ran" }])
  })

  test("archive and restore: at once, Undo of the archive restores, and no tool deletes", async () => {
    const s = await crew()
    const part = await s.sendAndSettle(call("archive_team_member", { member: "Bo" }))
    expect(part?.state).toBe("done")
    expect((await s.find("Bo"))?.archived).toBe(true)
    expect(part?.settings?.member?.id).toBe(s.bo.id)
    const message = await s.reply()
    await s.run(AgentSettings.use((x) => x.undo(s.agent.id, message?.id ?? "", "call_1")))
    expect((await s.find("Bo"))?.archived).toBe(false)
    await s.run(Agents.use((a) => a.archive(s.bo.id)))
    const back = await s.sendAndSettle(call("restore_team_member", { member: "Bo" }))
    expect(back?.state).toBe("done")
    expect((await s.find("Bo"))?.archived).toBe(false)
    const names = await s.run(
      Tools.use((x) =>
        Effect.sync(() =>
          x.defs({ memory: true, knowledge: false, team: true }).map((d) => d.name),
        ),
      ),
    )
    expect(names).toEqual(
      expect.arrayContaining([
        "make_team_member",
        "change_team_member",
        "remove_team_member",
        "archive_team_member",
        "restore_team_member",
      ]),
    )
    expect(names.some((n) => n.startsWith("delete"))).toBe(false)
  })

  test("at Read only the call is refused with no card, and the log says so", async () => {
    const s = await crew("read_only")
    const part = await s.sendAndSettle(call("make_team_member", NEW_AGENT))
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("Refused: read only")
    expect(part?.ask).toBeUndefined()
    expect(await s.find("Rita")).toBeUndefined()
    expect(await s.log()).toMatchObject([{ kind: "team", decidedBy: "level", result: "refused" }])
  })

  test("the 21st active member that the lead made is refused; after an archive the call works", async () => {
    const s = await crew()
    const ids = [s.agent.id, s.bo.id]
    for (let i = 0; i < 20; i++) ids.push((await madeBy(s, `Made${i}`, "Ada")).id)
    await s.run(Channels.use((c) => c.update(s.channel.id, { memberIds: ids })))
    const full = await s.sendAndSettle(call("make_team_member", NEW_AGENT))
    expect(full?.state).toBe("failed")
    expect(full?.output).toContain("Too many team members. Ask the user.")
    expect(await s.find("Rita")).toBeUndefined()
    const archived = await s.sendAndSettle(call("archive_team_member", { member: "Made0" }))
    expect(archived?.state).toBe("done")
    const made = await s.sendAndSettle(call("make_team_member", NEW_AGENT))
    expect(made?.state).toBe("done")
    expect(await s.find("Rita")).toBeDefined()
  })

  test("the lead of an organization gets the tools in its direct chat; the member joins the organization", async () => {
    const s = await lab()
    bodies.length = 0
    const part = await s.sendAndSettle(call("make_team_member", NEW_AGENT))
    expect(offered("make_team_member")).toBe(true)
    expect(offered("archive_team_member")).toBe(true)
    expect(part?.state).toBe("done")
    const rita = (await s.agents()).find((a) => a.name === "Rita")
    expect(await s.memberIds()).toContain(rita?.id ?? "")
    const removed = await s.sendAndSettle(call("remove_team_member", { member: "Bo" }))
    expect(removed?.state).toBe("done")
    expect(await s.memberIds()).not.toContain(s.bo.id)
  })

  test("a lead of more than one team names the team in each call", async () => {
    const s = await crew()
    await s.run(
      Organizations.use((o) =>
        o.create({
          serverId: s.local.id,
          name: "Lab",
          memberIds: [s.agent.id],
          leadId: s.agent.id,
        }),
      ),
    )
    const unnamed = await s.sendAndSettle(call("make_team_member", NEW_AGENT))
    expect(unnamed?.state).toBe("failed")
    expect(unnamed?.output).toContain("Crew")
    expect(unnamed?.output).toContain("Lab")
    const named = await s.sendAndSettle(call("make_team_member", { ...NEW_AGENT, team: "Lab" }))
    expect(named?.state).toBe("done")
    expect(await s.memberIds()).not.toContain((await s.find("Rita"))?.id)
  })

  test("an agent that leads no team gets neither the tools nor the calls", async () => {
    const s = await setup("ask_risky", false)
    bodies.length = 0
    const part = await s.sendAndSettle(call("make_team_member", NEW_AGENT))
    expect(offered("make_team_member")).toBe(false)
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("Unknown tool")
    expect(await s.names()).toEqual(["Ada"])
  })
})
