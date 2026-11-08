import {
  APPROVAL_OUTPUTS,
  type CheckOutcome,
  type CheckProblem,
  type CheckStep,
  type CheckStopReason,
  graphProblems,
  type NodeKind,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from "@robot/shared"

// The TLA form of a workflow and the reading of what the checker says (spec 010, "Check").
//
// The form that the check reads is made from the graph each time. The workflow is not saved in it
// (the saved form of a workflow is open: docs/spec-questions.md, W1). It holds the graph (the kind
// of each node, the number of options of each decision node, the connections), and the standard
// rules that the app writes. The prompts are not in it: the check does not read what a node writes.
//
// How the form sees a run (spec 010, "Node input and output"):
// - A node waits until each of its inputs has ended. An input passes on when its node ran. It also
//   passes on from a decision node, when that node took the option of this connection.
// - A node with no input runs at the start. A node with inputs, where no input passes on, is
//   skipped. Otherwise it runs. A decision node takes one of its options. The check does not read
//   the input, so it tries every option.
// - The engine starts the ready node with the lowest number. The form does the same. Which node
//   starts first does not change which nodes run, so the check does not try every order.
// - A node that fails ends no connection that the check can use: a failure stops the run, or the
//   node has the mark "Continue on failure" and passes on as a node that ran. So the check needs
//   no failure state. (It reads the shape, not whether a tool works.)

/** The checker went over a limit. */
export class CheckStopped extends Error {
  constructor(readonly reason: CheckStopReason) {
    super(`The check stopped: ${reason}`)
  }
}

/** The checker could not read the form. */
export class ModelFault extends Error {}

/** What one run of the checker gives back, as plain data. */
export interface ModelRun {
  readonly status: "success" | "deadlock" | "violation"
  /** The states of the trace to the problem, oldest first. A value is JSON: a function over 1..N is an array. */
  readonly trace: readonly Readonly<Record<string, unknown>>[]
}

/** Runs the checker on a module with a configuration. */
export type RunModel = (source: string, config: string) => Promise<ModelRun>

/** The standard rule "no deadlock" is the deadlock check of the checker. */
const CONFIG = "INIT Init NEXT Next"

const OPTION_COUNTS: Record<NodeKind, (n: WorkflowNode) => number> = {
  text: () => 0,
  decision: (n) => n.options.length,
  approval: () => APPROVAL_OUTPUTS.length,
}

const SINGLE_OUTPUT = 0

const optOf = (source: WorkflowNode, c: WorkflowConnection): number => {
  const s = c.source
  if (s.kind === "option") return source.options.findIndex((o) => o.id === s.optionId) + 1
  if (s.kind === "verdict") return APPROVAL_OUTPUTS.indexOf(s.verdict) + 1
  return SINGLE_OUTPUT
}

/** `invariant` is a TLA expression over the state, or null for no invariant. */
export const buildModule = (
  nodes: readonly WorkflowNode[],
  graph: WorkflowGraph,
  invariant: string | null,
) => {
  const place = new Map(nodes.map((n, i) => [n.id, i + 1]))
  const connections = graph.connections.flatMap((c) => {
    const source = nodes.find((n) => n.id === c.from)
    const front = place.get(c.from)
    const to = place.get(c.to)
    if (!source || !front || !to) return []
    return [`[from |-> ${front}, to |-> ${to}, opt |-> ${optOf(source, c)}]`]
  })
  const tuple = (items: readonly (string | number)[]) =>
    items.length === 0 ? "<<>>" : `<<${items.join(", ")}>>`
  return String.raw`---- MODULE Workflow ----
EXTENDS Naturals, Sequences

\* The workflow, made by ROBot from the graph. Nodes are numbered 1 to N in the order of their
\* numbers. A connection leaves a node by its option (opt), or by 0 when the node is a text node.
VARIABLES status, taken
vars == <<status, taken>>
N == ${nodes.length}
Nodes == 1..N
OptionCount == ${tuple(nodes.map((n) => OPTION_COUNTS[n.kind](n)))}
Conn == ${tuple(connections)}

In(m) == {i \in 1..Len(Conn) : Conn[i].to = m}
Choices(m) == IF OptionCount[m] = 0 THEN {0} ELSE 1..OptionCount[m]
Ended(m) == status[m] # "waiting"
Passes(i) == status[Conn[i].from] = "ran" /\ taken[Conn[i].from] \in {0, Conn[i].opt}
Ready(m) == status[m] = "waiting" /\ \A i \in In(m) : Ended(Conn[i].from)
First(m) == Ready(m) /\ \A k \in Nodes : k < m => ~Ready(k)

Init == status = [m \in Nodes |-> "waiting"] /\ taken = [m \in Nodes |-> 0]
Run(m) == /\ First(m)
          /\ (In(m) = {} \/ \E i \in In(m) : Passes(i))
          /\ status' = [status EXCEPT ![m] = "ran"]
          /\ \E o \in Choices(m) : taken' = [taken EXCEPT ![m] = o]
Skip(m) == /\ First(m)
           /\ In(m) # {}
           /\ ~(\E i \in In(m) : Passes(i))
           /\ status' = [status EXCEPT ![m] = "skipped"]
           /\ UNCHANGED taken
Finished == (\A m \in Nodes : Ended(m)) /\ UNCHANGED vars
Next == Finished \/ \E m \in Nodes : Run(m) \/ Skip(m)

\* Standard rule: no deadlock. A state with a node that waits, where no node can start, is a
\* deadlock. The checker looks for it.
\* Standard rule: every node can run. The check tries to reach a state where the node ran.
${invariant === null ? "" : `Inv == ${invariant}\n`}====
`
}

const config = (invariant: string | null) =>
  invariant === null ? CONFIG : `${CONFIG} INVARIANT Inv`

interface Marks {
  readonly status: readonly string[]
  readonly taken: readonly number[]
}

const marksOf = (state: Readonly<Record<string, unknown>> | undefined): Marks => {
  const status = state?.status
  const taken = state?.taken
  if (
    !Array.isArray(status) ||
    !Array.isArray(taken) ||
    !status.every((s) => typeof s === "string") ||
    !taken.every((t) => typeof t === "number")
  )
    throw new ModelFault("The trace has a form that the check does not know.")
  return { status, taken }
}

/** The lines of the path: one line for each state of the trace that ended a node. */
const pathOf = (nodes: readonly WorkflowNode[], trace: ModelRun["trace"]): CheckStep[] => {
  const steps: CheckStep[] = []
  for (let i = 1; i < trace.length; i++) {
    const before = marksOf(trace[i - 1])
    const after = marksOf(trace[i])
    const index = after.status.findIndex((s, k) => s !== before.status[k])
    const node = nodes[index]
    if (!node) continue
    const event = after.status[index] === "ran" ? "ran" : "skipped"
    const taken = event === "ran" ? (after.taken[index] ?? 0) : 0
    steps.push({
      nodeId: node.id,
      event,
      optionId: node.kind === "decision" && taken ? (node.options[taken - 1]?.id ?? null) : null,
      output:
        node.kind === "approval" && (taken === 1 || taken === 2)
          ? (APPROVAL_OUTPUTS[taken - 1] ?? null)
          : null,
    })
  }
  return steps
}

const last = (trace: ModelRun["trace"]) => marksOf(trace[trace.length - 1])

/** The nodes that wait for each other in a deadlock state: a loop of waits, from the first waiting node. */
const waitLoop = (
  nodes: readonly WorkflowNode[],
  graph: WorkflowGraph,
  waiting: readonly boolean[],
) => {
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const waitsFor = (i: number) =>
    graph.connections
      .filter((c) => index.get(c.to) === i)
      .map((c) => index.get(c.from))
      .find((k): k is number => k !== undefined && waiting[k] === true)
  const seen: number[] = []
  let at = waiting.findIndex(Boolean)
  while (at >= 0 && !seen.includes(at)) {
    seen.push(at)
    at = waitsFor(at) ?? -1
  }
  const loop = at < 0 ? seen : seen.slice(seen.indexOf(at))
  return loop.map((i) => nodes[i]?.id).filter((id): id is string => id !== undefined)
}

/**
 * Checks a graph (spec 010, "Check"). The faults of the shape come first, as the rules of the graph
 * name them. Then the checker looks for a deadlock, and then for a node that no run reaches. The
 * result holds the first problem with the shortest path to it.
 */
export const checkWorkflow = async (graph: WorkflowGraph, run: RunModel): Promise<CheckOutcome> => {
  try {
    return await checkShape(graph, run)
  } catch (error) {
    if (error instanceof CheckStopped) return { state: "stopped", reason: error.reason }
    return { state: "failed", message: error instanceof Error ? error.message : String(error) }
  }
}

const checkShape = async (graph: WorkflowGraph, run: RunModel): Promise<CheckOutcome> => {
  const shape = graphProblems(graph)
  if (shape.length > 0) return { state: "problem", problems: shape }
  if (graph.nodes.length === 0) return { state: "passed" }
  const nodes = [...graph.nodes].sort((a, b) => a.number - b.number)
  const model = (invariant: string | null) =>
    run(buildModule(nodes, graph, invariant), config(invariant))

  const deadlock = await model(null)
  if (deadlock.status === "deadlock") {
    const waiting = last(deadlock.trace).status.map((s) => s === "waiting")
    const problem: CheckProblem = {
      code: "deadlock",
      nodeIds: waitLoop(nodes, graph, waiting),
      path: pathOf(nodes, deadlock.trace),
    }
    return { state: "problem", problems: [problem] }
  }

  // Every node can run: some run reaches a state where the node ran. Each witness removes the nodes
  // that ran in it from the nodes that are still open.
  let open = nodes.map((_, i) => i + 1)
  while (open.length > 0) {
    const witness = await model(
      String.raw`(\A m \in Nodes : Ended(m)) => \A m \in {${open.join(", ")}} : status[m] # "ran"`,
    )
    if (witness.status !== "violation") break
    const { status } = last(witness.trace)
    const left = open.filter((m) => status[m - 1] !== "ran")
    if (left.length === open.length) throw new ModelFault("The check found no node that ran.")
    open = left
  }
  const never = open[0]
  if (never === undefined) return { state: "passed" }
  // The shortest run that skips the node shows what happens to it.
  const skipped = await model(`status[${never}] # "skipped"`)
  const node = nodes[never - 1]
  if (skipped.status !== "violation" || !node)
    throw new ModelFault("The check found no run that skips the node.")
  return {
    state: "problem",
    problems: [{ code: "never_runs", nodeIds: [node.id], path: pathOf(nodes, skipped.trace) }],
  }
}
