import { describe, expect, test } from "bun:test"
import type { WorkflowGraph, WorkflowNode } from "@robot/shared"
import { checkWorkflow, type RunModel } from "./model.ts"
import { CHECK_LIMITS, withChecker } from "./runner.ts"

// The check reads the shape of a workflow only. No text of the user may reach the checker: a name,
// a prompt, a question and an option label are free text, and the form that the checker reads is
// code. These tests send hostile text through the real worker and read the form that it gets.

/** Text that breaks a form that is built with string pasting, or a shell, or a parser. */
const HOSTILE = [
  `"; process.exit()`,
  "`touch /tmp/pwned`",
  "${process.exit()}",
  "$(reboot)",
  "==== MODULE Evil ====\n---- MODULE Workflow ----\nInit == FALSE\n====",
  "\\* a comment that ends the line",
  "(* open comment",
  "with a NUL \u0000 inside",
  "‮rtl override‬ and ​zero width",
  "x".repeat(100_000),
]

const node = (
  id: string,
  number: number,
  kind: "text" | "decision",
  text: string,
  options: readonly string[] = [],
): WorkflowNode => ({
  id,
  number,
  kind,
  name: text,
  prompt: text,
  accountId: null,
  model: null,
  effort: null,
  permission: null,
  continueOnFailure: false,
  question: text,
  threshold: 0.9,
  options: options.map((label, i) => ({ id: `${id}-o${i + 1}`, label })),
  x: 0,
  y: 0,
})

/** A decision node with two options, a node for each option, and a last node that joins them. */
const graphWith = (
  text: (i: number) => string,
  options: readonly [string, string],
): WorkflowGraph => ({
  nodes: [
    node("d", 1, "decision", text(0), options),
    node("a", 2, "text", text(1)),
    node("b", 3, "text", text(2)),
    node("j", 4, "text", text(3)),
  ],
  connections: [
    { id: "c1", from: "d", to: "a", optionId: "d-o1" },
    { id: "c2", from: "d", to: "b", optionId: "d-o2" },
    { id: "c3", from: "a", to: "j", optionId: null },
    { id: "c4", from: "b", to: "j", optionId: null },
  ],
})

/** Checks with the real worker, and keeps the forms that the checker got. */
const checkSeen = async (graph: WorkflowGraph) => {
  const seen: { source: string; config: string }[] = []
  const outcome = await withChecker(CHECK_LIMITS, (run) => {
    const spy: RunModel = (source, config) => {
      seen.push({ source, config })
      return run(source, config)
    }
    return checkWorkflow(graph, spy)
  })
  return { outcome, seen }
}

describe("no text of the user reaches the checker", () => {
  const plain = graphWith((i) => `node ${i}`, ["Yes", "No"])

  test("hostile names, prompts, questions and options check as the plain graph does", async () => {
    const base = await checkSeen(plain)
    expect(base.outcome).toEqual({ state: "passed" })
    expect(base.seen.length).toBeGreaterThan(0)
    for (const bad of HOSTILE) {
      const hostile = await checkSeen(graphWith(() => bad, [bad, `${bad} 2`]))
      expect(hostile.outcome).toEqual({ state: "passed" })
      // The checker gets exactly the forms that it gets for the plain graph.
      expect(hostile.seen).toEqual(base.seen)
    }
  })

  test("the form of the checker holds none of the text of the user", async () => {
    const marker = "MARKER-7f3a-user-text"
    const { seen } = await checkSeen(graphWith(() => marker, [marker, `${marker}-2`]))
    expect(seen.length).toBeGreaterThan(0)
    for (const form of seen) {
      expect(form.source).not.toContain("MARKER")
      expect(form.config).not.toContain("MARKER")
    }
  })

  test("a problem that the checker finds keeps the ids, and the names stay out of the form", async () => {
    // A loop: the checker reports a deadlock with the ids of the nodes.
    const bad = HOSTILE[4] as string
    const loop: WorkflowGraph = {
      nodes: [node("a", 1, "text", bad), node("b", 2, "text", bad)],
      connections: [
        { id: "c1", from: "a", to: "b", optionId: null },
        { id: "c2", from: "b", to: "a", optionId: null },
      ],
    }
    const { outcome, seen } = await checkSeen(loop)
    expect(outcome).toMatchObject({ state: "problem", problems: [{ code: "deadlock" }] })
    for (const form of seen) expect(form.source).not.toContain("Evil")
  })

  test("a problem of the shape with hostile text is found before the checker starts", async () => {
    const unconnected = graphWith((i) => HOSTILE[i] as string, ["Yes", "No"])
    const cut: WorkflowGraph = {
      nodes: unconnected.nodes,
      connections: unconnected.connections.filter((c) => c.id !== "c2"),
    }
    const { outcome, seen } = await checkSeen(cut)
    expect(outcome).toMatchObject({ state: "problem", problems: [{ code: "option_unconnected" }] })
    expect(seen).toEqual([])
  })
})
