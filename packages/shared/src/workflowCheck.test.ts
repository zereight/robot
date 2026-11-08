import { describe, expect, test } from "bun:test"
import { checkGraphKey } from "./workflowCheck.ts"
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

describe("the key of the check", () => {
  test("the stored form keeps null for the single output: old stored keys still match", () => {
    const graph: WorkflowGraph = {
      nodes: [
        node(1),
        node(2, {
          kind: "decision",
          options: [
            { id: "o1", label: "Yes" },
            { id: "o2", label: "No" },
          ],
        }),
        node(3, { kind: "approval", question: "Ship it?" }),
        node(4),
      ],
      connections: [
        { id: "c1", from: "n1", to: "n2", source: { kind: "text" } },
        { id: "c2", from: "n2", to: "n3", source: { kind: "option", optionId: "o1" } },
        { id: "c3", from: "n2", to: "n4", source: { kind: "option", optionId: "o2" } },
        { id: "c4", from: "n3", to: "n4", source: { kind: "verdict", verdict: "approve" } },
        { id: "c5", from: "n3", to: "n2", source: { kind: "verdict", verdict: "reject" } },
      ],
    }
    expect(checkGraphKey(graph)).toBe(
      '[[["n1","text",[]],["n2","decision",["o1","o2"]],["n3","approval",[]],["n4","text",[]]],' +
        '[["n1","n2",null],["n2","n3","o1"],["n2","n4","o2"],["n3","n4","approve"],["n3","n2","reject"]]]',
    )
  })
})
