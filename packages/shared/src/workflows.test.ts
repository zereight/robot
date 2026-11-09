import { describe, expect, test } from "bun:test"
import {
  columnsOfSource,
  connectionFromJson,
  connectionKey,
  graphProblems,
  NODES_MAX,
  sameSource,
  sourceOfColumns,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from "./workflows.ts"

const node = (id: string, patch: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  number: 1,
  kind: "text",
  name: id,
  prompt: "",
  accountId: null,
  model: null,
  effort: null,
  backup: null,
  silentLimit: "follow",
  permission: null,
  continueOnFailure: false,
  question: "",
  threshold: 0.9,
  options: [],
  x: 0,
  y: 0,
  ...patch,
})

describe("graphProblems (spec 010, the rules of the graph)", () => {
  test("a graph of text nodes has no problem", () => {
    const graph: WorkflowGraph = {
      nodes: [node("a"), node("b")],
      connections: [{ id: "c", from: "a", to: "b", source: { kind: "text" } }],
    }
    expect(graphProblems(graph)).toEqual([])
  })

  test("a decision node with one option, and an option with no connection, are problems", () => {
    const graph: WorkflowGraph = {
      nodes: [
        node("d", { kind: "decision", options: [{ id: "o1", label: "Yes" }] }),
        node("e", {
          kind: "decision",
          options: [
            { id: "o2", label: "Yes" },
            { id: "o3", label: "No" },
          ],
        }),
        node("t"),
      ],
      connections: [
        { id: "c1", from: "d", to: "t", source: { kind: "option", optionId: "o1" } },
        { id: "c2", from: "e", to: "t", source: { kind: "option", optionId: "o2" } },
      ],
    }
    expect(graphProblems(graph)).toEqual([
      { code: "decision_options", nodeId: "d" },
      { code: "option_unconnected", nodeId: "e", optionId: "o3" },
    ])
  })

  test("more than 30 nodes is a problem", () => {
    const nodes = Array.from({ length: NODES_MAX + 1 }, (_, i) => node(`n${i}`))
    expect(graphProblems({ nodes, connections: [] })).toEqual([{ code: "nodes_full" }])
  })

  test("an approval node with an empty question is a problem", () => {
    const graph: WorkflowGraph = {
      nodes: [node("g", { kind: "approval", question: "  " }), node("t")],
      connections: [
        { id: "c", from: "g", to: "t", source: { kind: "verdict", verdict: "approve" } },
      ],
    }
    expect(graphProblems(graph)).toEqual([{ code: "approval_question", nodeId: "g" }])
  })

  test("an approval output with no connection is not a problem", () => {
    const graph: WorkflowGraph = {
      nodes: [node("g", { kind: "approval", question: "Ship it?" }), node("t")],
      connections: [
        { id: "c", from: "g", to: "t", source: { kind: "verdict", verdict: "approve" } },
      ],
    }
    expect(graphProblems(graph)).toEqual([])
  })
})

describe("the source of a connection (spec 010, the approval node)", () => {
  const approve = (from: string, to: string): WorkflowConnection => ({
    id: `${from}${to}`,
    from,
    to,
    source: { kind: "verdict", verdict: "approve" },
  })
  const line = (from: string, to: string): WorkflowConnection => ({
    id: `${from}${to}`,
    from,
    to,
    source: { kind: "text" },
  })

  test("each output of each node has its own key: two approval nodes share no key", () => {
    expect(connectionKey(approve("g1", "x"))).not.toBe(connectionKey(approve("g2", "y")))
    expect(connectionKey(approve("g1", "x"))).toBe(connectionKey(approve("g1", "z")))
    expect(connectionKey(line("a", "b"))).not.toBe(connectionKey(line("a", "c")))
    expect(connectionKey(line("a", "b"))).toBe(connectionKey(line("a", "b")))
  })

  test("sameSource compares the output, not the line", () => {
    expect(sameSource({ kind: "text" }, { kind: "text" })).toBe(true)
    expect(sameSource({ kind: "option", optionId: "o1" }, { kind: "option", optionId: "o1" })).toBe(
      true,
    )
    expect(sameSource({ kind: "option", optionId: "o1" }, { kind: "option", optionId: "o2" })).toBe(
      false,
    )
    expect(
      sameSource({ kind: "verdict", verdict: "approve" }, { kind: "verdict", verdict: "reject" }),
    ).toBe(false)
    expect(sameSource({ kind: "text" }, { kind: "verdict", verdict: "approve" })).toBe(false)
  })

  test("the columns and the source go both ways", () => {
    expect(sourceOfColumns("o1", null)).toEqual({ kind: "option", optionId: "o1" })
    expect(sourceOfColumns(null, "reject")).toEqual({ kind: "verdict", verdict: "reject" })
    expect(sourceOfColumns(null, null)).toEqual({ kind: "text" })
    expect(columnsOfSource({ kind: "option", optionId: "o1" })).toEqual({
      optionId: "o1",
      output: null,
    })
    expect(columnsOfSource({ kind: "verdict", verdict: "reject" })).toEqual({
      optionId: null,
      output: "reject",
    })
    expect(columnsOfSource({ kind: "text" })).toEqual({ optionId: null, output: null })
  })

  test("a stored connection reads through the single field, old rows included", () => {
    expect(
      connectionFromJson({
        id: "c",
        from: "a",
        to: "b",
        source: { kind: "verdict", verdict: "approve" },
      }),
    ).toMatchObject({ source: { kind: "verdict", verdict: "approve" } })
    expect(connectionFromJson({ id: "c", from: "a", to: "b", optionId: "o1" })).toMatchObject({
      source: { kind: "option", optionId: "o1" },
    })
    expect(connectionFromJson({ id: "c", from: "a", to: "b", output: "reject" })).toMatchObject({
      source: { kind: "verdict", verdict: "reject" },
    })
    expect(connectionFromJson({ id: "c", from: "a", to: "b" })).toMatchObject({
      source: { kind: "text" },
    })
  })
})
