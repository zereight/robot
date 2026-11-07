import { describe, expect, test } from "bun:test"
import type { PermissionLevel } from "@robot/shared"
import { Effect } from "effect"
import { ActionLog } from "./ActionLog.ts"
import type { CardReply } from "./Cards.ts"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { makeMemoryTool } from "./memoryTool.ts"
import { Proposals } from "./Proposals.ts"
import { makeProposeTools } from "./proposalTools.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

// The guarded steps of a turn or a task that holds outside content (spec 007, 008, 002).

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const flow = await run(
    Workflows.use((w) => w.create({ serverId: server.id, name: "Report", document: "Doc." })),
  )
  await run(
    Workflows.use((w) => w.addNode(flow.id, { kind: "text", name: "A", prompt: "Prompt." })),
  )
  const memory = await run(Memory.use((m) => Effect.succeed(m)))
  const proposals = await run(Proposals.use((p) => Effect.succeed(p)))
  const actionLog = await run(ActionLog.use((a) => Effect.succeed(a)))
  const db = await run(Database.use((d) => Effect.succeed(d)))
  const tool = makeMemoryTool({ memory, proposals, actionLog })
  const propose = makeProposeTools({ proposals })
  const asked: string[] = []
  const ask =
    (answer: "allow" | "deny" | "throw") =>
    async (text: string): Promise<CardReply> => {
      asked.push(text)
      if (answer === "throw") throw new Error("stopped")
      return { answer } as CardReply
    }
  const ctx = (
    over: Partial<Parameters<typeof tool.execute>[0]> & { level?: PermissionLevel } = {},
  ): Parameters<typeof tool.execute>[0] => ({
    workflowId: flow.id,
    taskId: null,
    level: "ask_risky",
    outside: null,
    program: false,
    source: { kind: "chat", id: "m1" },
    mayPress: true,
    signal: new AbortController().signal,
    ask: ask("allow"),
    ...over,
  })
  const save = (text: string, over: Parameters<typeof ctx>[0] = {}) =>
    tool.execute(ctx(over), { id: "c", name: "memory_save", input: JSON.stringify({ text }) })
  const items = async () =>
    (await run(Memory.use((m) => m.state(flow.id)))).items.map((i) => i.text)
  const log = () =>
    db.all<{ kind: string; result: string; decided_by: string }>(
      "SELECT kind, result, decided_by FROM action_log",
    )
  const now = () => run(Memory.use((m) => m.setMode(flow.id, "now")))
  return { ...t, run, flow, tool, propose, ask, asked, ctx, save, items, log, now, db }
}

const page = { kind: "page" as const, host: "example.com" }

describe("the memory tool: guarded save (spec 007, 008)", () => {
  test("a save with no outside content runs with no question", async () => {
    const t = await setup()
    await t.now()
    const r = await t.save("Fact one")
    expect(r.event).toMatchObject({ kind: "saved" })
    expect(t.asked).toEqual([])
    expect(await t.items()).toEqual(["Fact one"])
    expect(t.log()).toEqual([{ kind: "memory", result: "ran", decided_by: "level" }])
  })

  test("with outside content it asks first, with the full text; Allow saves, Deny does not", async () => {
    const t = await setup()
    await t.now()
    const denied = await t.save("Fact one", { outside: page, ask: t.ask("deny") })
    expect(denied.outcome.output).toContain("user refused")
    expect(await t.items()).toEqual([])
    const allowed = await t.save("Fact one", { outside: page, ask: t.ask("allow") })
    expect(allowed.event).toMatchObject({ kind: "saved" })
    expect(t.asked).toEqual(["Fact one", "Fact one"])
    expect(t.log().map((l) => l.result)).toEqual(["refused", "ran"])
    expect(t.log().every((l) => l.decided_by === "user")).toBe(true)
  })

  test("a stopped turn saves nothing and logs 'stopped'", async () => {
    const t = await setup()
    await t.now()
    const r = await t.save("Fact one", { outside: page, ask: t.ask("throw") })
    expect(r.outcome.failed).toBe(true)
    expect(await t.items()).toEqual([])
    expect(t.log().map((l) => l.result)).toEqual(["stopped"])
  })

  test("at Full access outside content asks nothing, but the program mark asks", async () => {
    const t = await setup()
    await t.now()
    await t.save("Fact one", { level: "full", outside: page })
    expect(t.asked).toEqual([])
    await t.save("Fact two", { level: "full", outside: page, program: true })
    expect(t.asked).toEqual(["Fact two"])
  })

  test("a proposal in such a turn needs no card (spec 008)", async () => {
    const t = await setup()
    const r = await t.save("Fact one", { outside: page })
    expect(r.event).toMatchObject({ kind: "suggested" })
    expect(t.asked).toEqual([])
  })

  test("after a run (no user) a fact is a proposal also with 'Save at once'", async () => {
    const t = await setup()
    await t.now()
    const r = await t.save("Fact one", { mayPress: false })
    expect(r.event).toMatchObject({ kind: "suggested" })
    expect(await t.items()).toEqual([])
  })
})

describe("the propose tools: guarded steps (spec 007, 002)", () => {
  const call = (name: string, args: object) => ({ id: "c", name, input: JSON.stringify(args) })
  const base = (t: Awaited<ReturnType<typeof setup>>, over: object = {}) => ({
    workflowId: t.flow.id,
    source: { kind: "chat" as const, id: "m1" },
    level: "ask_risky" as PermissionLevel,
    outside: null,
    program: false,
    ...over,
  })

  test("a prompt change with outside content asks; Deny makes no proposal", async () => {
    const t = await setup()
    const r = await t.propose.execute(
      base(t, { outside: page, ask: t.ask("deny") }),
      call("propose_prompt_change", { node: 1, prompt: "New prompt.", reason: "Why." }),
    )
    expect(r.guarded).toMatchObject({ decidedBy: "user", result: "refused" })
    expect(t.asked).toHaveLength(1)
    expect(t.db.all("SELECT id FROM proposal")).toEqual([])
  })

  test("a change of the document never asks", async () => {
    const t = await setup()
    const r = await t.propose.execute(
      base(t, { outside: page, ask: t.ask("deny") }),
      call("propose_document_change", { text: "New doc.", reason: "Why." }),
    )
    expect(r.event).toMatchObject({ kind: "made", proposalKind: "document" })
    expect(t.asked).toEqual([])
  })

  test("after a run there is no ask: the proposal is made and carries the outside source", async () => {
    const t = await setup()
    const r = await t.propose.execute(
      base(t, { outside: page }),
      call("propose_prompt_change", { node: 1, prompt: "New prompt.", reason: "Why." }),
    )
    expect(r.event).toMatchObject({ kind: "made" })
    expect(r.guarded).toBeUndefined()
  })

  test("the form of a call is checked: a node that is not a number, and a graph that is not a list", async () => {
    const t = await setup()
    const a = await t.propose.execute(
      base(t),
      call("propose_prompt_change", { node: "one", prompt: "x", reason: "y" }),
    )
    expect(a.outcome.failed).toBe(true)
    const b = await t.propose.execute(
      base(t),
      call("propose_graph_change", { nodes: "x", connections: [], reason: "y" }),
    )
    expect(b.outcome.failed).toBe(true)
  })
})
