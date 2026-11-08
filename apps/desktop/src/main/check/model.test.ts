import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  type CheckOutcome,
  type CheckProblem,
  NODES_MAX,
  type NodeKind,
  problemNodeIds,
  problemPath,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from "@robot/shared"
import { buildModule, checkWorkflow, type RunModel } from "./model.ts"
import { CHECK_LIMITS, withChecker } from "./runner.ts"

// These tests run the real checker (tla-ts) in the real worker.
//
// The first part checks what the rules of a workflow say (spec 010, "Check"). The second part
// checks that the check reads the shape of a workflow only. No text of the user may reach the
// checker: a name, a prompt, a question and an option label are free text, and the form that the
// checker reads is code. These tests send hostile text through the real worker and read the form
// that it gets.

/** Text that breaks a form that is built with string pasting, or a shell, or a parser. */
const HOSTILE = [
  `"; process.exit()`,
  "`touch /tmp/pwned`",
  "$" + "{process.exit()}",
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
  kind: NodeKind,
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
  backup: null,
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
    { id: "c1", from: "d", to: "a", source: { kind: "option", optionId: "d-o1" } },
    { id: "c2", from: "d", to: "b", source: { kind: "option", optionId: "d-o2" } },
    { id: "c3", from: "a", to: "j", source: { kind: "text" } },
    { id: "c4", from: "b", to: "j", source: { kind: "text" } },
  ],
})

/** Checks graphs with one real worker, and keeps the forms that the checker got for each. */
const checkSeen = async (...graphs: WorkflowGraph[]) =>
  withChecker(CHECK_LIMITS, async (run) => {
    const results = []
    for (const graph of graphs) {
      const seen: { source: string; config: string }[] = []
      const spy: RunModel = (source, config) => {
        seen.push({ source, config })
        return run(source, config)
      }
      results.push({ outcome: await checkWorkflow(graph, spy), seen })
    }
    return results
  })

describe("no text of the user reaches the checker", () => {
  const plain = graphWith((i) => `node ${i}`, ["Yes", "No"])

  test("hostile names, prompts, questions and options check as the plain graph does", async () => {
    const [base, ...hostile] = await checkSeen(
      plain,
      ...HOSTILE.map((bad) => graphWith(() => bad, [bad, `${bad} 2`])),
    )
    expect(base?.outcome).toEqual({ state: "passed" })
    expect(base?.seen.length).toBeGreaterThan(0)
    expect(hostile).toHaveLength(HOSTILE.length)
    for (const one of hostile) {
      expect(one.outcome).toEqual({ state: "passed" })
      // The checker gets exactly the forms that it gets for the plain graph.
      expect(one.seen).toEqual(base?.seen ?? [])
    }
  })

  test("the form of the checker holds none of the text of the user", async () => {
    const marker = "MARKER-7f3a-user-text"
    const [one] = await checkSeen(graphWith(() => marker, [marker, `${marker}-2`]))
    const seen = one?.seen ?? []
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
        { id: "c1", from: "a", to: "b", source: { kind: "text" } },
        { id: "c2", from: "b", to: "a", source: { kind: "text" } },
      ],
    }
    const [one] = await checkSeen(loop)
    const { outcome, seen } = one ?? { outcome: null, seen: [] }
    expect(outcome).toMatchObject({ state: "problem", problems: [{ code: "deadlock" }] })
    for (const form of seen) expect(form.source).not.toContain("Evil")
  })

  test("a problem of the shape with hostile text is found before the checker starts", async () => {
    const unconnected = graphWith((i) => HOSTILE[i] as string, ["Yes", "No"])
    const cut: WorkflowGraph = {
      nodes: unconnected.nodes,
      connections: unconnected.connections.filter((c) => c.id !== "c2"),
    }
    const [one] = await checkSeen(cut)
    const { outcome, seen } = one ?? { outcome: null, seen: [] }
    expect(outcome).toMatchObject({ state: "problem", problems: [{ code: "option_unconnected" }] })
    expect(seen).toEqual([])
  })
})

// ---- The rules of the check ----

interface Spec {
  /** A node: its id, and for a decision node the labels of its options. */
  readonly nodes: readonly (readonly [string, ...string[]])[]
  /** A connection: from, to, and the option label for a decision node or the output for an approval node. */
  readonly edges: readonly (readonly [string, string] | readonly [string, string, string])[]
  /** The ids of the nodes that are approval nodes. */
  readonly approval?: readonly string[]
}

const graphOf = (spec: Spec): WorkflowGraph => {
  const gate = new Set(spec.approval ?? [])
  return {
    nodes: spec.nodes.map(([id, ...options], i) => ({
      ...node(
        id,
        i + 1,
        gate.has(id) ? "approval" : options.length > 0 ? "decision" : "text",
        `Name ${id}`,
      ),
      prompt: "",
      question: gate.has(id) ? `Question ${id}` : "",
      options: gate.has(id) ? [] : options.map((label) => ({ id: `${id}:${label}`, label })),
    })),
    connections: spec.edges.map(
      ([from, to, option], i): WorkflowConnection => ({
        id: `c${i}`,
        from,
        to,
        source:
          !gate.has(from) && option !== undefined
            ? { kind: "option", optionId: `${from}:${option}` }
            : gate.has(from) && (option === "approve" || option === "reject")
              ? { kind: "verdict", verdict: option }
              : { kind: "text" },
      }),
    ),
  }
}

const problemOf = (outcome: CheckOutcome): CheckProblem => {
  if (outcome.state !== "problem") throw new Error(`Expected a problem, got ${outcome.state}`)
  const first = outcome.problems[0]
  if (!first) throw new Error("No problem in the list")
  return first
}

describe("the check of a workflow (spec 010)", () => {
  // The tests of this part share one worker: the start of a worker is the slow part of a check.
  // The time limit counts from the start of the worker, so the shared worker gets room for all
  // the tests. The test of 30 nodes keeps the limit of one check.
  let run: RunModel = () => Promise.reject(new Error("The worker is not started."))
  let stop: () => void = () => {}
  let finished: Promise<unknown> = Promise.resolve()
  beforeAll(async () => {
    await new Promise<void>((ready) => {
      finished = withChecker({ ...CHECK_LIMITS, timeMs: CHECK_LIMITS.timeMs * 20 }, (shared) => {
        run = shared
        ready()
        return new Promise<void>((resolve) => {
          stop = resolve
        })
      })
    })
  })
  afterAll(async () => {
    stop()
    await finished
  })

  const check = (graph: WorkflowGraph, wrap: (run: RunModel) => RunModel = (x) => x) =>
    checkWorkflow(graph, wrap(run))

  test("a workflow with no node passes", async () => {
    expect(await check({ nodes: [], connections: [] })).toEqual({ state: "passed" })
  })

  test("a chain of text nodes passes, and a node with no input is a start node", async () => {
    const graph = graphOf({
      nodes: [["a"], ["b"], ["c"], ["lonely"]],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
    })
    expect(await check(graph)).toEqual({ state: "passed" })
  })

  test("a decision node with each option connected passes, and so does a join after it", async () => {
    const graph = graphOf({
      nodes: [["a"], ["d", "yes", "no"], ["x"], ["y"], ["join"]],
      edges: [
        ["a", "d"],
        ["d", "x", "yes"],
        ["d", "y", "no"],
        ["x", "join"],
        ["y", "join"],
      ],
    })
    expect(await check(graph)).toEqual({ state: "passed" })
  })

  test("a loop is a deadlock: the nodes of the loop wait for each other, with the path to it", async () => {
    const graph = graphOf({
      nodes: [["start"], ["a"], ["b"], ["after"]],
      edges: [
        ["start", "a"],
        ["a", "b"],
        ["b", "a"],
        ["b", "after"],
      ],
    })
    const problem = problemOf(await check(graph))
    expect(problem.code).toBe("deadlock")
    expect([...problemNodeIds(problem)].sort()).toEqual(["a", "b"])
    // The shortest path: the start node runs, then no node can start.
    expect(problemPath(problem)).toEqual([
      { nodeId: "start", event: "ran", optionId: null, output: null },
    ])
  })

  test("a workflow where every node has an input has no start: it is a deadlock", async () => {
    const graph = graphOf({
      nodes: [["a"], ["b"]],
      edges: [
        ["a", "b"],
        ["b", "a"],
      ],
    })
    const problem = problemOf(await check(graph))
    expect(problem.code).toBe("deadlock")
    expect(problemPath(problem)).toEqual([])
  })

  test("a node after a loop is blocked, and the problem names the loop", async () => {
    const graph = graphOf({
      nodes: [["a"], ["b"], ["tail"]],
      edges: [
        ["a", "b"],
        ["b", "a"],
        ["b", "tail"],
      ],
    })
    expect([...problemNodeIds(problemOf(await check(graph)))].sort()).toEqual(["a", "b"])
  })

  test("a deadlock after a decision node: the path names the option that the run takes", async () => {
    const graph = graphOf({
      nodes: [["d", "yes", "no"], ["ok"], ["bad1"], ["bad2"]],
      edges: [
        ["d", "ok", "yes"],
        ["d", "bad1", "no"],
        ["bad1", "bad2"],
        ["bad2", "bad1"],
      ],
    })
    const problem = problemOf(await check(graph))
    expect(problem.code).toBe("deadlock")
    // The shortest way to the deadlock: d takes an option, and the node of that option ends.
    const path = problemPath(problem)
    expect(path).toHaveLength(2)
    expect(path[0]).toMatchObject({ nodeId: "d", event: "ran" })
    expect(["d:yes", "d:no"]).toContain(path[0]?.optionId ?? "")
    // The loop is named, not the node "ok" and not the nodes that wait for the loop.
    expect([...problemNodeIds(problem)].sort()).toEqual(["bad1", "bad2"])
  })

  test("the form sees an approval node as a branch with two states", () => {
    const graph = graphOf({
      nodes: [["g"], ["x"], ["y"]],
      approval: ["g"],
      edges: [
        ["g", "x", "approve"],
        ["g", "y", "reject"],
      ],
    })
    const source = buildModule(
      [...graph.nodes].sort((a, b) => a.number - b.number),
      graph,
      null,
    )
    expect(source).toContain("OptionCount == <<2, 0, 0>>")
    expect(source).toContain("[from |-> 1, to |-> 2, opt |-> 1]")
    expect(source).toContain("[from |-> 1, to |-> 3, opt |-> 2]")
  })

  test("a deadlock after an approval node: the path names the output that the run takes", async () => {
    const graph = graphOf({
      nodes: [["g"], ["ok"], ["bad1"], ["bad2"]],
      approval: ["g"],
      edges: [
        ["g", "ok", "approve"],
        ["g", "bad1", "reject"],
        ["bad1", "bad2"],
        ["bad2", "bad1"],
      ],
    })
    const problem = problemOf(await check(graph))
    expect(problem.code).toBe("deadlock")
    const path = problemPath(problem)
    expect(path).toHaveLength(2)
    expect(path[0]).toMatchObject({ nodeId: "g", event: "ran", optionId: null })
    expect(["approve", "reject"]).toContain(path[0]?.output ?? "")
    expect([...problemNodeIds(problem)].sort()).toEqual(["bad1", "bad2"])
  })

  test("an approval output with no connection is no problem: the graph still passes", async () => {
    const graph = graphOf({
      nodes: [["g"], ["x"]],
      approval: ["g"],
      edges: [["g", "x", "approve"]],
    })
    expect(await check(graph)).toEqual({ state: "passed" })
  })

  test("an approval node with an empty question is a problem of the graph", async () => {
    const graph = graphOf({
      nodes: [["g"], ["x"]],
      approval: ["g"],
      edges: [["g", "x", "approve"]],
    })
    const empty: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === "g" ? { ...n, question: "" } : n)),
    }
    expect(problemOf(await check(empty))).toEqual({ code: "approval_question", nodeId: "g" })
  })

  test("a join after a decision node: the node that joins waits for both ends", async () => {
    // Only one option runs. The node "join" has two inputs. It runs when one of them passes on,
    // and the other input ends as skipped: a join after a decision is no deadlock.
    const graph = graphOf({
      nodes: [["d", "yes", "no"], ["x"], ["y"], ["join"], ["after"]],
      edges: [
        ["d", "x", "yes"],
        ["d", "y", "no"],
        ["x", "join"],
        ["y", "join"],
        ["join", "after"],
      ],
    })
    expect(await check(graph)).toEqual({ state: "passed" })
  })

  test("a decision option with no connection is a problem of the graph, with its place", async () => {
    const graph = graphOf({
      nodes: [["d", "yes", "no"], ["x"]],
      edges: [["d", "x", "yes"]],
    })
    expect(problemOf(await check(graph))).toEqual({
      code: "option_unconnected",
      nodeId: "d",
      optionId: "d:no",
    })
  })

  test("a decision node with one option is a problem of the graph", async () => {
    const graph = graphOf({ nodes: [["d", "only"], ["x"]], edges: [["d", "x", "only"]] })
    expect(problemOf(await check(graph))).toEqual({ code: "decision_options", nodeId: "d" })
  })

  test("more than 30 nodes is a problem of the graph", async () => {
    const graph = graphOf({
      nodes: Array.from({ length: NODES_MAX + 1 }, (_, i) => [`n${i}`] as [string]),
      edges: [],
    })
    expect(problemOf(await check(graph))).toEqual({ code: "nodes_full" })
  })

  test("a graph of 30 nodes with decisions and joins passes inside the limits", async () => {
    // Fourteen decision nodes in a row: each option leads to the next decision, or to a text node
    // that joins the line again. 28 nodes, an end node and a start node: 30. There are 2^14 ways
    // to run, and the check must not try every one of them.
    const nodes: [string, ...string[]][] = []
    const edges: ([string, string] | [string, string, string])[] = []
    for (let i = 0; i < 14; i++) {
      const next = i === 13 ? "end" : `d${i + 1}`
      nodes.push([`d${i}`, "a", "b"], [`t${i}`])
      edges.push([`d${i}`, `t${i}`, "a"], [`d${i}`, next, "b"], [`t${i}`, next])
    }
    nodes.push(["end"], ["start"])
    const graph = graphOf({ nodes, edges })
    expect(graph.nodes).toHaveLength(NODES_MAX)
    const started = performance.now()
    expect(await check(graph)).toEqual({ state: "passed" })
    // The check of 30 nodes ends far inside the time limit. This only guards a runaway.
    expect(performance.now() - started).toBeLessThan(CHECK_LIMITS.timeMs)
  })

  test("a node that no run reaches shows the shortest run that skips it", async () => {
    // The rules of a run give a node that never runs only after a loop, and the check names the
    // loop then. This module takes the input of node 3 away to read the path of that rule.
    const graph = graphOf({
      nodes: [["a"], ["b"], ["c"]],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
    })
    const outcome = await check(
      graph,
      (inner) => (source, config) =>
        inner(source.replace("Passes(i) == ", "Passes(i) == Conn[i].to # 3 /\\ "), config),
    )
    const problem = problemOf(outcome)
    expect(problem.code).toBe("never_runs")
    expect(problemNodeIds(problem)).toEqual(["c"])
    expect(problemPath(problem)).toEqual([
      { nodeId: "a", event: "ran", optionId: null, output: null },
      { nodeId: "b", event: "ran", optionId: null, output: null },
      { nodeId: "c", event: "skipped", optionId: null, output: null },
    ])
  })
})

describe("the module that the check reads", () => {
  test("it holds the graph and the standard rules, and no prompt and no name", () => {
    const graph = graphOf({ nodes: [["a"], ["d", "yes", "no"]], edges: [["a", "d"]] })
    const nodes = graph.nodes.map((n) => ({ ...n, prompt: "SECRET PROMPT" }))
    const source = buildModule(nodes, graph, null)
    expect(source).toContain("N == 2")
    expect(source).toContain("OptionCount == <<0, 2>>")
    expect(source).toContain("Conn == <<[from |-> 1, to |-> 2, opt |-> 0]>>")
    expect(source).toContain("no deadlock")
    expect(source).toContain("every node can run")
    expect(source).not.toContain("SECRET PROMPT")
    expect(source).not.toContain("Name a")
    expect(source).not.toContain("Name d")
  })
})
