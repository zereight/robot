import { describe, expect, test } from "bun:test"
import {
  compileGraph,
  emptyGraphChange,
  type GraphProposalInput,
  graphChange,
  graphFingerprint,
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
    expect(change.changedNodes).toEqual([
      { number: 1, name: "Node 1", kind: "text", fields: ["prompt"] },
    ])
    expect(change.removedConnections).toHaveLength(1)
    expect(change.addedConnections).toHaveLength(1)
    expect(emptyGraphChange(change)).toBe(false)
    expect(emptyGraphChange(graphChange(current, current))).toBe(true)
  })
})
