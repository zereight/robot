import { Schema } from "effect"
import type { ModelPick } from "./backup.ts"
import { SilentLimit } from "./settings.ts"
import { PERMISSION_LEVELS, type PermissionLevel } from "./tools.ts"
import type { CheckOutcome, CheckState } from "./workflowCheck.ts"

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

export const NODE_KINDS = ["text", "decision", "approval"] as const
export type NodeKind = (typeof NODE_KINDS)[number]

/** The two outputs of an approval node: the run follows the one that the user picks (spec 010). */
export const APPROVAL_OUTPUTS = ["approve", "reject"] as const
export type ApprovalOutput = (typeof APPROVAL_OUTPUTS)[number]

/** The comment of the user on an approval card has at most 2,000 characters (spec 010). */
export const APPROVAL_COMMENT_MAX = 2000

/**
 * The silent limit of a node: minutes of silence, 0 for Never, or "follow" for the setting
 * (spec 010, "Silent limit of a node").
 */
export const NodeSilentLimit = Schema.Union([SilentLimit, Schema.Literal("follow")])
export type NodeSilentLimit = typeof NodeSilentLimit.Type

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
  /** The switch "Work in a new worktree" (spec 007, "New worktree"). Off at first. */
  readonly newWorktree: boolean
  readonly permission: PermissionLevel
  readonly selfImprovement: boolean
  /** The proposals of self-improvement that wait for the user (spec 002). The list shows that one waits. */
  readonly proposals: number
  readonly nodeCount: number
  /** True while a run works or waits. The editor is read-only then (spec 010, "Rules"). */
  readonly running: boolean
  /**
   * True while a task of a run really works. A run that only waits for the user or in the queue
   * keeps `running` true (the editor stays read-only) but not `working`: the spinners of the card
   * and of the chat follow `working` (specs/039: a spinner ends when the work ends).
   */
  readonly working: boolean
  /** The last run, or null when the workflow never ran. */
  readonly lastRun: LastRun | null
  /** The state of the check of the graph as it is now (spec 010, "Check"). */
  readonly check: CheckState
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
  /**
   * The backup model of a text node (spec 006, "Backup model"), or null. Only the user sets it, in
   * the editor: a proposal, the chat and a linked device cannot (docs/spec-questions.md, B6).
   */
  readonly backup: ModelPick | null
  /**
   * The silent limit of a text node: minutes, 0 for Never, or "follow" for the setting (spec 010,
   * "Silent limit of a node"). A decision node always holds "follow" and never reads it. Only the
   * user sets it, in the editor: a proposal and the chat keep it, and a node they add follows the
   * setting.
   */
  readonly silentLimit: NodeSilentLimit
  /** A stricter level than the workflow, or null for the level of the workflow. */
  readonly permission: PermissionLevel | null
  readonly continueOnFailure: boolean
  readonly question: string
  readonly threshold: number
  /** The options of a decision node, in order. Empty for a text or approval node. */
  readonly options: readonly WorkflowOption[]
  readonly x: number
  readonly y: number
}

/**
 * Which output of its source node a connection leaves: the single output of a text node, one
 * option of a decision node, or the answer of an approval node (spec 010).
 */
export const ConnectionSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text") }),
  Schema.Struct({ kind: Schema.Literal("option"), optionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("verdict"), verdict: Schema.Literals(APPROVAL_OUTPUTS) }),
])
export type ConnectionSource = typeof ConnectionSource.Type

export interface WorkflowConnection {
  readonly id: string
  readonly from: string
  readonly to: string
  /** Which output of the source node this connection leaves. */
  readonly source: ConnectionSource
}

/** The source that the two columns of a connection row name: an option wins, then a verdict. */
export const sourceOfColumns = (
  optionId: string | null,
  output: ApprovalOutput | null,
): ConnectionSource =>
  optionId !== null
    ? { kind: "option", optionId }
    : output !== null
      ? { kind: "verdict", verdict: output }
      : { kind: "text" }

/** The two columns of a connection row that a source fills. */
export const columnsOfSource = (
  source: ConnectionSource,
): { optionId: string | null; output: ApprovalOutput | null } =>
  source.kind === "option"
    ? { optionId: source.optionId, output: null }
    : source.kind === "verdict"
      ? { optionId: null, output: source.verdict }
      : { optionId: null, output: null }

/**
 * Which output of which node a connection leaves, as text. Two connections share it when they
 * leave the same output of the same node; two lines between the same text nodes share it too.
 */
export const connectionKey = (c: Pick<WorkflowConnection, "from" | "to" | "source">): string =>
  c.source.kind === "option"
    ? `${c.from}|${c.source.optionId}`
    : c.source.kind === "verdict"
      ? `${c.from}|${c.source.verdict}`
      : `${c.from}|${c.to}`

/** True when two sources leave the same output. */
export const sameSource = (a: ConnectionSource, b: ConnectionSource): boolean =>
  a.kind === "text"
    ? b.kind === "text"
    : a.kind === "option"
      ? b.kind === "option" && b.optionId === a.optionId
      : b.kind === "verdict" && b.verdict === a.verdict

/** A connection read from storage: the single field, or the two fields of a graph stored before it. */
export interface StoredConnection {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly source?: ConnectionSource | undefined
  readonly optionId?: string | null | undefined
  readonly output?: ApprovalOutput | null | undefined
}

/**
 * A connection of a stored graph, read through the single field. A graph from before the field
 * names an option id, a verdict, or neither: neither leaves the single output (spec 010).
 */
export const connectionFromJson = (c: StoredConnection): WorkflowConnection => ({
  id: c.id,
  from: c.from,
  to: c.to,
  source:
    c.source !== undefined && c.source !== null
      ? c.source
      : sourceOfColumns(c.optionId ?? null, c.output ?? null),
})

export interface WorkflowGraph {
  readonly nodes: readonly WorkflowNode[]
  readonly connections: readonly WorkflowConnection[]
}

export interface WorkflowDetail extends Workflow {
  /** The responsible document (spec 002). */
  readonly document: string
  readonly graph: WorkflowGraph
  /** The result of the check for this graph, or null when the graph is not checked yet. */
  readonly checkOutcome: CheckOutcome | null
  /** The names of the other workflows of the profile that share the folder (spec 025). */
  readonly sharedWith: readonly string[]
  /**
   * When the folder is shared: the names of the programs of text nodes that take no part in file
   * claims (spec 025, "Rules"). Empty when the folder is not shared.
   */
  readonly claimless: readonly string[]
}

export interface DocumentVersion {
  readonly id: string
  readonly text: string
  readonly source: DocumentSource
  readonly device: string | null
  readonly createdAt: number
}

/** A version of the graph: the graph as it was before a change that was saved (spec 010). */
export interface GraphVersion {
  readonly id: string
  readonly source: VersionSource
  readonly createdAt: number
  readonly graph: WorkflowGraph
}

const Level = Schema.Literals(PERMISSION_LEVELS)

/** A node to add (spec 010). A decision node needs at least two options. */
export const NodeInput = Schema.Struct({
  kind: Schema.Literals(NODE_KINDS),
  name: Schema.String,
  prompt: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  permission: Schema.optionalKey(Schema.NullOr(Level)),
  continueOnFailure: Schema.optionalKey(Schema.Boolean),
  question: Schema.optionalKey(Schema.String),
  threshold: Schema.optionalKey(Schema.Number),
  /** The labels of the options of a decision node. */
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
})
export type NodeInput = typeof NodeInput.Type

/** The backup model of a text node: an account, a model and a reasoning level (spec 006). */
export const BackupPick = Schema.Struct({
  accountId: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
})

/** A change of a node. A field that is left out stays as it was. */
export const NodePatch = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The backup model (spec 006). Null clears it. Only the editor of this computer may set it. */
  backup: Schema.optionalKey(Schema.NullOr(BackupPick)),
  /** The silent limit of a text node (spec 010). "follow" follows the setting. */
  silentLimit: Schema.optionalKey(NodeSilentLimit),
  permission: Schema.optionalKey(Schema.NullOr(Level)),
  continueOnFailure: Schema.optionalKey(Schema.Boolean),
  question: Schema.optionalKey(Schema.String),
  threshold: Schema.optionalKey(Schema.Number),
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
})
export type NodePatch = typeof NodePatch.Type

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
  | { readonly code: "approval_question"; readonly nodeId: string }
  | { readonly code: "option_unconnected"; readonly nodeId: string; readonly optionId: string }
  | { readonly code: "nodes_full" }

/**
 * The faults of the shape of a graph that the rules of the graph name (spec 010, "File"): a
 * decision node with fewer than two options, an approval node with an empty question, a decision
 * option with no connection, and more than 30 nodes. An output of an approval node with no
 * connection is not a problem: the run skips the nodes that only that output reaches (spec 010,
 * "Approval node rules"). A connection to a node that does not exist, and a connection of a node
 * to itself, cannot exist in the database. The check on the TLA form (a deadlock, a node that no
 * run reaches) is in `workflowCheck.ts`; the check reads these faults first.
 */
export const graphProblems = (graph: WorkflowGraph): readonly GraphProblem[] => {
  const problems: GraphProblem[] = []
  if (graph.nodes.length > NODES_MAX) problems.push({ code: "nodes_full" })
  const wired = new Set(
    graph.connections.flatMap((c) => (c.source.kind === "option" ? [c.source.optionId] : [])),
  )
  for (const node of graph.nodes) {
    if (node.kind === "decision") {
      if (node.options.length < OPTIONS_MIN)
        problems.push({ code: "decision_options", nodeId: node.id })
      for (const option of node.options)
        if (!wired.has(option.id))
          problems.push({ code: "option_unconnected", nodeId: node.id, optionId: option.id })
    } else if (node.kind === "approval") {
      if (node.question.trim() === "") problems.push({ code: "approval_question", nodeId: node.id })
    }
  }
  return problems
}
