import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { buildChart, type ChartModel, ORG_HANDOFF_WINDOW_MS, type OrgSnapshot } from "@robot/shared"
import { Effect } from "effect"
import { Activity } from "./Activity.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database, type DatabaseService } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { Organizations } from "./Organizations.ts"
import { OrgChart } from "./OrgChart.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// The org chart reads agents, organizations and tasks (spec 029). These tests put rows in the
// database and read the snapshot, and one test runs two agents with a stand-in model to see which
// marks the send and the reply of the tool "send message" get.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** A fake clock, far from the real one. */
const NOW = Date.UTC(2036, 5, 15, 12, 0, 0)

// A stand-in model: "CALLS [...]" in the last user message calls those tools, the rest answers "ok".
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
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string | null }[] }
    const last = body.messages.at(-1)
    const many = /CALLS (\[.*\])/.exec(String(last?.content ?? ""))
    if (last?.role === "user" && many) {
      const calls = JSON.parse(many[1] as string) as { name: string; args: unknown }[]
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
            {
              delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(c.args) } }] },
            },
          ],
        })),
        "[DONE]",
      ])
    }
    return sse([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      "[DONE]",
    ])
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

const setup = async (options: { connected?: boolean } = {}) => {
  const t = testRuntime({ name: "This Mac" })
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const db: DatabaseService = await run(Database.use((d) => Effect.succeed(d)))
  const account =
    options.connected === false
      ? undefined
      : await run(
          Providers.use((p) =>
            p.connect({
              kind: "custom",
              name: "M",
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              apiKey: "sk-orgchart-test-key",
            }),
          ),
        )
  const agent = async (name: string, role = `${name} works.`) => {
    const made = await run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role,
          instructions: "Work.",
          ...(account ? { model: { accountId: account.id, model: "mock", effort: null } } : {}),
        }),
      ),
    )
    await run(Agents.use((a) => a.update(made.id, { permission: "full" })))
    mkdirSync(made.workspace, { recursive: true })
    return made
  }
  let n = 0
  /** A task row, written by hand. The `mark` is the kind of message from another agent. */
  const task = (
    agentId: string,
    extra: {
      source?: string
      sourceId?: string | null
      state?: string
      created?: number
      finished?: number | null
      verdict?: string | null
      mark?: string | null
      origin?: string | null
      label?: string
      retryOf?: string | null
    } = {},
  ) => {
    const id = `task-${++n}`
    db.run(
      `INSERT INTO task (id, agent_id, prompt, label, source, source_id, retry_of, state, created_at,
         started_at, finished_at, verdict, origin, agent_message)
       VALUES (?, ?, 'p', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      agentId,
      extra.label ?? `Label ${id}`,
      extra.source ?? "agent",
      extra.sourceId === undefined ? agentId : extra.sourceId,
      extra.retryOf ?? null,
      extra.state ?? "done",
      extra.created ?? NOW - MINUTE,
      extra.created ?? NOW - MINUTE,
      extra.finished === undefined ? (extra.created ?? NOW - MINUTE) : extra.finished,
      extra.verdict ?? null,
      extra.origin ?? null,
      extra.mark === undefined ? "send" : extra.mark,
    )
    return id
  }
  const snapshot = (now = NOW) => run(OrgChart.use((o) => o.snapshot(now)))
  const pushed = () =>
    t.events.filter((e) => e.event === "orgChart.changed").map((e) => e.payload as OrgSnapshot)
  // What the linked devices are told: the taps of the bus, which no window gets (spec 029, 012).
  const toLinked: ChartModel[] = []
  void run(
    EventBus.use((bus) =>
      Effect.sync(() =>
        bus.tap((event, payload) => {
          if (event === "orgChart.model") toLinked.push(payload as ChartModel)
        }),
      ),
    ),
  )
  const emit = () =>
    run(EventBus.use((bus) => Effect.sync(() => bus.emit("tasks.changed", { serverId: local.id }))))
  const org = (
    name: string,
    memberIds: string[],
    extra: { leadId?: string | null; parentId?: string | null } = {},
  ) =>
    run(
      Organizations.use((o) =>
        o.create({ serverId: local.id, name, memberIds, leadId: extra.leadId ?? null, ...extra }),
      ),
    )
  return { t, run, db, local, account, agent, org, task, snapshot, pushed, toLinked, emit }
}

describe("agents, organizations and states", () => {
  test("a profile with no agent gives an empty snapshot", async () => {
    const s = await setup()
    expect(await s.snapshot()).toEqual({
      mainAgentId: null,
      agents: [],
      orgs: [],
      handoffs: [],
      outcomes: [],
      handOffRule: "any",
    })
    expect(buildChart(await s.snapshot()).empty).toBe(true)
  })

  test("the root is the main agent; with none, or when it is archived, the root is 'You' (spec 029, 002)", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    expect((await s.snapshot()).mainAgentId).toBeNull()
    expect(buildChart(await s.snapshot()).root).toBeNull()

    await s.run(Agents.use((a) => a.update(ada.id, { isMain: true })))
    expect((await s.snapshot()).mainAgentId).toBe(ada.id)
    expect(buildChart(await s.snapshot()).root?.agentId).toBe(ada.id)

    // Turn it on for Bo: the root moves to Bo in the same step.
    await s.run(Agents.use((a) => a.update(bo.id, { isMain: true })))
    expect((await s.snapshot()).mainAgentId).toBe(bo.id)

    // An archived main agent leaves the chart: the root is "You". A restore brings the root back.
    await s.run(Agents.use((a) => a.archive(bo.id)))
    expect((await s.snapshot()).mainAgentId).toBeNull()
    await s.run(Agents.use((a) => a.restore(bo.id)))
    expect((await s.snapshot()).mainAgentId).toBe(bo.id)

    await s.run(Agents.use((a) => a.update(bo.id, { isMain: false })))
    expect((await s.snapshot()).mainAgentId).toBeNull()
  })

  test("an agent that is archived is not in the snapshot", async () => {
    const s = await setup()
    const ada = await s.agent("Ada", "Writes docs")
    const bo = await s.agent("Bo")
    await s.run(Agents.use((a) => a.archive(bo.id)))
    const { agents } = await s.snapshot()
    expect(agents.map((a) => [a.id, a.name, a.role])).toEqual([[ada.id, "Ada", "Writes docs"]])
    expect(agents[0]?.face).toEqual(ada.face)
  })

  test("the state is idle with a connected model account, and offline without one", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    expect((await s.snapshot()).agents.find((a) => a.id === ada.id)?.state).toBe("idle")
    const off = await setup({ connected: false })
    const bo = await off.agent("Bo")
    expect((await off.snapshot()).agents.find((a) => a.id === bo.id)?.state).toBe("offline")
  })

  test("a working agent shows the label of its running task; the label is that of the task", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    s.task(ada.id, {
      source: "chat",
      state: "running",
      label: "Draft the release notes",
      mark: null,
    })
    // The state of the task alone does not make the agent work: the activity of the agent does.
    expect((await s.snapshot()).agents[0]).toMatchObject({ state: "idle", task: null })
    await s.run(Activity.use((a) => Effect.sync(() => a.setWorking(ada.id, s.local.id, true))))
    expect((await s.snapshot()).agents[0]).toMatchObject({
      state: "working",
      task: { label: "Draft the release notes", state: "running" },
    })
  })

  test("a task that waits for the user makes the state 'waiting', also with no activity (after a restart)", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    s.task(ada.id, { source: "chat", state: "waiting", label: "Approve the command", mark: null })
    expect((await s.snapshot()).agents[0]).toMatchObject({
      state: "waiting",
      task: { label: "Approve the command", state: "waiting" },
    })
  })

  test("a task of the other computer of a sync pair does not make the agent work or wait here", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    s.task(ada.id, { source: "chat", state: "waiting", origin: "MacBook 2", mark: null })
    expect((await s.snapshot()).agents[0]).toMatchObject({ state: "idle", task: null })
  })

  test("an organization gives its members in the order of the form, its lead and its parent", async () => {
    const s = await setup()
    const [ada, bo, cy] = [await s.agent("Ada"), await s.agent("Bo"), await s.agent("Cy")] as const
    const product = await s.org("Product", [])
    const docs = await s.org("Docs", [cy.id, ada.id, bo.id], {
      leadId: ada.id,
      parentId: product.id,
    })
    // The order of the rows is the order of the time of making; the model sorts by name.
    const orgs = [...(await s.snapshot()).orgs].sort((x, y) => x.name.localeCompare(y.name))
    expect(orgs).toEqual([
      {
        id: docs.id,
        name: "Docs",
        createdAt: expect.any(Number),
        leadId: ada.id,
        memberIds: [cy.id, ada.id, bo.id],
        parentId: product.id,
      },
      {
        id: product.id,
        name: "Product",
        createdAt: expect.any(Number),
        leadId: null,
        memberIds: [],
        parentId: null,
      },
    ])
  })

  test("a channel is not on the chart: it makes no node and no event of the chart (spec 029, 031)", async () => {
    const s = await setup()
    const [ada, bo] = [await s.agent("Ada"), await s.agent("Bo")] as const
    await s.snapshot()
    await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Docs",
          topic: "",
          memberIds: [ada.id, bo.id],
          leadId: ada.id,
        }),
      ),
    )
    const model = buildChart(await s.snapshot())
    expect(model.orgs.map((o) => o.key)).toEqual(["o:none"])
    expect(JSON.stringify(model)).not.toContain("Docs")
  })

  test("an archived member leaves the node; the lead that is archived counts as no lead", async () => {
    const s = await setup()
    const [ada, bo, cy] = [await s.agent("Ada"), await s.agent("Bo"), await s.agent("Cy")] as const
    await s.org("Docs", [ada.id, bo.id, cy.id], { leadId: ada.id })
    await s.run(Agents.use((a) => a.archive(cy.id)))
    let model = buildChart(await s.snapshot())
    expect(model.orgs[0]?.nodes.map((n) => n.name)).toEqual(["Ada", "Bo"])
    await s.run(Agents.use((a) => a.archive(ada.id)))
    model = buildChart(await s.snapshot())
    expect(model.orgs[0]?.leadKey).toBeNull()
    expect(model.lines.filter((l) => l.kind === "lead")).toEqual([])
    expect(model.orgs[0]?.nodes.map((n) => n.name)).toEqual(["Bo"])
  })

  test("an organization with no member has a node; a change of an organization is pushed", async () => {
    const s = await setup()
    await s.snapshot()
    await s.org("Docs", [])
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.pushed()).toHaveLength(1)
    expect(
      buildChart(s.pushed()[0] as OrgSnapshot).orgs.map((o) => [o.name, o.memberCount]),
    ).toEqual([["Docs", 0]])
  })
})

describe("hand-offs", () => {
  test("only a task marked 'send' counts; a reply, a task with no mark (a retry, an old task), a chat task, a routine and a channel part do not", async () => {
    const s = await setup()
    const [ada, bo] = [await s.agent("Ada"), await s.agent("Bo")] as const
    for (let i = 0; i < 3; i++) s.task(bo.id, { sourceId: ada.id, mark: "send" })
    s.task(ada.id, { sourceId: bo.id, mark: "reply" })
    s.task(bo.id, { sourceId: ada.id, mark: null })
    s.task(bo.id, { source: "chat", sourceId: bo.id, mark: "send" })
    s.task(bo.id, { source: "routine", sourceId: "r1", mark: null })
    s.task(bo.id, { source: "channel", sourceId: "c1", mark: null })
    const { handoffs } = await s.snapshot()
    expect(handoffs).toEqual([{ from: ada.id, to: bo.id, count: 3, newest: NOW - MINUTE }])
    const model = buildChart(await s.snapshot())
    // The reply makes no line from Bo to Ada.
    expect(model.lines.filter((l) => l.kind === "handoff").map((l) => l.count)).toEqual([3])
  })

  test("a hand-off made 6 days ago counts, one made 7 days and 1 minute ago does not", async () => {
    const s = await setup()
    const [ada, bo] = [await s.agent("Ada"), await s.agent("Bo")] as const
    s.task(bo.id, { sourceId: ada.id, created: NOW - 6 * DAY })
    s.task(bo.id, { sourceId: ada.id, created: NOW - 7 * DAY - MINUTE })
    expect((await s.snapshot()).handoffs.map((h) => h.count)).toEqual([1])
    // The count falls to 0 when the window passes the last one.
    expect((await s.snapshot(NOW + 2 * DAY)).handoffs).toEqual([])
  })

  test("the tasks of both computers of a sync pair count", async () => {
    const s = await setup()
    const [ada, bo] = [await s.agent("Ada"), await s.agent("Bo")] as const
    s.task(bo.id, { sourceId: ada.id })
    s.task(bo.id, { sourceId: ada.id, origin: "MacBook 2" })
    expect((await s.snapshot()).handoffs.map((h) => h.count)).toEqual([2])
  })

  test("a hand-off to an agent that is archived leaves the chart", async () => {
    const s = await setup()
    const [ada, bo] = [await s.agent("Ada"), await s.agent("Bo")] as const
    s.task(bo.id, { sourceId: ada.id })
    expect(buildChart(await s.snapshot()).lines.some((l) => l.kind === "handoff")).toBe(true)
    await s.run(Agents.use((a) => a.archive(bo.id)))
    expect(buildChart(await s.snapshot()).lines.some((l) => l.kind === "handoff")).toBe(false)
  })

  test("a send and the reply that comes back: the send counts, the reply does not (stand-in model)", async () => {
    const s = await setup()
    const [ada, bo] = [await s.agent("Ada"), await s.agent("Bo")] as const
    const sendTo = (text: string) =>
      `CALLS ${JSON.stringify([{ name: "send_message", args: { to: "Bo", text } }])}`
    for (const text of ["one", "two", "three"]) {
      await s.run(Chat.use((c) => c.send({ agentId: ada.id, text: sendTo(text), replyTo: null })))
      // Wait until the message, its reply and the reply that comes back have ended.
      await until(async () => {
        const all = await s.run(Tasks.use((x) => x.list(s.local.id)))
        const count = all.filter((t) => t.source === "agent").length
        return (
          count >= 2 * (["one", "two", "three"].indexOf(text) + 1) &&
          all.every((t) => !["queued", "running", "waiting"].includes(t.state))
        )
      })
    }
    const marks = s.db
      .all<{ agent_id: string; source_id: string; agent_message: string | null }>(
        "SELECT agent_id, source_id, agent_message FROM task WHERE source = 'agent' ORDER BY created_at, rowid",
      )
      .map(
        (r) =>
          `${r.source_id === ada.id ? "Ada" : "Bo"}>${r.agent_id === ada.id ? "Ada" : "Bo"}:${r.agent_message}`,
      )
    expect(marks.filter((m) => m.startsWith("Ada>Bo")).every((m) => m.endsWith(":send"))).toBe(true)
    expect(marks.filter((m) => m.startsWith("Bo>Ada")).every((m) => m.endsWith(":reply"))).toBe(
      true,
    )
    expect(marks.filter((m) => m.startsWith("Ada>Bo"))).toHaveLength(3)
    expect(marks.filter((m) => m.startsWith("Bo>Ada"))).toHaveLength(3)
    // The user's own task has no mark.
    expect(
      s.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM task WHERE source = 'chat' AND agent_message IS NOT NULL",
      )?.n,
    ).toBe(0)
    // So the chart has one line, Ada to Bo, with the number 3, and no line from Bo to Ada.
    const handoffs = (await s.snapshot(Date.now())).handoffs
    expect(handoffs.map((h) => [h.from, h.to, h.count])).toEqual([[ada.id, bo.id, 3]])
    expect(bo.id).not.toBe(ada.id)
  })
})

describe("pushing the chart", () => {
  test("a change that an event reports is pushed once; a look with no change pushes nothing", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.snapshot()
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.pushed()).toHaveLength(0)
    await s.emit()
    await s.run(OrgChart.use((o) => o.check(NOW)))
    // An event with no change in the data pushes nothing.
    expect(s.pushed()).toHaveLength(0)
    await s.run(Agents.use((a) => a.update(ada.id, { name: "Ada Lovelace" })))
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.pushed()).toHaveLength(1)
    expect(s.pushed()[0]?.agents.map((a) => a.name)).toEqual(["Ada Lovelace"])
  })

  test("the switch 'Main agent' moves the root and is pushed once to the window and to the linked devices (spec 029, 012)", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.snapshot()
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.pushed()).toHaveLength(0)
    await s.run(Agents.use((a) => a.update(ada.id, { isMain: true })))
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.pushed()).toHaveLength(1)
    expect(s.pushed()[0]?.mainAgentId).toBe(ada.id)
    expect(s.toLinked.at(-1)?.root?.agentId).toBe(ada.id)
  })

  test("a hand-off that leaves the window of 7 days is pushed as gone at the next look", async () => {
    const s = await setup()
    const [ada, bo] = [await s.agent("Ada"), await s.agent("Bo")] as const
    const at = NOW - 3 * DAY
    s.task(bo.id, { sourceId: ada.id, created: at })
    const first = await s.snapshot(NOW)
    expect(first.handoffs).toHaveLength(1)
    // Nothing changed and the hand-off is still in the window: no push.
    await s.run(OrgChart.use((o) => o.check(NOW + DAY)))
    expect(s.pushed()).toHaveLength(0)
    // The look after the 7 days finds it gone and pushes.
    await s.run(OrgChart.use((o) => o.check(at + ORG_HANDOFF_WINDOW_MS + MINUTE)))
    expect(s.pushed()).toHaveLength(1)
    expect(s.pushed()[0]?.handoffs).toEqual([])
  })
})

describe("the ready model for a linked computer and the phone (spec 029, 012)", () => {
  test("it is the chart of the snapshot, with the labels cut, and holds no task besides its label", async () => {
    const s = await setup()
    const ada = await s.agent("Ada", "Writes docs")
    await s.agent("Bo")
    s.task(ada.id, {
      source: "chat",
      state: "running",
      label: `Draft the release notes ${"x".repeat(100)}`,
      mark: null,
    })
    await s.run(Activity.use((a) => Effect.sync(() => a.setWorking(ada.id, s.local.id, true))))
    const model = await s.run(OrgChart.use((o) => o.model(NOW)))
    expect(model).toEqual(buildChart(await s.snapshot(NOW)))
    const node = model.orgs[0]?.nodes.find((n) => n.name === "Ada")
    expect([...(node?.label ?? "")]).toHaveLength(90)
    expect(node?.role).toBe("Writes docs")
    // The prompt of the task, written by hand as "p", is not in the model, and no task id is.
    const text = JSON.stringify(model)
    expect(text).not.toContain('"prompt"')
    expect(text).not.toContain("task-")
  })

  test("a read for a client keeps the window of this computer from losing a push", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.snapshot()
    await s.run(Agents.use((a) => a.update(ada.id, { name: "Ada Lovelace" })))
    // A client asks before the loop looked: this must not count as a push to the window.
    const model = await s.run(OrgChart.use((o) => o.model(NOW)))
    expect(model.orgs[0]?.nodes.map((n) => n.name)).toEqual(["Ada Lovelace"])
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.pushed()).toHaveLength(1)
    expect(s.pushed()[0]?.agents.map((a) => a.name)).toEqual(["Ada Lovelace"])
  })

  test("a change is told to the linked devices as the ready model, and no window gets the model", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.run(Agents.use((a) => a.update(ada.id, { name: "Ada Lovelace" })))
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.toLinked).toHaveLength(1)
    expect(s.toLinked[0]?.orgs[0]?.nodes.map((n) => n.name)).toEqual(["Ada Lovelace"])
    expect(s.toLinked[0]).toEqual(buildChart(s.pushed()[0] as OrgSnapshot))
    // The window gets the snapshot only. The model is no event of a window.
    expect(s.t.events.some((e) => e.event === "orgChart.model")).toBe(false)
    // A look with no change tells nobody.
    await s.run(OrgChart.use((o) => o.check(NOW)))
    expect(s.toLinked).toHaveLength(1)
  })

  test("a read by the window between a change and the next look does not keep the push from a linked device", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.snapshot()
    await s.run(Agents.use((a) => a.update(ada.id, { name: "Ada Lovelace" })))
    // The window of this computer reads the new chart before the loop looked at it.
    expect((await s.snapshot()).agents.map((a) => a.name)).toEqual(["Ada Lovelace"])
    await s.run(OrgChart.use((o) => o.check(NOW)))
    // The window has the chart from its own read, so it gets no second copy.
    expect(s.pushed()).toHaveLength(0)
    // The linked devices were never told, so they get it.
    expect(s.toLinked).toHaveLength(1)
    expect(s.toLinked[0]?.orgs[0]?.nodes.map((n) => n.name)).toEqual(["Ada Lovelace"])
  })
})

describe("the outcome of the members of an organization", () => {
  test("done and blocked tasks, and the verdicts of the parts, count by the time they ended", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.org("Docs", [ada.id])
    s.task(ada.id, { state: "done" })
    s.task(ada.id, { state: "done" })
    s.task(ada.id, { state: "blocked" })
    s.task(ada.id, { state: "done", verdict: "met" })
    s.task(ada.id, { state: "done", verdict: "not_met" })
    // A task of 8 days ago is out of the window, by the time it ended.
    s.task(ada.id, { state: "done", created: NOW - 8 * DAY, finished: NOW - 8 * DAY })
    // A task that started 8 days ago and ended 2 days ago is in the window: the window reads the
    // time it ended (spec 029, "Organization node").
    s.task(ada.id, { state: "done", created: NOW - 8 * DAY, finished: NOW - 2 * DAY })
    // A task that has not ended does not count.
    s.task(ada.id, { state: "running", finished: null })
    const { outcomes } = await s.snapshot()
    expect(outcomes).toEqual([{ agentId: ada.id, done: 5, blocked: 1, met: 1, notMet: 1 }])
  })

  test("a task of another computer, and of an archived agent, do not count", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    await s.org("Docs", [ada.id])
    s.task(ada.id, { state: "done" })
    // A task of the other computer of a sync pair: the work of this one does not read it.
    s.task(bo.id, { state: "done", origin: "other" })
    await s.run(Agents.use((a) => a.archive(bo.id)))
    const { outcomes } = await s.snapshot()
    expect(outcomes).toEqual([{ agentId: ada.id, done: 1, blocked: 0, met: 0, notMet: 0 }])
  })

  test("the page shows the counts of a node, and a change of the work keeps the view", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.org("Docs", [ada.id])
    s.task(ada.id, { state: "done" })
    const model = buildChart(await s.snapshot())
    expect(model.orgs[0]?.outcome).toEqual({ done: 1, blocked: 0, met: 0, notMet: 0 })
    // A count of a digit more is a change of the outcome line, and it moves no node: the layout
    // reads the structure only (spec 029, "Layout").
    expect(buildChart(await s.snapshot()).orgs[0]?.nodes.map((n) => n.key)).toEqual(
      model.orgs[0]?.nodes.map((n) => n.key),
    )
  })
})
