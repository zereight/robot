import { describe, expect, test } from "bun:test"
import {
  connectionOutputKey,
  graphProblems,
  NODES_MAX,
  nodeOutputs,
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
      connections: [{ id: "c", from: "a", to: "b", optionId: null, output: null }],
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
        { id: "c1", from: "d", to: "t", optionId: "o1", output: null },
        { id: "c2", from: "e", to: "t", optionId: "o2", output: null },
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
      connections: [{ id: "c", from: "g", to: "t", optionId: null, output: "approve" }],
    }
    expect(graphProblems(graph)).toEqual([{ code: "approval_question", nodeId: "g" }])
  })

  test("an approval output with no connection is not a problem", () => {
    const graph: WorkflowGraph = {
      nodes: [node("g", { kind: "approval", question: "Ship it?" }), node("t")],
      connections: [{ id: "c", from: "g", to: "t", optionId: null, output: "approve" }],
    }
    expect(graphProblems(graph)).toEqual([])
  })
})

describe("nodeOutputs and connectionOutputKey (spec 010, the approval node)", () => {
  test("the outputs derive from the kind: one for text, two for approval, the options for decision", () => {
    expect(nodeOutputs(node("t"))).toEqual([null])
    expect(nodeOutputs(node("g", { kind: "approval" }))).toEqual(["approve", "reject"])
    expect(
      nodeOutputs(
        node("d", {
          kind: "decision",
          options: [
            { id: "o1", label: "Yes" },
            { id: "o2", label: "No" },
          ],
        }),
      ),
    ).toEqual(["o1", "o2"])
  })

  test("the reader returns the option id, the output, or null", () => {
    expect(connectionOutputKey({ id: "c", from: "a", to: "b", optionId: "o1", output: null })).toBe(
      "o1",
    )
    expect(
      connectionOutputKey({ id: "c", from: "a", to: "b", optionId: null, output: "reject" }),
    ).toBe("reject")
    expect(connectionOutputKey({ id: "c", from: "a", to: "b", optionId: null, output: null })).toBe(
      null,
    )
  })

  test("a connection with both fields set is a fault of the writer", () => {
    expect(() =>
      connectionOutputKey({ id: "c", from: "a", to: "b", optionId: "o1", output: "approve" }),
    ).toThrow()
  })
})
