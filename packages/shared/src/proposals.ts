import { sameModelChoice } from "./backup.ts"
import { charLength } from "./chars.ts"
import type { DiffSegment } from "./diff.ts"
import type { OutsideSource } from "./outside.ts"
import type { CheckOutcome } from "./workflowCheck.ts"
import {
  NODES_MAX,
  type NodeKind,
  OPTIONS_MIN,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowOption,
} from "./workflows.ts"

// Self-improvement (spec 002, 010): the proposals of a workflow, their limits, their states and the
// pure parts of a graph change. A point that the specs call open is not decided here
// (docs/spec-questions.md, rows of W2 for 002).

export const PROPOSAL_KINDS = ["document", "prompt", "graph", "memory"] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

/** The kinds that change the workflow itself: the limits "How often" count these (spec 002). */
export const isWorkflowChange = (kind: ProposalKind): boolean => kind !== "memory"

export const PROPOSAL_STATES = ["waiting", "applied", "rejected", "failed", "undone"] as const
export type ProposalState = (typeof PROPOSAL_STATES)[number]

/** At most 20 proposals wait for each workflow, of all kinds together (spec 002, "Limits"). */
export const PROPOSAL_WAIT_MAX = 20
/** A proposal that waits for 30 days goes to Rejected with the reason "Expired". */
export const PROPOSAL_EXPIRE_DAYS = 30
/** The reason is one line of at most 200 characters. */
export const PROPOSAL_REASON_MAX = 200
/** In 24 hours the responsible document makes at most 3 proposals of the kinds that change the workflow. */
export const PROPOSALS_PER_DAY = 3
/** The removed text and the added text of a document change or a prompt change, together. */
export const PROPOSAL_DIFF_MAX = 2000
/**
 * A graph change: the text of its added, changed and removed nodes (names, prompts, questions,
 * option labels), counted as the removed text and the added text together. Spec 002 names no limit
 * for the size of a graph change ("the rules of the graph", 010, hold the number of nodes only), so
 * this is a constant of the app with the value of the limit of a prompt change. The user reads all
 * of this text on the card before "Accept". The owner decides the value (docs/spec-questions.md).
 */
export const GRAPH_PROPOSAL_TEXT_MAX = 2000
/** The change log keeps 90 days and at most 1000 rows for each workflow. */
export const CHANGE_LOG_DAYS = 90
export const CHANGE_LOG_ROWS = 1000

/** Where a proposal came from: a run, a turn of the chat, or a memory check (spec 002, "Source"). */
export const PROPOSAL_SOURCES = ["run", "chat", "check"] as const
export type ProposalSourceKind = (typeof PROPOSAL_SOURCES)[number]

export interface ProposalSource {
  readonly kind: ProposalSourceKind
  /** The id of the run, or of the message of the turn. Null for a check. */
  readonly id: string | null
}

/**
 * Why a proposal is not Applied. The window turns the code into a text.
 * - `rejected`: "Rejected by you"; `expired`: "Expired".
 * - `document_changed`, `node_changed`, `graph_changed`: the target changed after the proposal.
 * - `node_deleted`, `memory_off`, `known`: the change cannot be made.
 */
export const PROPOSAL_REASONS = [
  "rejected",
  "expired",
  "document_changed",
  "node_changed",
  "graph_changed",
  "node_deleted",
  "memory_off",
  "known",
  "failed",
] as const
export type ProposalReason = (typeof PROPOSAL_REASONS)[number]

/** The node that a prompt change names, as it was when the proposal was made. */
export interface ProposalNode {
  readonly id: string
  readonly number: number
  readonly name: string
}

export interface GraphNodeRef {
  readonly number: number
  readonly name: string
  /** Set for the nodes of the new graph of a proposal: the id that the problems of the check name. */
  readonly id?: string
}

/**
 * The values of a node that the card shows, so the user reads the new text before "Accept"
 * (spec 002, "Card"). `account` is the name of the account when the caller knows it.
 */
export interface GraphNodeValues {
  readonly name: string
  readonly prompt: string
  readonly question: string
  /** The labels of the options of a decision node. */
  readonly options: readonly string[]
  readonly account: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly continueOnFailure: boolean
  readonly threshold: number
}

/** A node of a graph change: the node, and the fields that changed (for a changed node). */
export interface GraphNodeChange extends GraphNodeRef {
  readonly kind: NodeKind
  readonly fields: readonly string[]
  /** The values of the node after the change; for a removed node, the values it had. */
  readonly now: GraphNodeValues
  /** For a changed node, the values before the change. */
  readonly was: GraphNodeValues | null
}

export interface GraphConnectionChange {
  readonly from: GraphNodeRef
  readonly to: GraphNodeRef
  /** The label of the option of a decision node, or null. */
  readonly option: string | null
}

/** What a graph change adds, changes and removes (spec 002, "Card"). */
export interface GraphChange {
  readonly addedNodes: readonly GraphNodeChange[]
  readonly changedNodes: readonly GraphNodeChange[]
  readonly removedNodes: readonly GraphNodeChange[]
  readonly addedConnections: readonly GraphConnectionChange[]
  readonly removedConnections: readonly GraphConnectionChange[]
}

/** Whether the user may press "Accept" now, and why not. */
export type AcceptBlock = "run_working" | "check_problem" | "check_stopped" | null
/** Whether "Undo" works on an Applied row, and why not (spec 002, "Undo"). */
export type UndoBlock = "newer" | "run_working" | null

export interface Proposal {
  readonly id: string
  readonly workflowId: string
  readonly kind: ProposalKind
  /** The node of a prompt change. */
  readonly node: ProposalNode | null
  readonly reason: string
  readonly source: ProposalSource
  /** The first source of outside content, when the work that made the proposal held it. */
  readonly outside: OutsideSource | null
  readonly state: ProposalState
  readonly stateReason: ProposalReason | null
  readonly createdAt: number
  readonly answeredAt: number | null
  readonly undoneAt: number | null
  /** The old and the new text of a document change or a prompt change; the fact of a memory item. */
  readonly oldText: string | null
  readonly newText: string | null
  /** The marked difference of a document change or a prompt change. */
  readonly diff: readonly DiffSegment[] | null
  /** The change of a graph, and the state of the check for the new graph (spec 010). */
  readonly graph: GraphChange | null
  /** The nodes of the new graph, so the card can name the nodes of a problem of the check. */
  readonly graphNodes: readonly GraphNodeRef[]
  readonly check: CheckOutcome | null
  /** For a proposal that waits. */
  readonly acceptBlock: AcceptBlock
  /** For an Applied row. */
  readonly undoBlock: UndoBlock
  readonly canUndo: boolean
}

export interface ProposalsView {
  readonly workflowId: string
  /** The switch "Self-improvement" (spec 002). */
  readonly enabled: boolean
  /** The proposals that wait, oldest first. */
  readonly waiting: readonly Proposal[]
  /** The change log, newest first. */
  readonly log: readonly Proposal[]
  /** True when 20 proposals wait (spec 002, "How many wait"). */
  readonly full: boolean
  /**
   * The program that answers in the chat, when it is a vendor program that cannot use the tools of
   * the app: self-improvement cannot work with it (spec 002, "Surfaces", "Runtimes").
   */
  readonly programBlock: string | null
}

// ---------------------------------------------------------------------------------------------
// The fingerprint of a graph
// ---------------------------------------------------------------------------------------------

/**
 * A text that names the graph as a change sees it: the nodes with every field the user can set,
 * the options and the connections. The place of a node on the canvas is not in it, because a move
 * is not a change of the graph (spec 010). A proposal is stale when the fingerprint of the graph
 * is not the one that it was made against.
 */
export const graphFingerprint = (graph: WorkflowGraph): string =>
  JSON.stringify([
    [...graph.nodes]
      .sort((a, b) => a.number - b.number)
      .map((n) => [
        n.id,
        n.number,
        n.kind,
        n.name,
        n.prompt,
        n.accountId,
        n.model,
        n.effort,
        n.backup?.accountId ?? null,
        n.backup?.model ?? null,
        n.backup?.effort ?? null,
        n.silentLimit ?? null,
        n.permission,
        n.continueOnFailure,
        n.question,
        n.threshold,
        n.options.map((o) => [o.id, o.label]),
      ]),
    graph.connections.map((c) => `${c.from}|${c.to}|${c.optionId ?? ""}`).sort(),
  ])

// ---------------------------------------------------------------------------------------------
// A graph change, as the responsible document writes it
// ---------------------------------------------------------------------------------------------

/**
 * One node of the new graph. `keep` is the number that the node has now: the node keeps its id, its
 * place, its permission level and the fields that are left out. A node with no `keep` is a new node
 * and gets no permission level of its own (spec 002: a graph change never sets the permission level).
 */
export interface GraphProposalNode {
  readonly keep?: number
  readonly kind: NodeKind
  readonly name: string
  readonly prompt?: string
  readonly accountId?: string | null
  readonly model?: string | null
  readonly effort?: string | null
  readonly continueOnFailure?: boolean
  readonly question?: string
  readonly threshold?: number
  /** The labels of the options of a decision node. */
  readonly options?: readonly string[]
}

/** A connection of the new graph. `from` and `to` are places in the list of the new nodes, from 1. */
export interface GraphProposalConnection {
  readonly from: number
  readonly to: number
  /** The label of the option of a decision node that the connection leaves. */
  readonly option?: string
}

export interface GraphProposalInput {
  readonly nodes: readonly GraphProposalNode[]
  readonly connections: readonly GraphProposalConnection[]
}

/** The faults of the form of a graph change. The responsible document gets the text. */
export type GraphCompileError =
  | "nodes_empty"
  | "nodes_full"
  | "name_empty"
  | "keep_missing"
  | "keep_twice"
  | "keep_kind"
  | "account_change"
  | "decision_options"
  | "text_options"
  | "decision_fields"
  | "threshold"
  | "connection_node"
  | "connection_self"
  | "connection_option"
  | "connection_option_unexpected"
  | "connection_twice"
  | "no_change"

export type GraphCompile =
  | { readonly ok: true; readonly graph: WorkflowGraph }
  | { readonly ok: false; readonly error: GraphCompileError; readonly detail: string }

const fail = (error: GraphCompileError, detail: string): GraphCompile => ({
  ok: false,
  error,
  detail,
})

/**
 * Builds the new graph of a graph change from the graph now. It checks the form only. The check on
 * the TLA form (a deadlock, a node that no run reaches) is the job of the check (spec 010), and the
 * models are checked against the accounts by the caller (spec 006).
 */
export const compileGraph = (
  current: WorkflowGraph,
  input: GraphProposalInput,
  newId: () => string,
): GraphCompile => {
  if (input.nodes.length === 0) return fail("nodes_empty", "")
  if (input.nodes.length > NODES_MAX) return fail("nodes_full", String(NODES_MAX))
  const byNumber = new Map(current.nodes.map((n) => [n.number, n]))
  const used = new Set<number>()
  const maxX = current.nodes.reduce((m, n) => Math.max(m, n.x), 0)
  let fresh = 0
  const nodes: WorkflowNode[] = []
  for (const [index, spec] of input.nodes.entries()) {
    const place = index + 1
    const name = spec.name.trim()
    if (name === "") return fail("name_empty", String(place))
    const old = spec.keep === undefined ? undefined : byNumber.get(spec.keep)
    if (spec.keep !== undefined) {
      if (!old) return fail("keep_missing", String(spec.keep))
      if (used.has(spec.keep)) return fail("keep_twice", String(spec.keep))
      if (old.kind !== spec.kind) return fail("keep_kind", String(spec.keep))
      // Spec 002 lets a graph change set the model of a node only to a value that the account of
      // the node offers. It does not let a graph change move a node to another account.
      if (spec.kind === "text" && spec.accountId !== undefined && spec.accountId !== old.accountId)
        return fail("account_change", String(spec.keep))
      used.add(spec.keep)
    }
    const threshold = spec.threshold ?? old?.threshold ?? 0.9
    if (!(threshold >= 0 && threshold <= 1)) return fail("threshold", String(place))
    const id = old?.id ?? newId()
    let options: WorkflowOption[] = []
    if (spec.kind === "decision") {
      if (spec.accountId || spec.model || spec.effort) return fail("decision_fields", String(place))
      const labels = (spec.options ?? old?.options.map((o) => o.label) ?? []).map((l) => l.trim())
      if (labels.length < OPTIONS_MIN || labels.some((l) => l === ""))
        return fail("decision_options", String(place))
      if (new Set(labels).size !== labels.length) return fail("decision_options", String(place))
      const known = new Map((old?.options ?? []).map((o) => [o.label, o.id]))
      options = labels.map((label) => ({ id: known.get(label) ?? newId(), label }))
    } else if ((spec.options ?? []).length > 0) return fail("text_options", String(place))
    const isNew = old === undefined
    if (isNew) fresh++
    nodes.push({
      id,
      number: place,
      kind: spec.kind,
      name,
      prompt: spec.kind === "decision" ? "" : (spec.prompt ?? old?.prompt ?? ""),
      accountId:
        spec.kind === "decision"
          ? null
          : spec.accountId !== undefined
            ? spec.accountId
            : (old?.accountId ?? null),
      model:
        spec.kind === "decision"
          ? null
          : spec.model !== undefined
            ? spec.model
            : (old?.model ?? null),
      effort:
        spec.kind === "decision"
          ? null
          : spec.effort !== undefined
            ? spec.effort
            : (old?.effort ?? null),
      // A graph change keeps the backup of a node that stays and never sets one (spec 006).
      backup: spec.kind === "decision" ? null : (old?.backup ?? null),
      // A graph change keeps the silent limit of a node that stays and never sets one (spec 010).
      silentLimit: spec.kind === "decision" ? null : (old?.silentLimit ?? null),
      permission: old?.permission ?? null,
      continueOnFailure: spec.continueOnFailure ?? old?.continueOnFailure ?? false,
      question: spec.kind === "decision" ? (spec.question ?? old?.question ?? "") : "",
      threshold,
      options,
      x: old?.x ?? maxX + 260 * fresh,
      y: old?.y ?? 0,
    })
  }
  const connections: WorkflowConnection[] = []
  const seen = new Set<string>()
  for (const spec of input.connections) {
    const from = nodes[spec.from - 1]
    const to = nodes[spec.to - 1]
    if (!from || !to) return fail("connection_node", `${spec.from}->${spec.to}`)
    if (from.id === to.id) return fail("connection_self", String(spec.from))
    let optionId: string | null = null
    if (from.kind === "decision") {
      const option = from.options.find((o) => o.label === spec.option?.trim())
      if (!option) return fail("connection_option", `${spec.from}: ${spec.option ?? ""}`)
      optionId = option.id
    } else if (spec.option !== undefined && spec.option !== "")
      return fail("connection_option_unexpected", String(spec.from))
    const key = optionId ?? `${from.id}|${to.id}`
    if (seen.has(key)) return fail("connection_twice", `${spec.from}->${spec.to}`)
    seen.add(key)
    // A connection that is kept keeps its id, so a restore of a version still finds it.
    const old = current.connections.find(
      (c) => c.from === from.id && c.to === to.id && c.optionId === optionId,
    )
    connections.push({ id: old?.id ?? newId(), from: from.id, to: to.id, optionId })
  }
  const graph: WorkflowGraph = { nodes, connections }
  if (graphFingerprint(graph) === graphFingerprint(current)) return fail("no_change", "")
  return { ok: true, graph }
}

// ---------------------------------------------------------------------------------------------
// The difference of two graphs
// ---------------------------------------------------------------------------------------------

const NODE_FIELDS: readonly (readonly [string, (n: WorkflowNode) => string])[] = [
  ["name", (n) => n.name],
  ["prompt", (n) => n.prompt],
  ["account", (n) => n.accountId ?? ""],
  ["model", (n) => n.model ?? ""],
  ["effort", (n) => n.effort ?? ""],
  ["continueOnFailure", (n) => String(n.continueOnFailure)],
  ["question", (n) => n.question],
  ["threshold", (n) => String(n.threshold)],
  ["options", (n) => JSON.stringify(n.options.map((o) => o.label))],
]

/** True when the new graph moves a node that it keeps to another account (not allowed, spec 002). */
export const movesAccount = (before: WorkflowGraph, after: WorkflowGraph): number | null => {
  const old = new Map(before.nodes.map((n) => [n.id, n]))
  for (const n of after.nodes) {
    const was = old.get(n.id)
    if (was && was.kind === "text" && was.accountId !== n.accountId) return n.number
  }
  return null
}

/**
 * The number of the first node whose backup model is not the backup of the same node before, or
 * null. A new node must have none. A graph change never sets or moves a backup model: a backup is a
 * second account for the node, so only the user sets it, in the editor (spec 006, "Backup model";
 * docs/spec-questions.md, B6).
 */
export const changesBackup = (before: WorkflowGraph, after: WorkflowGraph): number | null => {
  const old = new Map(before.nodes.map((n) => [n.id, n]))
  for (const n of after.nodes) {
    const was = old.get(n.id)?.backup ?? null
    const now = n.backup ?? null
    if (was === null && now === null) continue
    if (!sameModelChoice(was, now)) return n.number
  }
  return null
}

/**
 * The nodes and the connections that a change adds, changes and removes (spec 002, "Card"), with
 * the values that the user reads. `accountName` turns an account id into the name that the window
 * shows.
 */
export const graphChange = (
  before: WorkflowGraph,
  after: WorkflowGraph,
  accountName: (id: string) => string = (id) => id,
): GraphChange => {
  const old = new Map(before.nodes.map((n) => [n.id, n]))
  const next = new Map(after.nodes.map((n) => [n.id, n]))
  const values = (n: WorkflowNode): GraphNodeValues => ({
    name: n.name,
    prompt: n.prompt,
    question: n.question,
    options: n.options.map((o) => o.label),
    account: n.accountId === null ? null : accountName(n.accountId),
    model: n.model,
    effort: n.effort,
    continueOnFailure: n.continueOnFailure,
    threshold: n.threshold,
  })
  const change = (
    n: WorkflowNode,
    fields: readonly string[] = [],
    was: WorkflowNode | null = null,
  ): GraphNodeChange => ({
    number: n.number,
    name: n.name,
    kind: n.kind,
    fields,
    now: values(n),
    was: was ? values(was) : null,
  })
  const addedNodes = after.nodes.filter((n) => !old.has(n.id)).map((n) => change(n))
  const removedNodes = before.nodes.filter((n) => !next.has(n.id)).map((n) => change(n))
  const changedNodes: GraphNodeChange[] = []
  for (const n of after.nodes) {
    const was = old.get(n.id)
    if (!was) continue
    const fields = NODE_FIELDS.filter(([, read]) => read(was) !== read(n)).map(([name]) => name)
    if (was.number !== n.number) fields.push("number")
    if (fields.length > 0) changedNodes.push(change(n, fields, was))
  }
  const key = (c: WorkflowConnection) => `${c.from}|${c.to}|${c.optionId ?? ""}`
  const oldKeys = new Set(before.connections.map(key))
  const newKeys = new Set(after.connections.map(key))
  const view = (c: WorkflowConnection, within: WorkflowGraph): GraphConnectionChange => {
    const from = within.nodes.find((n) => n.id === c.from)
    const to = within.nodes.find((n) => n.id === c.to)
    return {
      from: { number: from?.number ?? 0, name: from?.name ?? "" },
      to: { number: to?.number ?? 0, name: to?.name ?? "" },
      option: from?.options.find((o) => o.id === c.optionId)?.label ?? null,
    }
  }
  return {
    addedNodes,
    changedNodes,
    removedNodes,
    addedConnections: after.connections
      .filter((c) => !oldKeys.has(key(c)))
      .map((c) => view(c, after)),
    removedConnections: before.connections
      .filter((c) => !newKeys.has(key(c)))
      .map((c) => view(c, before)),
  }
}

/**
 * The size of a graph change: the characters of the text of the added and the removed nodes, and of
 * the removed and the added text of the changed nodes (names, prompts, questions, option labels).
 * The card shows this number, and the limit `GRAPH_PROPOSAL_TEXT_MAX` counts it.
 */
export const graphChangeSize = (c: GraphChange): number => {
  const text = (v: GraphNodeValues) =>
    charLength(v.name) +
    charLength(v.prompt) +
    charLength(v.question) +
    v.options.reduce((sum, o) => sum + charLength(o), 0)
  const field = (v: GraphNodeValues, f: string) =>
    f === "name"
      ? charLength(v.name)
      : f === "prompt"
        ? charLength(v.prompt)
        : f === "question"
          ? charLength(v.question)
          : f === "options"
            ? v.options.reduce((sum, o) => sum + charLength(o), 0)
            : 0
  let size = 0
  for (const n of [...c.addedNodes, ...c.removedNodes]) size += text(n.now)
  for (const n of c.changedNodes)
    for (const f of n.fields) size += field(n.now, f) + (n.was ? field(n.was, f) : 0)
  return size
}

/** True when a graph change holds no node and no connection change. */
export const emptyGraphChange = (c: GraphChange): boolean =>
  c.addedNodes.length +
    c.changedNodes.length +
    c.removedNodes.length +
    c.addedConnections.length +
    c.removedConnections.length ===
  0

/** The words that tell the responsible document why a graph change was refused. */
export const compileErrorText = (error: GraphCompileError, detail: string): string => {
  switch (error) {
    case "nodes_empty":
      return "The graph needs at least one node."
    case "nodes_full":
      return `A graph holds at most ${detail} nodes.`
    case "name_empty":
      return `Node ${detail} has no name.`
    case "keep_missing":
      return `"keep" names node ${detail}, which does not exist now.`
    case "keep_twice":
      return `"keep" names node ${detail} twice.`
    case "keep_kind":
      return `Node ${detail} cannot change its kind. Remove it and add a new node instead.`
    case "account_change":
      return `A graph change cannot move node ${detail} to another account. Leave out "accountId" for a node that you keep, or add a new node.`
    case "decision_options":
      return `A decision node needs at least two different options with a label (node ${detail}).`
    case "text_options":
      return `A text node has no options (node ${detail}).`
    case "decision_fields":
      return `A decision node has no account, model or reasoning level (node ${detail}).`
    case "threshold":
      return `The threshold of node ${detail} must be between 0 and 1.`
    case "connection_node":
      return `A connection names a node that is not in the list (${detail}).`
    case "connection_self":
      return `A connection joins node ${detail} to itself.`
    case "connection_option":
      return `A connection of a decision node must name one of its options (${detail}).`
    case "connection_option_unexpected":
      return `Only a decision node has options (node ${detail}).`
    case "connection_twice":
      return `The same connection is listed twice (${detail}), or an option has two connections.`
    case "no_change":
      return "This graph is the graph that the workflow has now. Nothing to propose."
  }
}
