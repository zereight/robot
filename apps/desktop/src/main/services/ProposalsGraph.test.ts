import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GRAPH_PROPOSAL_TEXT_MAX, PROPOSALS_PER_DAY } from "@robot/shared"
import { Effect, Exit } from "effect"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import { Database } from "./Database.ts"
import { type Change, Proposals, type ProposeOutcome } from "./Proposals.ts"
import { Providers } from "./Providers.ts"
import { makeProposeTools, PROPOSE_GRAPH_TOOL } from "./proposalTools.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

// The card of a graph change, its limits, the account of a node, and the order of two answers at
// the same time (spec 002, 006, 010). The services, the tables and the check are the real ones;
// only the model account is a stand-in.

let mock: MockProvider
beforeAll(async () => {
  mock = await startMockProvider()
})
afterAll(async () => {
  await mock.close()
})

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const connect = (name: string) =>
    run(
      Providers.use((p) =>
        p.connect({ kind: "openai", name, baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
      ),
    )
  const account = await connect("Mock")
  const other = await connect("Second")
  const flow = await run(
    Workflows.use((w) =>
      w.create({ serverId: server.id, name: "Report", document: "Send the report on Monday." }),
    ),
  )
  const w = <A>(f: (x: Workflows["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Workflows.use(f))
  const a = await w((x) =>
    x.addNode(flow.id, {
      kind: "text",
      name: "Fetch",
      prompt: "Fetch the data.",
      accountId: account.id,
      model: "mock-fast",
    }),
  )
  const b = await w((x) =>
    x.addNode(flow.id, { kind: "text", name: "Write", prompt: "Write the report." }),
  )
  await w((x) => x.connect(flow.id, a.id, b.id))
  let turn = 0
  const propose = (change: Change, id = `turn-${++turn}`) =>
    run(
      Proposals.use((p) =>
        p.propose({
          workflowId: flow.id,
          source: { kind: "chat", id },
          outside: null,
          reason: "The user asked for it.",
          change,
        }),
      ),
    )
  const reason = (r: ProposeOutcome) => (r.ok ? "ok" : r.reason)
  const ok = async (change: Change) => {
    const r = await propose(change)
    if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.text}`)
    return r.id
  }
  const p = <A>(f: (x: Proposals["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Proposals.use(f))
  const exit = (
    f: (x: Proposals["Service"]) => Effect.Effect<unknown, import("./errors.ts").AppError>,
  ) =>
    t.runtime
      .runPromiseExit(Proposals.use(f))
      .then((e) =>
        Exit.isSuccess(e)
          ? "ok"
          : e.cause.reasons
              .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
              .join(),
      )
  const view = () => p((x) => x.list(flow.id))
  const graph = () => w((x) => x.graph(flow.id))
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const rows = <T>(statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all<T>(statement, ...params))))
  /** The graph of the workflow with one more node: a change that passes the check. */
  const addNode = (extra: Record<string, unknown> = {}): Change => ({
    kind: "graph",
    graph: {
      nodes: [
        { keep: 1, kind: "text", name: "Fetch" },
        { keep: 2, kind: "text", name: "Write" },
        { kind: "text", name: "Send", prompt: "Send it.", ...extra },
      ],
      connections: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
    },
  })
  return {
    ...t,
    run,
    account,
    other,
    flow,
    w,
    propose,
    reason,
    ok,
    p,
    exit,
    view,
    graph,
    sql,
    rows,
    addNode,
  }
}

describe("the card of a graph change shows what the user accepts (spec 002, 'Card')", () => {
  test("the new prompt, the question, the options, and the account, model and effort", async () => {
    const t = await setup()
    await t.ok({
      kind: "graph",
      graph: {
        nodes: [
          { keep: 1, kind: "text", name: "Fetch", prompt: "Fetch the data twice.", model: "gpt-5" },
          { keep: 2, kind: "text", name: "Write" },
          {
            kind: "text",
            name: "Send",
            prompt: "Send it to the team.",
            accountId: t.account.id,
            model: "mock-fast",
          },
          { kind: "decision", name: "Good?", question: "Is it good?", options: ["Yes", "No"] },
        ],
        connections: [
          { from: 1, to: 2 },
          { from: 2, to: 3 },
          { from: 3, to: 4 },
        ],
      },
    })
    const card = (await t.view()).waiting[0]
    const g = card?.graph
    expect(g?.addedNodes.map((n) => n.name)).toEqual(["Send", "Good?"])
    expect(g?.addedNodes[0]?.now).toMatchObject({
      prompt: "Send it to the team.",
      account: "Mock",
      model: "mock-fast",
    })
    expect(g?.addedNodes[1]?.now).toMatchObject({ question: "Is it good?", options: ["Yes", "No"] })
    const changed = g?.changedNodes[0]
    expect(changed?.fields).toEqual(["prompt", "model"])
    expect(changed?.was).toMatchObject({ prompt: "Fetch the data.", model: "mock-fast" })
    expect(changed?.now).toMatchObject({ prompt: "Fetch the data twice.", model: "gpt-5" })
  })
})

describe("the size of a graph change (GRAPH_PROPOSAL_TEXT_MAX)", () => {
  test("a text over the limit is refused, with the limit; a text at the limit passes", async () => {
    const t = await setup()
    const long = await t.propose(t.addNode({ prompt: "x".repeat(GRAPH_PROPOSAL_TEXT_MAX) }))
    expect(t.reason(long)).toBe("too_long")
    expect(long.ok ? "" : long.text).toContain(String(GRAPH_PROPOSAL_TEXT_MAX))
    expect((await t.view()).waiting).toHaveLength(0)
    // "Send" (4) and the text together are at the limit.
    const exact = await t.propose(t.addNode({ prompt: "x".repeat(GRAPH_PROPOSAL_TEXT_MAX - 4) }))
    expect(t.reason(exact)).toBe("ok")
  })
})

describe("the backup model of a node (spec 006; docs/spec-questions.md, B6)", () => {
  const pick = (id: string) => ({ accountId: id, model: "gpt-5", effort: null })

  test("a graph change keeps the backup of a node that stays; the card shows no change of it; a new node has none", async () => {
    const t = await setup()
    const node1 = (await t.graph()).nodes[0]
    await t.w((x) => x.updateNode(node1?.id ?? "", { backup: pick(t.other.id) }))
    const id = await t.ok(t.addNode())
    const card = (await t.view()).waiting[0]?.graph
    expect(card?.changedNodes).toEqual([])
    expect(card?.addedNodes.map((n) => n.name)).toEqual(["Send"])
    await t.p((x) => x.accept(id))
    expect((await t.graph()).nodes.map((n) => n.backup)).toEqual([pick(t.other.id), null, null])
  })

  test("the user changes the backup while a proposal waits: Accept finds the graph changed and applies nothing", async () => {
    const t = await setup()
    const node1 = (await t.graph()).nodes[0]
    const id = await t.ok(t.addNode())
    await t.w((x) => x.updateNode(node1?.id ?? "", { backup: pick(t.other.id) }))
    await t.p((x) => x.accept(id))
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await t.view()).log[0]).toMatchObject({ id, state: "failed" })
  })

  test("the tool that proposes a graph change refuses a backup in any node and makes no proposal", async () => {
    const t = await setup()
    const tools = makeProposeTools({
      proposals: await t.run(Proposals.use((p) => Effect.succeed(p))),
    })
    const nodes = (extra: object) => [
      { keep: 1, kind: "text", name: "Fetch" },
      { keep: 2, kind: "text", name: "Write", ...extra },
    ]
    for (const extra of [
      { backup: { accountId: t.other.id, model: "gpt-5", effort: null } },
      { backupAccountId: t.other.id, backupModel: "gpt-5" },
    ]) {
      const r = await tools.execute(
        {
          workflowId: t.flow.id,
          source: { kind: "chat", id: "turn-x" },
          level: "full",
          outside: null,
          program: false,
        },
        {
          id: "c1",
          name: PROPOSE_GRAPH_TOOL,
          input: JSON.stringify({
            nodes: nodes(extra),
            connections: [{ from: 1, to: 2 }],
            reason: "Use a second account.",
          }),
        },
      )
      expect(r.outcome.failed).toBe(true)
      expect(r.outcome.output).toContain("Only the user sets it, in the editor of the node")
    }
    expect((await t.view()).waiting).toHaveLength(0)
  })
})

describe("the account of a node (spec 002: only a model that the account of the node offers)", () => {
  test("a graph change that moves a node to another account is refused", async () => {
    const t = await setup()
    const moved = await t.propose({
      kind: "graph",
      graph: {
        nodes: [
          { keep: 1, kind: "text", name: "Fetch", accountId: t.other.id, model: "mock-fast" },
          { keep: 2, kind: "text", name: "Write" },
        ],
        connections: [{ from: 1, to: 2 }],
      },
    })
    expect(t.reason(moved)).toBe("graph")
    expect(moved.ok ? "" : moved.text).toContain("another account")
    expect((await t.view()).waiting).toHaveLength(0)
  })

  test("a model that the account does not offer is still refused", async () => {
    const t = await setup()
    const r = await t.propose({
      kind: "graph",
      graph: {
        nodes: [
          { keep: 1, kind: "text", name: "Fetch", model: "nope" },
          { keep: 2, kind: "text", name: "Write" },
        ],
        connections: [{ from: 1, to: 2 }],
      },
    })
    expect(t.reason(r)).toBe("model")
  })

  test("Accept tests the account again: a graph that moves a node is Failed, and nothing changes", async () => {
    const t = await setup()
    const id = await t.ok(t.addNode())
    const g = JSON.parse(
      (await t.rows<{ graph: string }>("SELECT graph FROM proposal WHERE id = ?", id))[0]
        ?.graph as string,
    ) as { nodes: { accountId: string | null }[] }
    ;(g.nodes[0] as { accountId: string | null }).accountId = t.other.id
    await t.sql("UPDATE proposal SET graph = ? WHERE id = ?", JSON.stringify(g), id)
    await t.p((x) => x.accept(id))
    expect((await t.view()).log[0]).toMatchObject({ id, state: "failed" })
    expect((await t.graph()).nodes).toHaveLength(2)
  })
})

describe("Accept runs the check again on the server (spec 010)", () => {
  test("a stored 'passed' does not help a graph that fails the check", async () => {
    const t = await setup()
    const id = await t.ok(t.addNode())
    expect((await t.view()).waiting[0]?.check).toEqual({ state: "passed" })
    // The stored graph becomes a loop (a deadlock): the stored result is stale.
    const g = JSON.parse(
      (await t.rows<{ graph: string }>("SELECT graph FROM proposal WHERE id = ?", id))[0]
        ?.graph as string,
    ) as {
      nodes: { id: string }[]
      connections: { id: string; from: string; to: string; source: { kind: "text" } }[]
    }
    const [n1, n2] = g.nodes
    g.connections = [
      {
        id: "c1",
        from: (n1 as { id: string }).id,
        to: (n2 as { id: string }).id,
        source: { kind: "text" },
      },
      {
        id: "c2",
        from: (n2 as { id: string }).id,
        to: (n1 as { id: string }).id,
        source: { kind: "text" },
      },
    ]
    await t.sql("UPDATE proposal SET graph = ? WHERE id = ?", JSON.stringify(g), id)
    expect(await t.exit((x) => x.accept(id))).toBe("proposal_check_problem")
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await t.view()).waiting[0]?.check).toMatchObject({ state: "problem" })
  })
})

describe("two answers at the same time (spec 002)", () => {
  test("two Accepts of one graph change apply it once", async () => {
    const t = await setup()
    const id = await t.ok(t.addNode())
    const versions = (await t.rows("SELECT id FROM workflow_version")).length
    const results = await Promise.all([t.exit((x) => x.accept(id)), t.exit((x) => x.accept(id))])
    expect(results.sort()).toEqual(["ok", "proposal_not_waiting"])
    expect((await t.graph()).nodes).toHaveLength(3)
    expect((await t.rows("SELECT id FROM workflow_version")).length).toBe(versions + 1)
    expect((await t.view()).log.filter((r) => r.state === "applied")).toHaveLength(1)
  })

  test("a Reject while the check of an Accept works wins, and nothing is applied", async () => {
    const t = await setup()
    const id = await t.ok(t.addNode())
    const [accept] = await Promise.all([t.exit((x) => x.accept(id)), t.p((x) => x.reject(id))])
    expect(accept).toBe("proposal_not_waiting")
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await t.view()).log[0]).toMatchObject({ id, state: "rejected" })
  })

  test("two graph proposals at the same time: one waits, the other is refused", async () => {
    const t = await setup()
    const [one, two] = await Promise.all([t.propose(t.addNode()), t.propose(t.addNode())])
    expect([one, two].map(t.reason).sort()).toEqual(["ok", "one_waits"])
    expect((await t.view()).waiting).toHaveLength(1)
  })

  test("the limit of a day is tested again after the check", async () => {
    const t = await setup()
    await t.ok({ kind: "document", text: "One." })
    await t.ok({ kind: "prompt", node: 1, prompt: "One." })
    expect(PROPOSALS_PER_DAY).toBe(3)
    // The graph change waits for its check. The prompt change comes in meanwhile and is the third.
    const [graph, prompt] = await Promise.all([
      t.propose(t.addNode()),
      t.propose({ kind: "prompt", node: 2, prompt: "Two." }),
    ])
    expect(t.reason(prompt)).toBe("ok")
    expect(t.reason(graph)).toBe("per_day")
    expect((await t.view()).waiting).toHaveLength(3)
  })

  test("the limit of 20 that wait is tested again after the check", async () => {
    const t = await setup()
    for (let i = 0; i < 19; i++) await t.ok({ kind: "memory", text: `Fact ${i}` })
    const [graph, memory] = await Promise.all([
      t.propose(t.addNode()),
      t.propose({ kind: "memory", text: "The last fact" }),
    ])
    expect(t.reason(memory)).toBe("ok")
    expect(t.reason(graph)).toBe("full")
    expect((await t.view()).waiting).toHaveLength(20)
  })
})
