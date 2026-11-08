import { describe, expect, test } from "bun:test"
import type { WorkflowConnection, WorkflowNode } from "@robot/shared"
import { readyNode, stalled } from "./runGraph.ts"

// The step that finds the next node of a run (spec 010). A run whose nodes cannot start does not end
// as done: it fails with the code `run_no_ready_node` (it replaces the test of the same name that
// lived in `Runs.test.ts` when a queued run read its graph late).

const node = (id: string, number: number) => ({ id, number }) as unknown as WorkflowNode
const link = (from: string, to: string) => ({
  id: `${from}-${to}`,
  from,
  to,
  optionId: null,
  output: null,
})
const incomingOf = (nodes: WorkflowNode[], connections: WorkflowConnection[]) =>
  new Map(nodes.map((n) => [n.id, connections.filter((c) => c.to === n.id)]))

describe("the next node of a run", () => {
  const a = node("a", 1)
  const b = node("b", 2)

  test("a chain: the first node is ready, then the next one", () => {
    const incoming = incomingOf([a, b], [link("a", "b")])
    const ended = new Map<string, unknown>()
    expect(readyNode([a, b], incoming, ended)).toBe(a)
    ended.set("a", "done")
    expect(readyNode([a, b], incoming, ended)).toBe(b)
    ended.set("b", "done")
    expect(readyNode([a, b], incoming, ended)).toBeUndefined()
    expect(stalled([a, b], incoming, ended)).toBe(false)
  })

  test("a loop (or a graph that changed during the run): no node is ready and nodes remain, so the run is stalled", () => {
    const incoming = incomingOf([a, b], [link("a", "b"), link("b", "a")])
    const ended = new Map<string, unknown>()
    expect(readyNode([a, b], incoming, ended)).toBeUndefined()
    expect(stalled([a, b], incoming, ended)).toBe(true)
  })

  test("a skipped node counts as ended", () => {
    const incoming = incomingOf([a, b], [link("a", "b")])
    const ended = new Map<string, unknown>([["a", "skipped"]])
    expect(readyNode([a, b], incoming, ended)).toBe(b)
  })
})
