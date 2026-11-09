import { describe, expect, test } from "bun:test"
import {
  type CheckOutcome,
  type ConnectionSource,
  NODES_MAX,
  type WorkflowNode,
} from "@robot/shared"
import { Effect } from "effect"
import { Database } from "./Database.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { WorkflowCheck } from "./WorkflowCheck.ts"
import { Workflows } from "./Workflows.ts"

// These tests run the real check in the real worker, on the real tables.

const setup = async (options: Parameters<typeof testRuntime>[0] = {}) => {
  const t = testRuntime(options)
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const flow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Report" })))
  const w = <A>(f: (x: Workflows["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Workflows.use(f))
  const text = (name: string) => w((x) => x.addNode(flow.id, { kind: "text", name }))
  const decision = (name: string, options = ["Yes", "No"]) =>
    w((x) => x.addNode(flow.id, { kind: "decision", name, question: "Which?", options }))
  const connect = (
    from: WorkflowNode,
    to: WorkflowNode,
    source: ConnectionSource = { kind: "text" },
  ) => w((x) => x.connect(flow.id, from.id, to.id, source))
  const check = (force = true) => run(WorkflowCheck.use((c) => c.check(flow.id, { force })))
  const card = async () => (await w((x) => x.list(server.id)))[0]
  const detail = () => w((x) => x.get(flow.id))
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all(statement, ...params))))
  return { ...t, run, server, flow, w, text, decision, connect, check, card, detail, sql }
}

const waitFor = async (ok: () => Promise<boolean>, what: string, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Waited ${ms} ms for: ${what}`)
}

describe("the check of a saved workflow (spec 010, 001)", () => {
  test("a new workflow is not checked, a check passes it, and the card and the detail show it", async () => {
    const t = await setup()
    expect((await t.card())?.check).toBe("not_checked")
    const a = await t.text("A")
    const b = await t.text("B")
    await t.connect(a, b)
    expect((await t.card())?.check).toBe("not_checked")
    expect(await t.check()).toEqual({ state: "passed" })
    expect((await t.card())?.check).toBe("passed")
    expect((await t.detail()).checkOutcome).toEqual({ state: "passed" })
  })

  test("a result is valid for its graph only: a change of the shape makes the card not checked", async () => {
    const t = await setup()
    const a = await t.text("A")
    const b = await t.text("B")
    await t.check()
    expect((await t.card())?.check).toBe("passed")
    // A name, a prompt and a place are not read by the check: the result stays.
    await t.w((x) => x.updateNode(a.id, { name: "Renamed", prompt: "New prompt" }))
    await t.w((x) => x.moveNode(a.id, 400, 400))
    expect((await t.card())?.check).toBe("passed")
    // A connection changes the shape.
    await t.connect(a, b)
    expect((await t.card())?.check).toBe("not_checked")
    expect((await t.detail()).checkOutcome).toBeNull()
  })

  test("a loop is a problem with its place, and the fix passes", async () => {
    const t = await setup()
    const a = await t.text("A")
    const b = await t.text("B")
    await t.connect(a, b)
    const back = await t.connect(b, a)
    const outcome = await t.check()
    expect(outcome).toMatchObject({ state: "problem", problems: [{ code: "deadlock" }] })
    expect((await t.card())?.check).toBe("problem")
    await t.w((x) => x.disconnect(back.id))
    expect(await t.check()).toEqual({ state: "passed" })
    expect((await t.card())?.check).toBe("passed")
  })

  test("a decision option with no connection is a problem, and it passes when it is connected", async () => {
    const t = await setup()
    const d = await t.decision("Ok?")
    const next = await t.text("Go")
    const other = await t.text("Stop")
    await t.connect(d, next, { kind: "option", optionId: d.options[0]?.id ?? "" })
    const outcome = await t.check()
    expect(outcome).toEqual({
      state: "problem",
      problems: [{ code: "option_unconnected", nodeId: d.id, optionId: d.options[1]?.id ?? "" }],
    })
    await t.connect(d, other, { kind: "option", optionId: d.options[1]?.id ?? "" })
    expect(await t.check()).toEqual({ state: "passed" })
  })

  test("hostile names, prompts and options check normally through the saved tables", async () => {
    const t = await setup()
    const hostile = [
      `"; process.exit()`,
      "`touch /tmp/pwned` $" + "{process.exit()}",
      "==== MODULE Evil ====\n---- MODULE Workflow ----\nInit == FALSE\n====",
      "NUL \u0000 and \u202Ertl\u202C",
      "y".repeat(100_000),
    ]
    const nodes: WorkflowNode[] = []
    for (const text of hostile) {
      nodes.push(await t.w((x) => x.addNode(t.flow.id, { kind: "text", name: text, prompt: text })))
    }
    const d = await t.w((x) =>
      x.addNode(t.flow.id, {
        kind: "decision",
        name: hostile[0] as string,
        question: hostile[1] as string,
        options: [hostile[2] as string, hostile[4] as string],
      }),
    )
    await t.connect(d, nodes[0] as WorkflowNode, {
      kind: "option",
      optionId: d.options[0]?.id ?? "",
    })
    await t.connect(d, nodes[1] as WorkflowNode, {
      kind: "option",
      optionId: d.options[1]?.id ?? "",
    })
    await t.connect(nodes[0] as WorkflowNode, nodes[2] as WorkflowNode)
    expect(await t.check()).toEqual({ state: "passed" })
    expect((await t.card())?.check).toBe("passed")
  })

  test("a graph of 30 nodes is checked and kept", async () => {
    const t = await setup()
    let before: WorkflowNode | undefined
    for (let i = 0; i < NODES_MAX; i++) {
      const node = await t.text(`Node ${i + 1}`)
      if (before) await t.connect(before, node)
      before = node
    }
    expect(await t.check()).toEqual({ state: "passed" })
    expect((await t.card())?.nodeCount).toBe(NODES_MAX)
    expect((await t.card())?.check).toBe("passed")
  })

  test("a result that is stored is used again; a check with force runs again", async () => {
    const t = await setup()
    await t.text("A")
    await t.check()
    // The stored result is the proof: change it in the table, and a plain check returns it.
    await t.sql(
      "UPDATE workflow_check SET outcome = ?",
      JSON.stringify({ state: "stopped", reason: "time" }),
    )
    expect(await t.check(false)).toEqual({ state: "stopped", reason: "time" })
    expect(await t.check(true)).toEqual({ state: "passed" })
  })

  test("a check that goes over the time limit stops with a clear result", async () => {
    // A limit of 1 ms ends before the worker has loaded the checker.
    const t = await setup({ check: { limits: { timeMs: 1, maxStates: 1_000_000 } } })
    await t.text("A")
    const outcome: CheckOutcome = await t.check()
    expect(outcome).toEqual({ state: "stopped", reason: "time" })
    expect((await t.card())?.check).toBe("could_not")
  })

  test("the result goes with the workflow when it is deleted", async () => {
    const t = await setup()
    await t.text("A")
    await t.check()
    expect(await t.sql("SELECT * FROM workflow_check")).toHaveLength(1)
    await t.w((x) => x.remove(t.flow.id))
    expect(await t.sql("SELECT * FROM workflow_check")).toHaveLength(0)
  })

  test("a change of the graph starts a check in the background, and the windows get an event", async () => {
    const t = await setup({ check: { auto: true } })
    const a = await t.text("A")
    const b = await t.text("B")
    await t.connect(a, b)
    await waitFor(async () => (await t.card())?.check === "passed", "the card to show Passed")
    const events = t.events.filter((e) => e.event === "workflows.changed")
    expect(events.length).toBeGreaterThan(0)
    // A loop makes the card show the problem with no call to the check.
    await t.connect(b, a)
    await waitFor(
      async () => (await t.card())?.check === "problem",
      "the card to show Problem found",
    )
  })
})
