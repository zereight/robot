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

export interface Workflow {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly folder: string
  readonly permission: PermissionLevel
  readonly selfImprovement: boolean
  readonly nodeCount: number
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

/** The problem of a graph, or null when the graph follows the rules of spec 010, "File". */
export type GraphProblem =
  | { readonly code: "too_many_nodes" }
  | { readonly code: "connection_node_missing"; readonly connection: string }
  | { readonly code: "connection_to_self"; readonly connection: string }
  | { readonly code: "decision_options"; readonly node: string }
  | { readonly code: "decision_option_unconnected"; readonly node: string; readonly option: string }

/** Checks the rules of the graph that spec 010 states. It does not check loops (not decided). */
export const graphProblem = (graph: WorkflowGraph): GraphProblem | null => {
  if (graph.nodes.length > NODES_MAX) return { code: "too_many_nodes" }
  const ids = new Set(graph.nodes.map((n) => n.id))
  for (const c of graph.connections) {
    if (!ids.has(c.from) || !ids.has(c.to))
      return { code: "connection_node_missing", connection: c.id }
    if (c.from === c.to) return { code: "connection_to_self", connection: c.id }
  }
  for (const node of graph.nodes) {
    if (node.kind !== "decision") continue
    if (node.options.length < OPTIONS_MIN) return { code: "decision_options", node: node.id }
    for (const option of node.options) {
      if (!graph.connections.some((c) => c.from === node.id && c.optionId === option.id))
        return { code: "decision_option_unconnected", node: node.id, option: option.id }
    }
  }
  return null
}
