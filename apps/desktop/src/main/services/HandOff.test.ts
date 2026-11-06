import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type ChatMessage,
  HAND_OFF_HINT,
  HAND_OFF_LIST_EMPTY,
  HAND_OFF_LIST_RULE,
  LEAD_ORDER_WORDS,
  MAIN_AGENT_HAND_OFF_RULE,
  type MessagePart,
  newTurnMark,
} from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Organization } from "./Organization.ts"
import { Organizations } from "./Organizations.ts"
import { OrgChart } from "./OrgChart.ts"
import { Providers } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { type ToolContext, Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

// The hand-off rule (spec 030, "Who can send to whom"): the app checks each "send message" at the
// time of the send. The acceptance setup: main agent M; the organization "Product" with lead P;
// "Docs" under "Product" with lead D and member A; X in no organization. A channel "Docs" holds D
// and A too: a channel gives no right to send.

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

let callCount = 0
const toolCalls = (calls: { name: string; args: unknown }[]) => {
  const ids = calls.map(() => `call_${++callCount}`)
  return sse([
    ...calls.map((c, index) => ({
      choices: [
        {
          delta: {
            tool_calls: [{ index, id: ids[index], function: { name: c.name, arguments: "" } }],
          },
        },
      ],
    })),
    ...calls.map((c, index) => ({
      choices: [
        { delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(c.args) } }] } },
      ],
    })),
    "[DONE]",
  ])
}

const text = (content: string) =>
  sse([
    { choices: [{ delta: { content } }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    "[DONE]",
  ])

/** The system text of each request, in order. */
const systems: string[] = []

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string | null }[] }
    systems.push(String(body.messages.find((m) => m.role === "system")?.content ?? ""))
    const last = body.messages.at(-1)
    // A turn that starts with "SLOW" stays open for a short time, so a test can change the rule
    // while it works.
    if (/SLOW/.test(String(last?.content ?? ""))) await Bun.sleep(600)
    if (/^Message from[\s\S]*BLOCKME/.test(String(last?.content ?? "")))
      return text("I tried.\nBlocked: no access to the repository")
    if (last?.role === "tool") return text("done")
    const many = /CALLS (\[.*\])/.exec(String(last?.content ?? ""))
    if (many) return toolCalls(JSON.parse(many[1] as string))
    return text("ok")
  },
})
afterAll(() => server.stop())

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out")
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const setup = async (options: { main?: boolean } = {}) => {
  const main = options.main ?? true
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-hand-off-test-key",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agents = new Map<string, Awaited<ReturnType<typeof makeAgent>>>()
  const makeAgent = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: `${name} works.`,
          instructions: "Work.",
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  for (const name of ["M", "P", "D", "A", "X"]) {
    const agent = await makeAgent(name)
    await run(Agents.use((a) => a.update(agent.id, { permission: "full" })))
    mkdirSync(agent.workspace, { recursive: true })
    agents.set(name, agent)
  }
  const agent = (name: string) => agents.get(name) as NonNullable<ReturnType<typeof agents.get>>
  // The real switch "Main agent" (spec 002, flow 7), as the profile sets it.
  if (main) await run(Agents.use((a) => a.update(agent("M").id, { isMain: true })))
  const channel = (name: string, memberIds: string[], leadId: string | null) =>
    run(
      Channels.use((c) =>
        c.create({
          serverId: local.id,
          name,
          topic: "",
          memberIds: memberIds.map((n) => agent(n).id),
          leadId: leadId ? agent(leadId).id : null,
        }),
      ),
    )
  const organization = (
    name: string,
    memberIds: string[],
    leadId: string | null,
    parentId: string | null = null,
  ) =>
    run(
      Organizations.use((o) =>
        o.create({
          serverId: local.id,
          name,
          memberIds: memberIds.map((n) => agent(n).id),
          leadId: leadId ? agent(leadId).id : null,
          parentId,
        }),
      ),
    )
  const range = (orgId: string, value: "inherit" | "own" | "own_lower" | "all") =>
    run(Organizations.use((o) => o.update(orgId, { handOffRange: value })))
  /** A new agent, for a test that needs more than the five of the setup. */
  const extra = async (name: string) => {
    const made = await makeAgent(name)
    await run(Agents.use((a) => a.update(made.id, { permission: "full" })))
    mkdirSync(made.workspace, { recursive: true })
    agents.set(name, made)
    return made
  }
  const product = await organization("Product", ["P"], "P")
  const docsOrg = await organization("Docs", ["D", "A"], "D", product.id)
  // A channel with the same members. It gives no right to send (spec 030).
  const docs = await channel("Docs", ["D", "A"], "D")

  const send = (name: string, message: string) =>
    run(Chat.use((c) => c.send({ agentId: agent(name).id, text: message, replyTo: null })))
  const messages = async (name: string): Promise<readonly ChatMessage[]> =>
    (await run(Chat.use((c) => c.history(agent(name).id)))).messages
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const quiet = async () => {
    await until(async () => {
      const all = await tasks()
      return all.length > 0 && all.every((x) => !["queued", "running", "waiting"].includes(x.state))
    })
  }
  const rule = (value: "any" | "organizations") => run(Organization.use((o) => o.setHandOff(value)))
  /** The newest step of an agent. A reply to its message can come later and has no step. */
  const lastStep = async (name: string): Promise<ToolPart> => {
    const steps = (await messages(name))
      .filter((m) => m.author === "agent")
      .flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.kind === "tool")
    const step = steps.at(-1)
    if (!step) throw new Error(`${name} has no step`)
    return step
  }
  /** The agent calls a tool in a turn; the turn ends; the step is returned. */
  const call = async (name: string, tool: string, args: unknown) => {
    const before = (await tasks()).length
    await send(name, `CALLS ${JSON.stringify([{ name: tool, args }])}`)
    await until(async () => (await tasks()).length > before)
    await quiet()
    return lastStep(name)
  }
  /** The tasks that another agent made for `name` with "send message". */
  const received = async (name: string) =>
    (await tasks()).filter((x) => x.agentId === agent(name).id && x.source === "agent")
  const logLines = () => {
    try {
      return readFileSync(join(t.dataDir, "logs", "organizations.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  return {
    t,
    run,
    local,
    agent,
    docs,
    channel,
    organization,
    product,
    docsOrg,
    range,
    extra,
    send,
    call,
    tasks,
    quiet,
    rule,
    received,
    logLines,
    lastStep,
  }
}

describe('rule "Any agent" (the default)', () => {
  test("the rule starts as Any agent; an agent in an organization sends to an agent in none", async () => {
    const s = await setup()
    expect(await s.run(Organization.use((o) => o.get))).toEqual({
      handOff: "any",
      askUpTheLine: false,
    })
    const step = await s.call("A", "send_message", { to: "X", text: "hello" })
    expect(step.state).toBe("done")
    expect(step.reason).toBeUndefined()
    expect(await s.received("X")).toHaveLength(1)
  })

  test('"list agents" lists every other agent and says nothing of the rule', async () => {
    const s = await setup()
    const step = await s.call("A", "list_agents", {})
    expect(step.output).not.toContain(HAND_OFF_LIST_RULE)
    for (const name of ["M", "P", "D", "X"]) expect(step.output).toContain(`- ${name}:`)
  })
})

describe('rule "Along the organizations"', () => {
  test("allowed sends start a task: A to D, A to M, D to P, P to D, M to A, and the reply comes back", async () => {
    const s = await setup()
    await s.rule("organizations")
    for (const [from, to] of [
      ["A", "D"],
      ["A", "M"],
      ["D", "P"],
      ["P", "D"],
      ["M", "A"],
    ] as const) {
      const before = (await s.received(to)).length
      const step = await s.call(from, "send_message", { to, text: `hi ${to}` })
      expect(step.state, `${from} to ${to}`).toBe("done")
      expect((await s.received(to)).length, `${from} to ${to}`).toBe(before + 1)
    }
    // M sent to A, and A replied: the reply is a task for M from A.
    await s.quiet()
    const back = (await s.received("M")).filter((x) => x.sourceId === s.agent("A").id)
    expect(back.length).toBeGreaterThanOrEqual(1)
  })

  test("A to P fails with the first agent on the path; no task starts and the chart draws no line", async () => {
    const s = await setup()
    await s.rule("organizations")
    const before = (await s.tasks()).length
    const step = await s.call("A", "send_message", { to: "P", text: "SECRET-TEXT-123" })
    expect(step.state).toBe("failed")
    expect(step.output).toBe(`P is not on your path. Send it to D.\n${HAND_OFF_HINT}`)
    expect(step.reason).toEqual({ code: "hand_off_path", detail: "P", next: "D" })
    // Only the task of the chat of A exists: no task for P, and none for D.
    expect((await s.tasks()).length).toBe(before + 1)
    expect(await s.received("P")).toHaveLength(0)
    const chart = await s.run(OrgChart.use((o) => o.snapshot()))
    expect(chart.handoffs).toEqual([])
    // The turn of A went on: it ended with a reply.
    const reply = await s.run(Chat.use((c) => c.history(s.agent("A").id)))
    expect(reply.messages.at(-1)?.status).toBe("done")
  })

  test("X in no organization to A: send it to M; with no main agent, no agent can pass it on", async () => {
    const s = await setup()
    await s.rule("organizations")
    const step = await s.call("X", "send_message", { to: "A", text: "hi" })
    expect(step.output).toBe(`A is not on your path. Send it to M.\n${HAND_OFF_HINT}`)
    expect(step.reason).toEqual({ code: "hand_off_path", detail: "A", next: "M" })

    const none = await setup({ main: false })
    await none.rule("organizations")
    const refused = await none.call("X", "send_message", { to: "A", text: "hi" })
    expect(refused.state).toBe("failed")
    expect(refused.output).toBe(
      `A is not on your path, and no agent can pass it on. Tell the user.\n${HAND_OFF_HINT}`,
    )
    expect(refused.reason).toEqual({ code: "hand_off_none", detail: "A" })
    expect(await none.received("A")).toHaveLength(0)
  })

  test("the switch 'Main agent' counts from the next send: turned off, X cannot reach A; turned on for A, X reaches A (rules 2 and 3)", async () => {
    const s = await setup()
    await s.rule("organizations")
    const off = async (name: string) =>
      s.run(Agents.use((a) => a.update(s.agent(name).id, { isMain: false })))
    const on = async (name: string) =>
      s.run(Agents.use((a) => a.update(s.agent(name).id, { isMain: true })))
    // Rule 2: every agent may send to the main agent. Rule 3: the main agent may send to every agent.
    const m = await s.call("X", "send_message", { to: "M", text: "one" })
    expect(m.state).toBe("done")
    await off("M")
    const refused = await s.call("X", "send_message", { to: "M", text: "two" })
    expect(refused.state).toBe("failed")
    expect(refused.reason).toMatchObject({ code: "hand_off_none", detail: "M" })
    // A is the main agent now: X reaches A, and M, which lost the flag, is a plain agent again.
    await on("A")
    const toA = await s.call("X", "send_message", { to: "A", text: "three" })
    expect(toA.state).toBe("done")
    const toM = await s.call("X", "send_message", { to: "M", text: "four" })
    expect(toM.state).toBe("failed")
    // Rule 3: A, now the main agent, sends to P, which no shared organization links to A.
    const fromA = await s.call("A", "send_message", { to: "P", text: "five" })
    expect(fromA.state).toBe("done")
  })

  test("a refused send writes one line to the organization log, with no text of the message", async () => {
    const s = await setup()
    await s.rule("organizations")
    await s.call("A", "send_message", { to: "P", text: "SECRET-TEXT-123" })
    const lines = s.logLines().filter((l) => l.event === "hand_off_refused")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ event: "hand_off_refused", from: "A", to: "P" })
    expect(typeof lines[0]?.time).toBe("string")
    expect(JSON.stringify(lines)).not.toContain("SECRET-TEXT-123")
    // An allowed send writes no such line.
    await s.call("A", "send_message", { to: "D", text: "hi" })
    expect(s.logLines().filter((l) => l.event === "hand_off_refused")).toHaveLength(1)
  })

  test('"list agents" holds D and M only, with the organization and the main agent, and tells that the rule is on', async () => {
    const s = await setup()
    await s.rule("organizations")
    const step = await s.call("A", "list_agents", {})
    expect(step.output).toContain(HAND_OFF_LIST_RULE)
    const rows = step.output.split("\n").filter((l) => l.startsWith("- "))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain("- D:")
    expect(rows[0]).toContain("organization: Docs")
    expect(rows[1]).toContain("- M:")
    expect(rows[1]).toContain("main agent")
    expect(step.output).not.toContain("- P:")
    expect(step.output).not.toContain("- X:")
  })

  test("an agent in no organization lists the main agent only; with none, the list says it can send to no agent", async () => {
    const s = await setup()
    await s.rule("organizations")
    const listed = await s.call("X", "list_agents", {})
    expect(listed.output.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1)
    expect(listed.output).toContain("- M:")

    const none = await setup({ main: false })
    await none.rule("organizations")
    const empty = await none.call("X", "list_agents", {})
    expect(empty.output).toBe(HAND_OFF_LIST_EMPTY)
  })

  test("the main agent lists every agent", async () => {
    const s = await setup()
    await s.rule("organizations")
    const step = await s.call("M", "list_agents", {})
    const rows = step.output.split("\n").filter((l) => l.startsWith("- "))
    expect(rows.map((r) => r.slice(2, 3))).toEqual(["A", "D", "P", "X"])
  })

  test("a change of the rule counts from the next send", async () => {
    const s = await setup()
    await s.rule("organizations")
    expect((await s.call("A", "send_message", { to: "P", text: "1" })).state).toBe("failed")
    await s.rule("any")
    expect((await s.call("A", "send_message", { to: "P", text: "2" })).state).toBe("done")
    expect(await s.received("P")).toHaveLength(1)
    await s.rule("organizations")
    expect((await s.call("A", "send_message", { to: "P", text: "3" })).state).toBe("failed")
    expect(await s.received("P")).toHaveLength(1)
  })

  test("an archived receiver gets the older reason, before the rule is read", async () => {
    const s = await setup()
    await s.rule("organizations")
    await s.run(Agents.use((a) => a.archive(s.agent("D").id)))
    const step = await s.call("A", "send_message", { to: "D", text: "hi" })
    expect(step.output).toBe("This agent is archived. Choose another agent.")
  })

  test("the reply always comes back: a receiver that the rule would refuse still answers", async () => {
    const s = await setup()
    // A sends to X while the rule is off. X is in no organization, so under the rule X could not send
    // to A. X is still working when the user turns the rule on.
    const sent = s.send(
      "A",
      `CALLS ${JSON.stringify([{ name: "send_message", args: { to: "X", text: "SLOW hi" } }])}`,
    )
    await sent
    await until(async () => (await s.received("X")).length === 1)
    await s.rule("organizations")
    await s.quiet()
    // The reply of X is a task for A: it was not refused, and no refusal was written.
    const back = (await s.received("A")).filter((x) => x.sourceId === s.agent("X").id)
    expect(back.length).toBeGreaterThanOrEqual(1)
    expect(s.logLines().filter((l) => l.event === "hand_off_refused")).toHaveLength(0)
    // A send of X to A is refused under the rule: a reply is not a send.
    const step = await s.call("X", "send_message", { to: "A", text: "again" })
    expect(step.output).toBe(`A is not on your path. Send it to M.\n${HAND_OFF_HINT}`)
  })

  test("the rule does not touch the work of the user: a direct chat, a mention, @all and a routine", async () => {
    const s = await setup()
    await s.rule("organizations")
    // A direct chat with an agent in no organization.
    await s.send("X", "hello")
    await s.quiet()
    expect((await s.tasks()).some((x) => x.agentId === s.agent("X").id)).toBe(true)
    // A mention and @all in a channel. The list of tasks is newest first, so new tasks are found
    // by their id.
    const newTasks = async (known: Set<string>) => (await s.tasks()).filter((x) => !known.has(x.id))
    const known = new Set((await s.tasks()).map((x) => x.id))
    await s.run(Channels.use((c) => c.send(s.docs.id, "@A say hi")))
    await s.quiet()
    const mentioned = await newTasks(known)
    expect(mentioned.map((x) => x.agentId)).toEqual([s.agent("A").id])
    for (const x of mentioned) known.add(x.id)
    await s.run(Channels.use((c) => c.send(s.docs.id, "@all say hi")))
    await s.quiet()
    const all = await newTasks(known)
    expect(all.map((x) => x.agentId).sort()).toEqual([s.agent("A").id, s.agent("D").id].sort())
    // A routine of an agent in no organization.
    const routine = await s.run(
      Routines.use((r) =>
        r.create({
          serverId: s.local.id,
          agentId: s.agent("X").id,
          name: "Check",
          prompt: "Look.",
          schedule: { kind: "every", minutes: 60, from: Date.now() },
          place: { kind: "agent" },
        }),
      ),
    )
    const routines = (await s.tasks()).length
    await s.run(Routines.use((r) => r.runNow(routine.id)))
    await s.quiet()
    expect((await s.tasks()).length).toBeGreaterThan(routines)
    // No send was refused, and no task came from another agent.
    expect(s.logLines().filter((l) => l.event === "hand_off_refused")).toHaveLength(0)
    expect((await s.tasks()).filter((x) => x.source === "agent")).toHaveLength(0)
  })

  test("a refused send counts for no limit: the chain limit is not used", async () => {
    const s = await setup()
    await s.rule("organizations")
    // Many refused sends in a row leave the queue of P empty and make no task for it.
    for (let i = 0; i < 3; i++) await s.call("A", "send_message", { to: "P", text: `try ${i}` })
    expect(await s.received("P")).toHaveLength(0)
    expect((await s.tasks()).filter((x) => x.source === "agent")).toHaveLength(0)
  })
})

describe("a channel gives no right to send, and the range of an organization does (spec 030)", () => {
  test("a channel has A and X as members: A still cannot send to X", async () => {
    const s = await setup()
    await s.rule("organizations")
    await s.channel("Chat", ["A", "X"], null)
    const step = await s.call("A", "send_message", { to: "X", text: "hi" })
    expect(step.state).toBe("failed")
    expect(step.output).toBe(`X is not on your path. Send it to M.\n${HAND_OFF_HINT}`)
    expect(await s.received("X")).toHaveLength(0)
  })

  test("'Own and lower organizations' on Product: P sends to A, A sends to a member of Site, A cannot send to P", async () => {
    const s = await setup()
    await s.rule("organizations")
    await s.extra("Q")
    await s.organization("Site", ["Q"], null, s.docsOrg.id)
    // Before the range: P cannot send to A.
    expect((await s.call("P", "send_message", { to: "A", text: "0" })).state).toBe("failed")
    await s.range(s.product.id, "own_lower")
    // The range of Docs is "Inherit": it takes the value of Product.
    const toA = await s.call("P", "send_message", { to: "A", text: "1" })
    expect(toA.state).toBe("done")
    expect(await s.received("A")).toHaveLength(1)
    const toQ = await s.call("A", "send_message", { to: "Q", text: "2" })
    expect(toQ.state).toBe("done")
    expect(await s.received("Q")).toHaveLength(1)
    // There is no way up. P holds the reply of A to its own message; the refused send adds no task.
    const forP = (await s.received("P")).length
    const toP = await s.call("A", "send_message", { to: "P", text: "3" })
    expect(toP.state).toBe("failed")
    expect(toP.output).toBe(`P is not on your path. Send it to D.\n${HAND_OFF_HINT}`)
    expect(await s.received("P")).toHaveLength(forP)
    // "list agents" names the organization that holds the range.
    const listed = await s.call("A", "list_agents", {})
    const row = listed.output.split("\n").find((l) => l.startsWith("- Q:"))
    expect(row).toContain("organization: Docs")
  })

  test("'All agents' on Site: a member of Site sends to X, a member of Docs still cannot", async () => {
    const s = await setup()
    await s.rule("organizations")
    await s.extra("Q")
    const site = await s.organization("Site", ["Q"], null, s.docsOrg.id)
    await s.range(site.id, "all")
    expect((await s.call("Q", "send_message", { to: "X", text: "1" })).state).toBe("done")
    expect(await s.received("X")).toHaveLength(1)
    const refused = await s.call("A", "send_message", { to: "X", text: "2" })
    expect(refused.state).toBe("failed")
    expect(refused.output).toBe(`X is not on your path. Send it to M.\n${HAND_OFF_HINT}`)
  })

  test("'Own organization' adds no right, and a change of the range counts from the next send", async () => {
    const s = await setup()
    await s.rule("organizations")
    await s.range(s.product.id, "own")
    expect((await s.call("P", "send_message", { to: "A", text: "1" })).state).toBe("failed")
    await s.range(s.product.id, "own_lower")
    expect((await s.call("P", "send_message", { to: "A", text: "2" })).state).toBe("done")
    await s.range(s.product.id, "inherit")
    expect((await s.call("P", "send_message", { to: "A", text: "3" })).state).toBe("failed")
    expect(await s.received("A")).toHaveLength(1)
  })

  test("a refused send writes one line to the organization log, and none to the channel log", async () => {
    const s = await setup()
    await s.rule("organizations")
    await s.call("A", "send_message", { to: "P", text: "SECRET-TEXT-123" })
    expect(s.logLines().filter((l) => l.event === "hand_off_refused")).toHaveLength(1)
    let channelLog = ""
    try {
      channelLog = readFileSync(join(s.t.dataDir, "logs", "channels.log"), "utf8")
    } catch {}
    expect(channelLog).not.toContain("hand_off_refused")
  })
})

describe("an agent on a vendor runtime (the tools that the program calls through the app)", () => {
  const context = (s: Awaited<ReturnType<typeof setup>>, name: string): ToolContext => ({
    agentId: s.agent(name).id,
    workspace: s.agent(name).workspace,
    permission: "full",
    signal: new AbortController().signal,
    onWaiting: () => {},
    onMemory: () => {},
    onKnowledge: () => {},
    knowledgeChanges: { count: 0 },
    turn: newTurnMark("user"),
    taskId: null,
  })

  test("the same refusal, the same list, and an allowed send starts a task", async () => {
    const s = await setup()
    await s.rule("organizations")
    const bridge = await s.run(
      Tools.use((x) => Effect.succeed(x.bridge(context(s, "A"), () => {}))),
    )
    const signal = new AbortController().signal
    expect(bridge.tools.map((t) => t.name)).toContain("send_message")
    expect(bridge.tools.map((t) => t.name)).toContain("list_agents")
    const refused = await bridge.call("send_message", { to: "P", text: "hi" }, signal)
    expect(refused).toEqual({
      output: `P is not on your path. Send it to D.\n${HAND_OFF_HINT}`,
      failed: true,
    })
    expect(await s.received("P")).toHaveLength(0)
    const listed = await bridge.call("list_agents", {}, signal)
    expect(listed.output).toContain(HAND_OFF_LIST_RULE)
    expect(listed.output).not.toContain("- P:")
    const sent = await bridge.call("send_message", { to: "D", text: "hi" }, signal)
    expect(sent.failed).toBe(false)
    await s.quiet()
    expect(await s.received("D")).toHaveLength(1)
  })
})

describe("the main agent", () => {
  test("it is told what the rule means for it, and no other agent is told", async () => {
    const s = await setup()
    const told = (name: string) =>
      s.run(Organization.use((o) => Effect.succeed(o.told(s.agent(name).id))))
    expect(await told("M")).toBe("")
    await s.rule("organizations")
    expect(await told("M")).toBe(MAIN_AGENT_HAND_OFF_RULE)
    expect(await told("A")).toBe("")
    // A turn of the main agent reads the text in its instructions.
    systems.length = 0
    await s.send("M", "hello")
    await s.quiet()
    expect(systems.some((x) => x.includes(MAIN_AGENT_HAND_OFF_RULE))).toBe(true)
    systems.length = 0
    await s.send("A", "hello")
    await until(() => systems.length > 0)
    await s.quiet()
    expect(systems.some((x) => x.includes(MAIN_AGENT_HAND_OFF_RULE))).toBe(false)
  })

  test("with no main agent, nobody is told", async () => {
    const s = await setup({ main: false })
    await s.rule("organizations")
    expect(await s.run(Organization.use((o) => Effect.succeed(o.told(s.agent("M").id))))).toBe("")
  })
})

describe('the part "Hand-off rules"', () => {
  test("it changes the rule once, tells the window, and keeps the value", async () => {
    const s = await setup()
    const before = s.t.events.length
    expect(await s.rule("organizations")).toEqual({ handOff: "organizations", askUpTheLine: false })
    const events = s.t.events.slice(before).filter((e) => e.event === "organization.changed")
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ serverId: s.local.id })
    // The same value changes nothing and tells nothing.
    await s.rule("organizations")
    expect(s.t.events.filter((e) => e.event === "organization.changed")).toHaveLength(1)
    expect(await s.run(Organization.use((o) => o.get))).toEqual({
      handOff: "organizations",
      askUpTheLine: false,
    })
    expect(await s.run(Organization.use((o) => Effect.succeed(o.rule())))).toBe("organizations")
  })

  test("the chart reads the rule for its legend", async () => {
    const s = await setup()
    expect((await s.run(OrgChart.use((o) => o.snapshot()))).handOffRule).toBe("any")
    await s.rule("organizations")
    expect((await s.run(OrgChart.use((o) => o.snapshot()))).handOffRule).toBe("organizations")
    expect((await s.run(OrgChart.use((o) => o.model()))).handOffRule).toBe("organizations")
  })
})

describe("an order of a lead (spec 007)", () => {
  const textOf = (m: ChatMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")
  const lastFromAgent = async (s: Awaited<ReturnType<typeof setup>>, to: string) =>
    (await s.run(Chat.use((c) => c.history(s.agent(to).id)))).messages
      .filter((m) => m.author !== "agent" && textOf(m).includes("Message from"))
      .map(textOf)
      .at(-1) ?? ""

  for (const value of ["any", "organizations"] as const) {
    test(`the lead P gives D, a member of a lower organization, an order (rule "${value}")`, async () => {
      const s = await setup()
      await s.rule(value)
      // P leads Product; D is a member of Docs, a lower organization of Product.
      const step = await s.call("P", "send_message", { to: "D", text: "Push the fix." })
      expect(step.state).toBe("done")
      const body = await lastFromAgent(s, "D")
      expect(body).toContain(LEAD_ORDER_WORDS)
      expect(body).toContain("Push the fix.")
      expect(body).not.toContain("input from a colleague")
    })
  }

  test("a member who sends to its lead gives input from a colleague, no order", async () => {
    const s = await setup()
    const step = await s.call("D", "send_message", { to: "P", text: "Please push." })
    expect(step.state).toBe("done")
    const body = await lastFromAgent(s, "P")
    expect(body).toContain("input from a colleague")
    expect(body).not.toContain(LEAD_ORDER_WORDS)
  })

  test("a receiver that is blocked tells the sender at once, with the reason (spec 007, chase)", async () => {
    const s = await setup()
    const step = await s.call("P", "send_message", { to: "D", text: "BLOCKME push the fix" })
    expect(step.state).toBe("done")
    await s.quiet()
    const back = (await s.run(Chat.use((c) => c.history(s.agent("P").id)))).messages
      .map(textOf)
      .find((t) => t.startsWith("Reply from the agent D"))
    expect(back).toContain("could not do this message")
    expect(back).toContain("no access to the repository")
  })
})
