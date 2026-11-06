import { Schema } from "effect"
import type { PermissionLevel } from "./tools.ts"

// The data model of a workflow (spec 010): a graph of nodes, one responsible document (002), one
// chat (003), one memory (008). Rules of the graph that the spec states are here as constants and
// checks. A point that the specs call open is not decided here (docs/spec-questions.md).

/** The responsible document holds 0 to 20000 characters (spec 002). Empty is valid. */
export const DOCUMENT_MAX = 20_000
/** A workflow keeps at most 50 versions of its responsible document. The oldest goes first (002). */
export const DOCUMENT_VERSIONS_MAX = 50
/** A workflow has at most 30 nodes (spec 010, "File"). */
export const NODES_MAX = 30
/** A decision node needs at least two options (spec 010, "Decision node rules"). */
export const OPTIONS_MIN = 2
/** The threshold of a new decision node (spec 010, "Flows", item 6). */
export const THRESHOLD_DEFAULT = 0.9

export const NODE_KINDS = ["text", "decision"] as const
export type NodeKind = (typeof NODE_KINDS)[number]

/** Where a change of the responsible document came from (spec 002, "Responsible document history"). */
export const DOCUMENT_SOURCES = ["editor", "proposal", "undo", "restore"] as const
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number]

/** Where a version of the graph came from (spec 010, "Flows", item 4). */
export const VERSION_SOURCES = ["editor", "chat", "proposal", "restore"] as const
export type VersionSource = (typeof VERSION_SOURCES)[number]

/** The state of a run follows its tasks, with the words of the states of a task (spec 005). */
export const RUN_STATES = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const
export type RunState = (typeof RUN_STATES)[number]

/** The state of the last run of a workflow, for the card of the list (spec 001). */
export interface LastRun {
  /** A state that this app does not know (a later version wrote it) is kept as it is. */
  readonly state: string
  readonly startedAt: number
}

export interface Workflow {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly folder: string
  readonly permission: PermissionLevel
  readonly selfImprovement: boolean
  readonly nodeCount: number
  /** True while a run works or waits. The editor is read-only then (spec 010, "Rules"). */
  readonly running: boolean
  /** The last run, or null when the workflow never ran. */
  readonly lastRun: LastRun | null
  /** The number of structural problems of the graph (see `graphProblems`). */
  readonly problems: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One option of a decision node. Each option is one outgoing connection (spec 010). */
export interface WorkflowOption {
  readonly id: string
  readonly label: string
}

export interface WorkflowNode {
  readonly id: string
  /** The place of the node in the list of nodes, from 1. Moving the node does not change it. */
  readonly number: number
  readonly kind: NodeKind
  readonly name: string
  readonly prompt: string
  readonly accountId: string | null
  readonly model: string | null
  readonly effort: string | null
  /** A stricter level than the workflow, or null for the level of the workflow. */
  readonly permission: PermissionLevel | null
  readonly continueOnFailure: boolean
  readonly question: string
  readonly threshold: number
  /** The options of a decision node, in order. Empty for a text node. */
  readonly options: readonly WorkflowOption[]
  readonly x: number
  readonly y: number
}

export interface WorkflowConnection {
  readonly id: string
  readonly from: string
  readonly to: string
  /** The option of the decision node that this connection leaves, or null. */
  readonly optionId: string | null
}

export interface WorkflowGraph {
  readonly nodes: readonly WorkflowNode[]
  readonly connections: readonly WorkflowConnection[]
}

export interface WorkflowDetail extends Workflow {
  /** The responsible document (spec 002). */
  readonly document: string
  readonly graph: WorkflowGraph
}

export interface DocumentVersion {
  readonly id: string
  readonly text: string
  readonly source: DocumentSource
  readonly device: string | null
  readonly createdAt: number
}

export const WorkflowCreate = Schema.Struct({
  serverId: Schema.String,
  name: Schema.String,
  /** The default text of the responsible document, in the language of the window. */
  document: Schema.optionalKey(Schema.String),
})
export type WorkflowCreate = typeof WorkflowCreate.Type

/** A structural problem of a graph: a fault of its shape that the editor can show (spec 010). */
export type GraphProblem =
  | { readonly code: "decision_options"; readonly nodeId: string }
  | { readonly code: "option_unconnected"; readonly nodeId: string; readonly optionId: string }
  | { readonly code: "nodes_full" }

/**
 * The faults of the shape of a graph that the rules of the graph name (spec 010, "File"): a
 * decision node with fewer than two options, an option with no connection, and more than 30 nodes.
 * A connection to a node that does not exist, and a connection of a node to itself, cannot exist
 * in the database. The check on the TLA form (a node that no run can reach, a deadlock) is not
 * here: it comes with the check of the workflow.
 */
export const graphProblems = (graph: WorkflowGraph): readonly GraphProblem[] => {
  const problems: GraphProblem[] = []
  if (graph.nodes.length > NODES_MAX) problems.push({ code: "nodes_full" })
  const wired = new Set(graph.connections.map((c) => c.optionId).filter((id) => id !== null))
  for (const node of graph.nodes) {
    if (node.kind !== "decision") continue
    if (node.options.length < OPTIONS_MIN)
      problems.push({ code: "decision_options", nodeId: node.id })
    for (const option of node.options)
      if (!wired.has(option.id))
        problems.push({ code: "option_unconnected", nodeId: node.id, optionId: option.id })
  }
  return problems
}
