import { type GraphProblem, type WorkflowGraph } from "./workflows.ts"

// The check of a workflow (spec 010, "Check"): the result as data, with the place of each fault.
// The window turns a problem into a text with its translation keys. Points that the specs call
// open are not decided here (docs/spec-questions.md, rows for 010).

/**
 * The limits of one check. The earlier spec of the check named 1,000,000 states and 60 seconds.
 * The current spec leaves the limit open (docs/spec-questions.md, W1), so these are the values
 * that were last stated.
 */
export const CHECK_TIME_MS = 60_000
export const CHECK_STATES_MAX = 1_000_000

/** One line of a path: what happens at one node of a run (spec 010, "Problem found"). */
export interface CheckStep {
  readonly nodeId: string
  /** `ran`: the node runs. A decision node also names the option that it takes. */
  readonly event: "ran" | "skipped"
  readonly optionId: string | null
  /** An approval node that ran: the output that it took. */
  readonly output: "approve" | "reject" | null
}

/** A problem that the check finds in the states of the TLA form. Each one has the shortest path. */
export type ModelProblem =
  | {
      /** A run that cannot end: the nodes of `nodeIds` wait for each other. */
      readonly code: "deadlock"
      readonly nodeIds: readonly string[]
      readonly path: readonly CheckStep[]
    }
  | {
      /** A node that no run reaches: every run skips it. */
      readonly code: "never_runs"
      readonly nodeIds: readonly string[]
      readonly path: readonly CheckStep[]
    }

export type CheckProblem = GraphProblem | ModelProblem

/** Why the check stopped before it had an answer. */
export type CheckStopReason = "time" | "states" | "memory"

export type CheckOutcome =
  | { readonly state: "passed" }
  | { readonly state: "problem"; readonly problems: readonly CheckProblem[] }
  /** The checker went over a limit of the check (see `CHECK_TIME_MS`). */
  | { readonly state: "stopped"; readonly reason: CheckStopReason }
  /** The checker could not read the model. This is a fault of the app, not of the workflow. */
  | { readonly state: "failed"; readonly message: string }

/** The state of the check on a card (spec 001, 010; the words are in docs/glossary.md). */
export const CHECK_STATES = ["not_checked", "passed", "problem", "could_not"] as const
export type CheckState = (typeof CHECK_STATES)[number]

export const checkStateOf = (outcome: CheckOutcome | null): CheckState => {
  if (outcome === null) return "not_checked"
  if (outcome.state === "passed") return "passed"
  if (outcome.state === "problem") return "problem"
  return "could_not"
}

/** The ids of the nodes that a problem is about. A problem of the whole graph has none. */
export const problemNodeIds = (problem: CheckProblem): readonly string[] =>
  "nodeIds" in problem ? problem.nodeIds : "nodeId" in problem ? [problem.nodeId] : []

/** The path of a problem. The structural problems of the graph have none. */
export const problemPath = (problem: CheckProblem): readonly CheckStep[] =>
  "path" in problem ? problem.path : []

/**
 * A text that names exactly what the check reads: the order of the nodes, their kinds, the options
 * and the connections. A result stays valid while this text stays the same. A name, a prompt, a
 * model and a place on the canvas are not in it (spec 010: the check reads the shape only).
 */
export const checkGraphKey = (graph: WorkflowGraph): string =>
  JSON.stringify([
    graph.nodes.map((n) => [n.id, n.kind, n.options.map((o) => o.id)]),
    graph.connections.map((c) => [
      c.from,
      c.to,
      c.source.kind === "option"
        ? c.source.optionId
        : c.source.kind === "verdict"
          ? c.source.verdict
          : null,
    ]),
  ])
