import { describe, expect, test } from "bun:test"
import {
  type CheckOutcome,
  type CheckProblem,
  NODES_MAX,
  problemNodeIds,
  type WorkflowGraph,
  type WorkflowNode,
} from "@robot/shared"
import { buildModule, checkWorkflow, type RunModel } from "./model.ts"
import { CHECK_LIMITS, withChecker } from "./runner.ts"

// These tests run the real checker (tla-ts) in the real worker.

type Spec = {
  /** A node: its id, and for a decision node the labels of its options. */
  nodes: readonly (readonly [string] | readonly [string, ...string[]])[]
  /** A connection: from, to, and for a decision node the label of the option. */
  edges: readonly (readonly [string, string] | readonly [string, string, string])[]
}

const graphOf = (spec: Spec): WorkflowGraph => {
  const nodes = spec.nodes.map(
    ([id, ...options], i): WorkflowNode => ({
      id,
      number: i + 1,
      kind: options.length > 0 ? "decision" : "text",
      name: `Name ${id}`,
      prompt: "",
      accountId: null,
      model: null,
      effort: null,
      permission: null,
      continueOnFailure: false,
      question: "",
      threshold: 0.9,
      options: options.map((label) => ({ id: `${id}:${label}`, label })),
      x: 0,
      y: 0,
    }),
  )
  return {
    nodes,
    connections: spec.edges.map(([from, to, option], i) => ({
      id: `c${i}`,
      from,
      to,
      optionId: option === undefined ? null : `${from}:${option}`,
    })),
  }
}

const check = (graph: WorkflowGraph, wrap: (run: RunModel) => RunModel = (run) => run) =>
  withChecker(CHECK_LIMITS, (run) => checkWorkflow(graph, wrap(run)))

const problemOf = (outcome: CheckOutcome): CheckProblem => {
  if (outcome.state !== "problem") throw new Error(`Expected a problem, got ${outcome.state}`)
  const first = outcome.problems[0]
  if (!first) throw new Error("No problem in the list")
  return first
}

describe("the check of a workflow (spec 010)", () => {
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
    expect("path" in problem && problem.path).toEqual([
      { nodeId: "start", event: "ran", optionId: null },
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
    expect("path" in problem && problem.path).toEqual([])
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
    const path = "path" in problem ? problem.path : []
    expect(path[0]).toMatchObject({ nodeId: "d", event: "ran" })
    expect(["d:yes", "d:no"]).toContain(path[0]?.optionId ?? "")
    expect(path).toHaveLength(2)
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
      nodes: Array.from({ length: NODES_MAX + 1 }, (_, i) => [`n${i}`] as const),
      edges: [],
    })
    expect(problemOf(await check(graph))).toEqual({ code: "nodes_full" })
  })

  test("a graph of 30 nodes with decisions and joins passes", async () => {
    // Fourteen decision nodes in a row: each option leads to the next decision or to a text node
    // that joins the line again. 30 nodes, 2^14 ways to run, a few hundred states.
    const nodes: [string, ...string[]][] = []
    const edges: [string, string, string][] = []
    for (let i = 0; i < 14; i++) {
      nodes.push([`d${i}`, "a", "b"])
      nodes.push([`t${i}`])
    }
    nodes.push(["end"], ["start"])
    for (let i = 0; i < 14; i++) {
      const next = i === 13 ? "end" : `d${i + 1}`
      edges.push([`d${i}`, `t${i}`, "a"], [`d${i}`, next, "b"], [`t${i}`, next, ""] as never)
    }
    const graph = graphOf({
      nodes,
      edges: edges.map(([from, to, option]) => (option === "" ? [from, to] : [from, to, option])),
    })
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
      (run) => (source, config) =>
        run(source.replace("Passes(i) == ", "Passes(i) == Conn[i].to # 3 /\\ "), config),
    )
    const problem = problemOf(outcome)
    expect(problem.code).toBe("never_runs")
    expect(problemNodeIds(problem)).toEqual(["c"])
    expect("path" in problem && problem.path).toEqual([
      { nodeId: "a", event: "ran", optionId: null },
      { nodeId: "b", event: "ran", optionId: null },
      { nodeId: "c", event: "skipped", optionId: null },
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
  })
})
