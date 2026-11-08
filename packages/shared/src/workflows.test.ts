import { describe, expect, test } from "bun:test"
import { graphProblems, NODES_MAX, type WorkflowGraph, type WorkflowNode } from "./workflows.ts"

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
      connections: [{ id: "c", from: "a", to: "b", optionId: null }],
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
        { id: "c1", from: "d", to: "t", optionId: "o1" },
        { id: "c2", from: "e", to: "t", optionId: "o2" },
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
})
