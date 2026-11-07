import { describe, expect, test } from "bun:test"
import { PROPOSAL_WAIT_MAX, PROPOSALS_PER_DAY, type WorkflowNode } from "@robot/shared"
import { Effect, Exit } from "effect"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { type Change, Proposals, type ProposeOutcome } from "./Proposals.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

// These tests use the real tables, the real check and the real services (spec 002, 008, 010).

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const flow = await run(
    Workflows.use((w) =>
      w.create({ serverId: server.id, name: "Report", document: "Send the report on Monday." }),
    ),
  )
  const w = <A>(f: (x: Workflows["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Workflows.use(f))
  const a = await w((x) =>
    x.addNode(flow.id, { kind: "text", name: "Fetch", prompt: "Fetch the data." }),
  )
  const b = await w((x) =>
    x.addNode(flow.id, { kind: "text", name: "Write", prompt: "Write the report." }),
  )
  await w((x) => x.connect(flow.id, a.id, b.id, null))
  let turn = 0
  /** A proposal of the chat; every call is a turn of its own unless `id` is given. */
  const propose = (
    change: Change,
    extra: { id?: string; reason?: string; outside?: boolean } = {},
  ) =>
    run(
      Proposals.use((p) =>
        p.propose({
          workflowId: flow.id,
          source: { kind: "chat", id: extra.id ?? `turn-${++turn}` },
          outside: extra.outside ? { kind: "page", host: "example.com" } : null,
          reason: extra.reason ?? "The user asked for it.",
          change,
        }),
      ),
    )
  const ok = async (change: Change, extra: Parameters<typeof propose>[1] = {}) => {
    const r = await propose(change, extra)
    if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.text}`)
    return r.id
  }
  const reason = (r: ProposeOutcome) => (r.ok ? "ok" : r.reason)
  const p = <A>(f: (x: Proposals["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Proposals.use(f))
  const code = async (
    f: (x: Proposals["Service"]) => Effect.Effect<unknown, import("./errors.ts").AppError>,
  ) => {
    const exit = await t.runtime.runPromiseExit(Proposals.use(f))
    if (Exit.isSuccess(exit)) return "ok"
    return exit.cause.reasons
      .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
      .join()
  }
  const view = () => p((x) => x.list(flow.id))
  const graph = () => w((x) => x.graph(flow.id))
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const rows = <T>(statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all<T>(statement, ...params))))
  return { ...t, run, server, flow, a, b, w, propose, ok, reason, p, code, view, graph, sql, rows }
}

describe("a proposal makes no change (spec 002)", () => {
  test("a document proposal waits with its diff; the document stays until Accept", async () => {
    const t = await setup()
    const versions = await t.rows("SELECT id FROM document_version")
    const graphVersions = await t.rows("SELECT id FROM workflow_version")
    const id = await t.ok({ kind: "document", text: "Send the report on Friday." })
    const v = await t.view()
    expect(v.waiting).toHaveLength(1)
    expect(v.waiting[0]).toMatchObject({
      id,
      kind: "document",
      state: "waiting",
      acceptBlock: null,
    })
    expect(v.waiting[0]?.diff?.some((s) => s.kind === "added" && s.text.includes("Friday"))).toBe(
      true,
    )
    expect((await t.w((x) => x.get(t.flow.id))).document).toBe("Send the report on Monday.")
    expect(await t.rows("SELECT id FROM document_version")).toEqual(versions)
    expect(await t.rows("SELECT id FROM workflow_version")).toEqual(graphVersions)
  })

  test("the switch off refuses a change of the document, a prompt and the graph, but not a memory fact", async () => {
    const t = await setup()
    await t.w((x) => x.setSelfImprovement(t.flow.id, false))
    expect(t.reason(await t.propose({ kind: "document", text: "x" }))).toBe("off")
    expect(t.reason(await t.propose({ kind: "prompt", node: 1, prompt: "x" }))).toBe("off")
    expect(t.reason(await t.propose({ kind: "memory", text: "A fact" }))).toBe("ok")
  })
})

describe("Accept (spec 002, 'Flows')", () => {
  test("a document proposal is a new version with the source proposal and a log row Applied", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "document", text: "Send the report on Friday." })
    await t.p((x) => x.accept(id))
    expect((await t.w((x) => x.get(t.flow.id))).document).toBe("Send the report on Friday.")
    const v = await t.view()
    expect(v.waiting).toHaveLength(0)
    expect(v.log[0]).toMatchObject({ id, state: "applied", canUndo: true })
    const versions = await t.rows<{ source: string }>(
      "SELECT source FROM document_version ORDER BY rowid DESC LIMIT 1",
    )
    expect(versions[0]?.source).toBe("proposal")
  })

  test("a prompt proposal changes only that prompt, as a new version; Edit and accept takes the edited text", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "prompt", node: 2, prompt: "Write the report in five lines." })
    await t.p((x) => x.accept(id, "Write the report in three lines."))
    const g = await t.graph()
    expect(g.nodes.map((n) => n.prompt)).toEqual([
      "Fetch the data.",
      "Write the report in three lines.",
    ])
    expect((await t.view()).log[0]).toMatchObject({
      state: "applied",
      newText: "Write the report in three lines.",
    })
  })

  test("a memory proposal makes an item and a history row by a proposal", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "memory", text: "Reports are in Korean." })
    expect((await t.run(Memory.use((m) => m.state(t.flow.id)))).items).toEqual([])
    await t.p((x) => x.accept(id))
    const s = await t.run(Memory.use((m) => m.state(t.flow.id)))
    expect(s.items.map((i) => i.text)).toEqual(["Reports are in Korean."])
    const [h] = await t.run(Memory.use((m) => m.history(t.flow.id)))
    expect(h).toMatchObject({ actor: "proposal", kind: "added" })
  })

  test("Reject keeps only a log line: nothing changes and no item or history row is made", async () => {
    const t = await setup()
    const doc = await t.ok({ kind: "document", text: "New text." })
    const fact = await t.ok({ kind: "memory", text: "A fact" })
    await t.p((x) => x.reject(doc))
    await t.p((x) => x.reject(fact))
    const v = await t.view()
    expect(v.log.map((l) => [l.state, l.stateReason])).toEqual([
      ["rejected", "rejected"],
      ["rejected", "rejected"],
    ])
    expect((await t.w((x) => x.get(t.flow.id))).document).toBe("Send the report on Monday.")
    expect(await t.rows("SELECT id FROM memory")).toEqual([])
    expect(await t.rows("SELECT id FROM memory_history")).toEqual([])
    expect(await t.code((x) => x.accept(doc))).toBe("proposal_not_waiting")
  })

  test("a proposal that is not there, or that was answered, cannot be answered again", async () => {
    const t = await setup()
    expect(await t.code((x) => x.accept("nope"))).toBe("proposal_not_found")
    const id = await t.ok({ kind: "document", text: "Other." })
    await t.p((x) => x.accept(id))
    expect(await t.code((x) => x.accept(id))).toBe("proposal_not_waiting")
    expect(await t.code((x) => x.reject(id))).toBe("proposal_not_waiting")
  })

  test("Accept is refused while a run of the workflow works", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "document", text: "Other." })
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', ?)",
      t.flow.id,
      Date.now(),
    )
    expect((await t.view()).waiting[0]?.acceptBlock).toBe("run_working")
    expect(await t.code((x) => x.accept(id))).toBe("proposal_run_working")
    await t.sql("UPDATE run SET finished_at = ?, state = 'done'", Date.now())
    expect(await t.code((x) => x.accept(id))).toBe("ok")
  })

  test("a secret in an edited text is refused", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "prompt", node: 1, prompt: "Fetch the data twice." })
    expect(
      await t.code((x) =>
        x.accept(id, "Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to fetch."),
      ),
    ).toBe("proposal_secret")
    expect((await t.view()).waiting).toHaveLength(1)
  })
})

describe("a stale proposal is refused (spec 002, 'Flows' 3)", () => {
  test("the document changed after the proposal: the proposal fails with the reason", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "document", text: "Send the report on Friday." })
    await t.w((x) => x.saveDocument(t.flow.id, "Something else entirely.", "editor"))
    await t.p((x) => x.accept(id))
    expect((await t.w((x) => x.get(t.flow.id))).document).toBe("Something else entirely.")
    expect((await t.view()).log[0]).toMatchObject({
      state: "failed",
      stateReason: "document_changed",
    })
  })

  test("the prompt changed or the node is gone", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "prompt", node: 1, prompt: "Fetch the data twice." })
    await t.w((x) => x.updateNode(t.a.id, { prompt: "By hand." }))
    await t.p((x) => x.accept(id))
    expect((await t.view()).log[0]).toMatchObject({ state: "failed", stateReason: "node_changed" })
    const second = await t.ok({ kind: "prompt", node: 2, prompt: "Write it short." })
    await t.w((x) => x.removeNode(t.b.id))
    await t.p((x) => x.accept(second))
    expect((await t.view()).log[0]).toMatchObject({ state: "failed", stateReason: "node_deleted" })
  })

  test("the graph changed after the proposal", async () => {
    const t = await setup()
    const id = await t.ok({
      kind: "graph",
      graph: {
        nodes: [
          { keep: 1, kind: "text", name: "Fetch" },
          { keep: 2, kind: "text", name: "Write" },
          { kind: "text", name: "Send", prompt: "Send it." },
        ],
        connections: [
          { from: 1, to: 2 },
          { from: 2, to: 3 },
        ],
      },
    })
    await t.w((x) => x.addNode(t.flow.id, { kind: "text", name: "Extra" }))
    await t.p((x) => x.accept(id))
    expect((await t.view()).log[0]).toMatchObject({ state: "failed", stateReason: "graph_changed" })
    expect((await t.graph()).nodes).toHaveLength(3)
  })

  test("a move of a node is not a change of the graph", async () => {
    const t = await setup()
    const id = await t.ok({
      kind: "graph",
      graph: {
        nodes: [
          { keep: 1, kind: "text", name: "Fetch" },
          { keep: 2, kind: "text", name: "Write" },
          { kind: "text", name: "Send", prompt: "Send it." },
        ],
        connections: [
          { from: 1, to: 2 },
          { from: 2, to: 3 },
        ],
      },
    })
    await t.w((x) => x.moveNode(t.a.id, 500, 500))
    await t.p((x) => x.accept(id))
    expect((await t.graph()).nodes).toHaveLength(3)
    expect((await t.view()).log[0]?.state).toBe("applied")
  })

  test("memory: a fact that became known fails, and memory off fails", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "memory", text: "Likes tea" })
    await t.run(Memory.use((m) => m.add(t.flow.id, "likes TEA")))
    await t.p((x) => x.accept(id))
    expect((await t.view()).log[0]).toMatchObject({ state: "failed", stateReason: "known" })
    const off = await t.ok({ kind: "memory", text: "Likes coffee" })
    await t.run(Memory.use((m) => m.setEnabled(t.flow.id, false)))
    await t.p((x) => x.accept(off))
    expect((await t.view()).log.find((l) => l.id === off)).toMatchObject({
      state: "failed",
      stateReason: "memory_off",
    })
  })
})

describe("a graph proposal must pass the check (spec 010, 002)", () => {
  const loop = {
    nodes: [
      { keep: 1, kind: "text" as const, name: "Fetch" },
      { keep: 2, kind: "text" as const, name: "Write" },
    ],
    connections: [
      { from: 1, to: 2 },
      { from: 2, to: 1 },
    ],
  }

  test("a graph that fails the check shows the problem and cannot be accepted", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "graph", graph: loop })
    const card = (await t.view()).waiting[0]
    expect(card?.check).toMatchObject({ state: "problem" })
    expect(card?.acceptBlock).toBe("check_problem")
    expect(await t.code((x) => x.accept(id))).toBe("proposal_check_problem")
    // Nothing changed, and the proposal still waits.
    expect((await t.graph()).connections).toHaveLength(1)
    expect((await t.view()).waiting).toHaveLength(1)
    await t.p((x) => x.reject(id))
  })

  test("a graph that passes is applied as a new version, keeps the permission levels, and Undo restores the old graph", async () => {
    const t = await setup()
    await t.w((x) => x.updateNode(t.a.id, { permission: "read_only" }))
    const before = await t.graph()
    const id = await t.ok({
      kind: "graph",
      graph: {
        nodes: [
          { keep: 1, kind: "text", name: "Fetch" },
          { keep: 2, kind: "text", name: "Write" },
          { kind: "text", name: "Send", prompt: "Send it." },
        ],
        connections: [
          { from: 1, to: 2 },
          { from: 2, to: 3 },
        ],
      },
    })
    const card = (await t.view()).waiting[0]
    expect(card?.check).toEqual({ state: "passed" })
    expect(card?.graph?.addedNodes.map((n) => n.name)).toEqual(["Send"])
    await t.p((x) => x.accept(id))
    const after = await t.graph()
    expect(after.nodes.map((n) => n.name)).toEqual(["Fetch", "Write", "Send"])
    expect(after.nodes[0]?.permission).toBe("read_only")
    expect(after.nodes[2]?.permission).toBeNull()
    await t.p((x) => x.undo(id))
    expect((await t.graph()).nodes.map((n) => n.name)).toEqual(before.nodes.map((n) => n.name))
    expect((await t.view()).log[0]?.state).toBe("undone")
  })
})

describe("Undo of an applied change (spec 002, 'Undo')", () => {
  test("a document change is undone while the document is as the change made it", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "document", text: "Send the report on Friday." })
    await t.p((x) => x.accept(id))
    await t.p((x) => x.undo(id))
    expect((await t.w((x) => x.get(t.flow.id))).document).toBe("Send the report on Monday.")
    expect((await t.view()).log[0]?.state).toBe("undone")
  })

  test("a newer change turns Undo off", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "document", text: "Send the report on Friday." })
    await t.p((x) => x.accept(id))
    await t.w((x) => x.saveDocument(t.flow.id, "Newer.", "editor"))
    const row = (await t.view()).log[0]
    expect(row).toMatchObject({ canUndo: false, undoBlock: "newer" })
    expect(await t.code((x) => x.undo(id))).toBe("proposal_undo_blocked")
  })

  test("a prompt change is undone by the version", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "prompt", node: 1, prompt: "Fetch the data twice." })
    await t.p((x) => x.accept(id))
    await t.p((x) => x.undo(id))
    expect((await t.graph()).nodes[0]?.prompt).toBe("Fetch the data.")
  })

  test("a memory item is undone; the history has an undo row and the change log says Undone", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "memory", text: "Reports are in Korean." })
    await t.p((x) => x.accept(id))
    await t.p((x) => x.undo(id))
    expect((await t.run(Memory.use((m) => m.state(t.flow.id)))).items).toEqual([])
    const history = await t.run(Memory.use((m) => m.history(t.flow.id)))
    expect(history.some((h) => h.actor === "undo")).toBe(true)
    // The undo of the row "added" is off now.
    expect(history.find((h) => h.actor === "proposal")?.canUndo).toBe(false)
    expect((await t.view()).log[0]?.state).toBe("undone")
  })

  test("the undo in the memory history and the change log show the same result, also for the undo of an undo", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "memory", text: "Reports are in Korean." })
    await t.p((x) => x.accept(id))
    const history = () => t.run(Memory.use((m) => m.history(t.flow.id)))
    const items = async () => (await t.run(Memory.use((m) => m.state(t.flow.id)))).items.length
    const logRow = async () => (await t.view()).log.find((r) => r.id === id)
    expect(await logRow()).toMatchObject({ state: "applied", canUndo: true })

    // The user undoes the item in the memory history: the change log says Undone.
    const added = (await history()).find((h) => h.actor === "proposal")
    await t.run(Memory.use((m) => m.undo(added?.id as string)))
    expect(await items()).toBe(0)
    expect(await logRow()).toMatchObject({ state: "undone", canUndo: false })

    // The user undoes that undo in the memory history: the item is back, and so is the row.
    const undoRow = (await history()).find((h) => h.actor === "undo")
    await t.run(Memory.use((m) => m.undo(undoRow?.id as string)))
    expect(await items()).toBe(1)
    expect(await logRow()).toMatchObject({ state: "applied", undoneAt: null, canUndo: true })

    // And Undo in the change log works again, and the history agrees.
    await t.p((x) => x.undo(id))
    expect(await items()).toBe(0)
    expect(await logRow()).toMatchObject({ state: "undone" })
    expect((await history())[0]).toMatchObject({ actor: "undo", kind: "deleted" })

    // A third round: undo the undo of the undo.
    const last = (await history())[0]
    await t.run(Memory.use((m) => m.undo(last?.id as string)))
    expect(await items()).toBe(1)
    expect(await logRow()).toMatchObject({ state: "applied" })
  })
})

describe("the limits (spec 002, 008)", () => {
  test("one proposal for each turn; a turn that holds one cannot make a second", async () => {
    const t = await setup()
    await t.ok({ kind: "document", text: "One." }, { id: "turn-x" })
    expect(
      t.reason(await t.propose({ kind: "prompt", node: 1, prompt: "Two." }, { id: "turn-x" })),
    ).toBe("per_turn")
  })

  test("a second proposal for the same target waits for the answer to the first", async () => {
    const t = await setup()
    await t.ok({ kind: "document", text: "One." })
    expect(t.reason(await t.propose({ kind: "document", text: "Two." }))).toBe("one_waits")
    await t.ok({ kind: "prompt", node: 1, prompt: "One." })
    expect(t.reason(await t.propose({ kind: "prompt", node: 1, prompt: "Two." }))).toBe("one_waits")
  })

  test("3 proposals in 24 hours of the kinds that change the workflow; memory is not counted", async () => {
    const t = await setup()
    await t.ok({ kind: "document", text: "One." })
    await t.ok({ kind: "prompt", node: 1, prompt: "One." })
    await t.ok({ kind: "prompt", node: 2, prompt: "One." })
    expect(PROPOSALS_PER_DAY).toBe(3)
    expect(
      t.reason(
        await t.propose({
          kind: "graph",
          graph: { nodes: [{ kind: "text", name: "x" }], connections: [] },
        }),
      ),
    ).toBe("per_day")
    expect(t.reason(await t.propose({ kind: "memory", text: "A fact" }))).toBe("ok")
    // A day later the limit is free again.
    await t.sql("UPDATE proposal SET created_at = created_at - 90000000")
    expect(t.reason(await t.propose({ kind: "document", text: "Another." }))).toBe("one_waits")
    expect(t.reason(await t.propose({ kind: "prompt", node: 1, prompt: "Another." }))).toBe(
      "one_waits",
    )
  })

  test("the removed and the added text together are at most 2000 characters", async () => {
    const t = await setup()
    expect(t.reason(await t.propose({ kind: "document", text: "x ".repeat(1200) }))).toBe("diff")
    expect(
      t.reason(await t.propose({ kind: "document", text: "Send the report on Monday. And more." })),
    ).toBe("ok")
  })

  test("the reason: one line of at most 200 characters, and needed for a change of the workflow", async () => {
    const t = await setup()
    expect(t.reason(await t.propose({ kind: "document", text: "A." }, { reason: "" }))).toBe(
      "reason",
    )
    expect(
      t.reason(await t.propose({ kind: "document", text: "A." }, { reason: "r".repeat(201) })),
    ).toBe("reason")
    expect(t.reason(await t.propose({ kind: "memory", text: "A fact" }, { reason: "" }))).toBe("ok")
  })

  test("the same document, the same prompt and a missing node are refused", async () => {
    const t = await setup()
    expect(
      t.reason(await t.propose({ kind: "document", text: "Send the report on Monday." })),
    ).toBe("no_change")
    expect(t.reason(await t.propose({ kind: "prompt", node: 1, prompt: "Fetch the data." }))).toBe(
      "no_change",
    )
    expect(t.reason(await t.propose({ kind: "prompt", node: 9, prompt: "x" }))).toBe("node")
  })

  test("a secret in a proposal is refused, in the reason, the text and the graph", async () => {
    const t = await setup()
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"
    expect(t.reason(await t.propose({ kind: "document", text: `Use ${key}.` }))).toBe("secret")
    expect(
      t.reason(await t.propose({ kind: "document", text: "A." }, { reason: `Because ${key}` })),
    ).toBe("secret")
    expect(t.reason(await t.propose({ kind: "memory", text: `The key is ${key}` }))).toBe("secret")
    expect(
      t.reason(
        await t.propose({
          kind: "graph",
          graph: {
            nodes: [
              { keep: 1, kind: "text", name: "Fetch", prompt: key },
              { keep: 2, kind: "text", name: "Write" },
            ],
            connections: [{ from: 1, to: 2 }],
          },
        }),
      ),
    ).toBe("secret")
    expect(await t.rows("SELECT id FROM proposal")).toEqual([])
  })

  test("memory facts: too long, duplicates (ignoring case and spaces) and the 21st proposal", async () => {
    const t = await setup()
    expect(t.reason(await t.propose({ kind: "memory", text: "a".repeat(501) }))).toBe("too_long")
    await t.ok({ kind: "memory", text: "Likes tea" })
    expect(t.reason(await t.propose({ kind: "memory", text: "  likes TEA " }))).toBe("known")
    for (let i = 1; i < PROPOSAL_WAIT_MAX; i++)
      await t.ok({ kind: "memory", text: `Fact number ${i}` })
    expect((await t.view()).full).toBe(true)
    expect(t.reason(await t.propose({ kind: "memory", text: "One too many" }))).toBe("full")
    // Nothing was rejected by the refusal, and 20 wait.
    const v = await t.view()
    expect(v.waiting).toHaveLength(PROPOSAL_WAIT_MAX)
    expect(v.log).toEqual([])
  })

  test("memory off refuses a memory proposal", async () => {
    const t = await setup()
    await t.run(Memory.use((m) => m.setEnabled(t.flow.id, false)))
    expect(t.reason(await t.propose({ kind: "memory", text: "A fact" }))).toBe("memory_off")
  })
})

describe("expiry and the change log (spec 002, 'Limits')", () => {
  test("a proposal that waits for 30 days is Rejected with the reason Expired, and cannot be accepted", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "document", text: "Old news." })
    await t.sql("UPDATE proposal SET created_at = ?", Date.now() - 31 * 86_400_000)
    expect(await t.code((x) => x.accept(id))).toBe("proposal_not_waiting")
    expect((await t.view()).log[0]).toMatchObject({ state: "rejected", stateReason: "expired" })
    expect((await t.w((x) => x.get(t.flow.id))).document).toBe("Send the report on Monday.")
  })

  test("the change log keeps 90 days", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "document", text: "A." })
    await t.p((x) => x.reject(id))
    await t.sql("UPDATE proposal SET answered_at = ?", Date.now() - 91 * 86_400_000)
    await t.ok({ kind: "document", text: "B." })
    expect((await t.view()).log).toEqual([])
  })

  test("deleting the workflow deletes its proposals", async () => {
    const t = await setup()
    await t.ok({ kind: "document", text: "A." })
    await t.run(Workflows.use((x) => x.remove(t.flow.id)))
    expect(await t.rows("SELECT id FROM proposal")).toEqual([])
  })
})

describe("outside content (spec 002, 007)", () => {
  test("a proposal made from work that held outside content carries the source, and still needs the click of the user", async () => {
    const t = await setup()
    const id = await t.ok({ kind: "prompt", node: 1, prompt: "Fetch more." }, { outside: true })
    const card = (await t.view()).waiting[0]
    expect(card?.outside).toEqual({ kind: "page", host: "example.com" })
    expect((await t.graph()).nodes[0]?.prompt).toBe("Fetch the data.")
    await t.p((x) => x.accept(id))
    expect((await t.graph()).nodes[0]?.prompt).toBe("Fetch more.")
  })
})

// A type check that the helper above matches the nodes of the graph.
const _unused: WorkflowNode | undefined = undefined
void _unused
