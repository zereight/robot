import { describe, expect, test } from "bun:test"
import {
  changesBackup,
  compileGraph,
  emptyGraphChange,
  GRAPH_PROPOSAL_TEXT_MAX,
  type GraphProposalInput,
  graphChange,
  graphChangeSize,
  graphFingerprint,
  movesAccount,
} from "./proposals.ts"
import type { WorkflowGraph, WorkflowNode } from "./workflows.ts"

const node = (n: number, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: `n${n}`,
  number: n,
  kind: "text",
  name: `Node ${n}`,
  prompt: `prompt ${n}`,
  accountId: "acc",
  model: "mock-fast",
  effort: null,
  backup: null,
  permission: "read_only",
  continueOnFailure: false,
  question: "",
  threshold: 0.9,
  options: [],
  x: n * 100,
  y: 0,
  ...extra,
})

const current: WorkflowGraph = {
  nodes: [node(1), node(2)],
  connections: [{ id: "c1", from: "n1", to: "n2", optionId: null }],
}

let counter = 0
const newId = () => `new${++counter}`

const compile = (input: GraphProposalInput) => compileGraph(current, input, newId)

describe("the fingerprint of a graph", () => {
  test("a move of a node is not a change", () => {
    const moved: WorkflowGraph = { ...current, nodes: [node(1, { x: 999, y: 5 }), node(2)] }
    expect(graphFingerprint(moved)).toBe(graphFingerprint(current))
  })
  test("a prompt, a permission level and a connection are changes", () => {
    const base = graphFingerprint(current)
    expect(graphFingerprint({ ...current, nodes: [node(1, { prompt: "x" }), node(2)] })).not.toBe(
      base,
    )
    expect(
      graphFingerprint({ ...current, nodes: [node(1, { permission: "full" }), node(2)] }),
    ).not.toBe(base)
    expect(graphFingerprint({ ...current, connections: [] })).not.toBe(base)
  })
})

describe("the backup model in a graph change (spec 006; docs/spec-questions.md, B6)", () => {
  const pick = { accountId: "acc2", model: "gpt-5", effort: null }
  const held: WorkflowGraph = { ...current, nodes: [node(1, { backup: pick }), node(2)] }

  test("a kept node keeps its backup, a new node has none, a decision node has none", () => {
    const r = compileGraph(
      held,
      {
        nodes: [
          { keep: 1, kind: "text", name: "Node 1" },
          { keep: 2, kind: "text", name: "Node 2" },
          { kind: "text", name: "New", prompt: "x" },
        ],
        connections: [
          { from: 1, to: 2 },
          { from: 2, to: 3 },
        ],
      },
      newId,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.nodes.map((n) => n.backup)).toEqual([pick, null, null])
    expect(changesBackup(held, r.graph)).toBeNull()
  })

  test("a change that gives a node a backup, takes it away or moves it is found", () => {
    const nodes = (first: WorkflowNode, rest: WorkflowNode[] = [node(2)]) => ({
      ...current,
      nodes: [first, ...rest],
    })
    expect(changesBackup(current, current)).toBeNull()
    expect(changesBackup(current, nodes(node(1, { backup: pick })))).toBe(1)
    expect(changesBackup(held, nodes(node(1)))).toBe(1)
    expect(changesBackup(held, nodes(node(1, { backup: { ...pick, effort: "high" } })))).toBe(1)
    expect(changesBackup(held, nodes(node(1, { backup: pick }), [node(2, { backup: pick })]))).toBe(
      2,
    )
  })

  test("the fingerprint changes with the backup, so a proposal is stale after the user changes it", () => {
    expect(graphFingerprint(held)).not.toBe(graphFingerprint(current))
    expect(
      graphFingerprint({ ...held, nodes: [node(1, { backup: { ...pick, model: "x" } }), node(2)] }),
    ).not.toBe(graphFingerprint(held))
  })
})

describe("compileGraph (spec 002, a graph change)", () => {
  test("a kept node keeps its id, its place, its permission level and the fields left out", () => {
    const r = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1" },
        { keep: 2, kind: "text", name: "Renamed" },
      ],
      connections: [{ from: 1, to: 2 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.nodes[1]).toMatchObject({
      id: "n2",
      name: "Renamed",
      prompt: "prompt 2",
      permission: "read_only",
      x: 200,
    })
    expect(r.graph.connections[0]?.id).toBe("c1")
  })

  test("a new node has no permission level of its own", () => {
    const r = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1" },
        { keep: 2, kind: "text", name: "Node 2" },
        { kind: "text", name: "Third", prompt: "go" },
      ],
      connections: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.nodes[2]).toMatchObject({ permission: null, prompt: "go", number: 3 })
    expect(r.graph.nodes[2]?.x).toBeGreaterThan(200)
  })

  test("a decision node needs two options and each connection names one", () => {
    const decision = {
      kind: "decision" as const,
      name: "Pick",
      question: "Ready?",
      options: ["yes", "no"],
    }
    expect(
      compile({
        nodes: [{ keep: 1, kind: "text", name: "Node 1" }, decision],
        connections: [{ from: 1, to: 2 }],
      }).ok,
    ).toBe(true)
    const noOption = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1" },
        decision,
        { keep: 2, kind: "text", name: "Node 2" },
      ],
      connections: [{ from: 2, to: 3 }],
    })
    expect(noOption).toMatchObject({ ok: false, error: "connection_option" })
    const one = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1" },
        { ...decision, options: ["only"] },
      ],
      connections: [],
    })
    expect(one).toMatchObject({ ok: false, error: "decision_options" })
  })

  test("the faults of the form get a code", () => {
    const keep1 = { keep: 1, kind: "text" as const, name: "Node 1" }
    expect(compile({ nodes: [], connections: [] })).toMatchObject({ error: "nodes_empty" })
    expect(compile({ nodes: [{ kind: "text", name: " " }], connections: [] })).toMatchObject({
      error: "name_empty",
    })
    expect(
      compile({ nodes: [{ keep: 9, kind: "text", name: "x" }], connections: [] }),
    ).toMatchObject({
      error: "keep_missing",
    })
    expect(compile({ nodes: [keep1, keep1], connections: [] })).toMatchObject({
      error: "keep_twice",
    })
    expect(
      compile({
        nodes: [{ keep: 1, kind: "decision", name: "x", options: ["a", "b"] }],
        connections: [],
      }),
    ).toMatchObject({ error: "keep_kind" })
    expect(compile({ nodes: [keep1], connections: [{ from: 1, to: 4 }] })).toMatchObject({
      error: "connection_node",
    })
    expect(compile({ nodes: [keep1], connections: [{ from: 1, to: 1 }] })).toMatchObject({
      error: "connection_self",
    })
    expect(
      compile({
        nodes: [keep1, { keep: 2, kind: "text", name: "Node 2" }],
        connections: [
          { from: 1, to: 2 },
          { from: 1, to: 2 },
        ],
      }),
    ).toMatchObject({ error: "connection_twice" })
    expect(compile({ nodes: [{ ...keep1, threshold: 2 }], connections: [] })).toMatchObject({
      error: "threshold",
    })
  })

  test("the same graph is no change", () => {
    expect(
      compile({
        nodes: [
          { keep: 1, kind: "text", name: "Node 1" },
          { keep: 2, kind: "text", name: "Node 2" },
        ],
        connections: [{ from: 1, to: 2 }],
      }),
    ).toMatchObject({ ok: false, error: "no_change" })
  })
})

describe("graphChange", () => {
  test("lists the added, changed and removed nodes and connections", () => {
    const r = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1", prompt: "new prompt" },
        { kind: "text", name: "Third" },
      ],
      connections: [{ from: 1, to: 2 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const change = graphChange(current, r.graph)
    expect(change.addedNodes.map((n) => n.name)).toEqual(["Third"])
    expect(change.removedNodes.map((n) => n.name)).toEqual(["Node 2"])
    expect(change.changedNodes).toHaveLength(1)
    expect(change.changedNodes[0]).toMatchObject({
      number: 1,
      name: "Node 1",
      kind: "text",
      fields: ["prompt"],
      now: { prompt: "new prompt" },
      was: { prompt: "prompt 1" },
    })
    expect(change.removedConnections).toHaveLength(1)
    expect(change.addedConnections).toHaveLength(1)
    expect(emptyGraphChange(change)).toBe(false)
    expect(emptyGraphChange(graphChange(current, current))).toBe(true)
  })
})

describe("the values of a graph change (spec 002, the card shows the new text)", () => {
  test("an added node holds its text, its options and its account, model and effort", () => {
    const r = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1" },
        { keep: 2, kind: "text", name: "Node 2" },
        {
          kind: "text",
          name: "Third",
          prompt: "write it",
          accountId: "acc",
          model: "m",
          effort: "low",
        },
        { kind: "decision", name: "Pick", question: "Good?", options: ["Yes", "No"] },
      ],
      connections: [{ from: 1, to: 2 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const change = graphChange(current, r.graph, (id) => (id === "acc" ? "Mock" : id))
    expect(change.addedNodes[0]?.now).toMatchObject({
      prompt: "write it",
      account: "Mock",
      model: "m",
      effort: "low",
    })
    expect(change.addedNodes[1]?.now).toMatchObject({ question: "Good?", options: ["Yes", "No"] })
    expect(change.addedNodes[0]?.was).toBeNull()
  })

  test("a changed node holds the old and the new value of a model", () => {
    const r = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1", model: "mock-slow", effort: "high" },
        { keep: 2, kind: "text", name: "Node 2" },
      ],
      connections: [{ from: 1, to: 2 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const node = graphChange(current, r.graph).changedNodes[0]
    expect(node?.fields).toEqual(["model", "effort"])
    expect(node?.was).toMatchObject({ model: "mock-fast", effort: null })
    expect(node?.now).toMatchObject({ model: "mock-slow", effort: "high" })
  })

  test("the size counts the text of added, removed and changed nodes", () => {
    const r = compile({
      nodes: [{ keep: 1, kind: "text", name: "Node 1", prompt: "new prompt" }],
      connections: [],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // "prompt 1" (8) goes and "new prompt" (10) comes; node 2 is removed: "Node 2" (6) + "prompt 2" (8).
    expect(graphChangeSize(graphChange(current, r.graph))).toBe(8 + 10 + 6 + 8)
    expect(GRAPH_PROPOSAL_TEXT_MAX).toBe(2000)
  })
})

describe("the account of a node (spec 002: only a model that the account offers)", () => {
  test("a graph change does not move a kept node to another account", () => {
    expect(
      compile({
        nodes: [
          { keep: 1, kind: "text", name: "Node 1", accountId: "other" },
          { keep: 2, kind: "text", name: "Node 2" },
        ],
        connections: [{ from: 1, to: 2 }],
      }),
    ).toMatchObject({ ok: false, error: "account_change" })
    expect(
      compile({
        nodes: [
          { keep: 1, kind: "text", name: "Node 1", accountId: null },
          { keep: 2, kind: "text", name: "Node 2" },
        ],
        connections: [{ from: 1, to: 2 }],
      }),
    ).toMatchObject({ ok: false, error: "account_change" })
  })

  test("the same account is no move, and a new node may name its account", () => {
    const r = compile({
      nodes: [
        { keep: 1, kind: "text", name: "Node 1", accountId: "acc", model: "mock-slow" },
        { keep: 2, kind: "text", name: "Node 2" },
        { kind: "text", name: "New", accountId: "other", model: "x" },
      ],
      connections: [{ from: 1, to: 2 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(movesAccount(current, r.graph)).toBeNull()
    const moved: WorkflowGraph = { ...current, nodes: [node(1, { accountId: "other" }), node(2)] }
    expect(movesAccount(current, moved)).toBe(1)
  })
})
