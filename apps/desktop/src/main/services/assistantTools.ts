import { randomUUID } from "node:crypto"
import {
  type CheckProblem,
  carriesProgramMark,
  graphFingerprint,
  guardVerdict,
  looksLikeSecret,
  NODES_MAX,
  OPTIONS_MIN,
  type OutsideSource,
  type PermissionLevel,
  redactSecrets,
  THRESHOLD_DEFAULT,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
} from "@robot/shared"
import { Effect } from "effect"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall, ToolDef } from "../providers/chat.ts"
import type { CardReply } from "./Cards.ts"
import { escapeOutside, graphText, nodeLines, runFactsText } from "./chatPrompt.ts"
import type { AppError } from "./errors.ts"
import { modelsOfferedBy } from "./graphModels.ts"
import type { ProvidersService } from "./Providers.ts"
import type { RunFactsService } from "./RunFacts.ts"
import type { RunsService } from "./Runs.ts"
import type { WorkflowCheckService } from "./WorkflowCheck.ts"
import type { WorkflowsService } from "./Workflows.ts"

/**
 * The tools with which the responsible document reads and changes the workflow, lists workflows,
 * starts and stops a run, and reads a run (spec 010, "Assistant"; spec 007, "Following a run in
 * the chat", "Guarded steps"; spec 003).
 *
 * The rules, in the order that the code tests them:
 * 1. Only a turn that the user started in the chat may use them (`assistantGate`).
 * 2. A tool takes no id of a workflow. It works on the workflow of the chat. "List workflows" gives
 *    names and counts, never an id, a folder or a level.
 * 3. "Read only" refuses every change and the start of a run. Reads work at every level.
 * 4. A change is refused when the user changed the workflow after the turn last saw it, and while
 *    a run works.
 * 5. A change is tested (the form, the models of the accounts, secrets, the check) before it
 *    saves. Nothing is half saved: one change makes one version.
 * 6. A change, and the start of a run, in a turn that holds outside content ask the user first
 *    (`guardVerdict`).
 * 7. The text of a result never has a secret (`redactSecrets`) and names the marks of the task.
 */

// --- who may use the tools ------------------------------------------------------------------

/**
 * What started a turn. Only `user` is built now: a message of the user in the chat of the app.
 * A program (023) and Teams (028) are not built. A node of a run never has a turn of the chat.
 */
export type TurnOrigin = "user" | "program" | "teams" | "node"

/**
 * The one test of "who may use the tools of the chat" (spec 007, "Who may use them"; spec 010,
 * "Assistant"). Returns null when the turn may use them, or the text of the refusal. Every tool of
 * the chat that changes something, or that reads a run, goes through this function. A later slice
 * that starts a turn from a program or from Teams passes its own origin and gets the refusal.
 */
export const assistantGate = (origin: TurnOrigin): string | null =>
  origin === "user"
    ? null
    : "Refused: the tools of the chat work only in a turn that the user started in the chat of the workflow."

/** What a turn remembers between two calls (spec 010: the app refuses a stale change). */
export interface AssistantTurn {
  readonly origin: TurnOrigin
  /** The fingerprint of the graph as the turn last saw it: at its start, at a read, after its own change. */
  seen: string
  /** True after the turn started a run. A turn starts at most one (spec 010). */
  runStarted: boolean
}

export const newAssistantTurn = (origin: TurnOrigin, graph: WorkflowGraph): AssistantTurn => ({
  origin,
  seen: graphFingerprint(graph),
  runStarted: false,
})

// --- the definitions ------------------------------------------------------------------------

export const LIST_WORKFLOWS_TOOL = "list_workflows"
export const READ_WORKFLOW_TOOL = "read_workflow"
export const ADD_NODE_TOOL = "add_node"
export const EDIT_NODE_TOOL = "edit_node"
export const REMOVE_NODE_TOOL = "remove_node"
export const ADD_CONNECTION_TOOL = "add_connection"
export const REMOVE_CONNECTION_TOOL = "remove_connection"
export const ADD_OPTION_TOOL = "add_option"
export const RENAME_OPTION_TOOL = "rename_option"
export const REMOVE_OPTION_TOOL = "remove_option"
export const START_RUN_TOOL = "start_run"
export const STOP_RUN_TOOL = "stop_run"
export const READ_RUN_TOOL = "read_run"
export const READ_RESULT_TOOL = "read_run_result"

const node = { type: "integer", description: "The number of the node." }
const optionText = { type: "string", description: "The label of the option." }
const nodeFields = {
  name: { type: "string" },
  prompt: { type: "string", description: "A text node: its prompt." },
  accountId: {
    type: "string",
    description:
      "A text node: the id of a connected account. A node that has an account keeps it. Set it only for a node that has none, together with the model.",
  },
  model: {
    type: "string",
    description: "A text node: a model that the account of the node offers.",
  },
  effort: {
    type: "string",
    description: "A text node: a reasoning level that the model takes.",
  },
  continueOnFailure: { type: "boolean" },
  question: { type: "string", description: "A decision node: the question." },
  threshold: { type: "number", description: "A decision node: from 0 to 1." },
}

export const ASSISTANT_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: LIST_WORKFLOWS_TOOL,
    description:
      "Lists the workflows of this server: the name, the number of nodes, and the state of the last run. It gives no id. You can read the graph of this workflow only.",
    schema: { type: "object", properties: {} },
  },
  {
    name: READ_WORKFLOW_TOOL,
    description:
      "Reads the graph of this workflow now: the nodes with their numbers, the connections and the triggers. Read it again after the user changed the workflow.",
    schema: { type: "object", properties: {} },
  },
  {
    name: ADD_NODE_TOOL,
    description:
      "Adds a node at the end of the list (it gets the next number). A text node has a prompt, and may name an account and a model together. A decision node has a question and at least two options. Connect it with add_connection.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["text", "decision"] },
        ...nodeFields,
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              to: {
                type: "integer",
                description:
                  "The number of the node that this option leads to. Every option needs one.",
              },
            },
            required: ["label", "to"],
          },
          description: "A decision node: its options, at least two. Each option has a connection.",
        },
        after: {
          type: "integer",
          description:
            "The number of a node whose output goes to the new node. For a decision node, name the option in afterOption.",
        },
        afterOption: { type: "string", description: "The option of the node in after." },
      },
      required: ["kind", "name"],
    },
  },
  {
    name: EDIT_NODE_TOOL,
    description:
      "Changes fields of one node. A field that you leave out stays. To clear a field, name it in clear: prompt, question, effort, or model (model clears the account, the model and the reasoning level together). You cannot set a permission level, and you cannot move a node to another account.",
    schema: {
      type: "object",
      properties: {
        node,
        ...nodeFields,
        clear: {
          type: "array",
          items: { type: "string", enum: ["prompt", "question", "effort", "model"] },
        },
      },
      required: ["node"],
    },
  },
  {
    name: REMOVE_NODE_TOOL,
    description:
      "Removes a node with its connections. The later nodes get a lower number. The user can restore the earlier graph from its version.",
    schema: { type: "object", properties: { node }, required: ["node"] },
  },
  {
    name: ADD_CONNECTION_TOOL,
    description:
      "Connects the output of one node to the input of another. A connection that leaves a decision node names the option.",
    schema: {
      type: "object",
      properties: {
        from: node,
        to: node,
        option: { type: "string", description: "The option of the decision node." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: REMOVE_CONNECTION_TOOL,
    description: "Removes the connection between two nodes. Name the option for a decision node.",
    schema: {
      type: "object",
      properties: { from: node, to: node, option: optionText },
      required: ["from", "to"],
    },
  },
  {
    name: ADD_OPTION_TOOL,
    description:
      "Adds an option to a decision node, with its connection to the node in 'to'. An option with no connection does not pass the check.",
    schema: {
      type: "object",
      properties: {
        node,
        option: optionText,
        to: { type: "integer", description: "The number of the node that the option leads to." },
      },
      required: ["node", "option", "to"],
    },
  },
  {
    name: RENAME_OPTION_TOOL,
    description: "Gives an option of a decision node a new label.",
    schema: {
      type: "object",
      properties: { node, option: optionText, label: { type: "string" } },
      required: ["node", "option", "label"],
    },
  },
  {
    name: REMOVE_OPTION_TOOL,
    description:
      "Removes an option of a decision node with its connection. A decision node keeps at least two options.",
    schema: {
      type: "object",
      properties: { node, option: optionText },
      required: ["node", "option"],
    },
  },
  {
    name: START_RUN_TOOL,
    description:
      "Starts a run of this workflow from its start. Use it only when the user asks for a run. You start at most one run in a turn. It is refused at the permission level Read only, and while a run works or waits.",
    schema: {
      type: "object",
      properties: {
        trigger: { type: "string", description: "The text for {{trigger}}. Optional." },
        fromNode: {
          type: "integer",
          description: "A node to start from. Starting from a node is not built yet.",
        },
      },
    },
  },
  {
    name: STOP_RUN_TOOL,
    description:
      "Stops a run of this workflow that works or waits. Leave out the run when one run works or waits.",
    schema: {
      type: "object",
      properties: { run: { type: "string", description: "The id of the run." } },
    },
  },
  {
    name: READ_RUN_TOOL,
    description:
      "Reads the state of a run of this workflow: the state of each node, which node works, why a node waits, why the run stopped, and the result of each node that has ended. Leave out the run for the run that works or waits, or the last run.",
    schema: {
      type: "object",
      properties: { run: { type: "string", description: "The id of the run." } },
    },
  },
  {
    name: READ_RESULT_TOOL,
    description:
      "Reads the result of one node that has ended in a run. A node that has not ended has no result to read.",
    schema: {
      type: "object",
      properties: { node, run: { type: "string", description: "The id of the run." } },
      required: ["node"],
    },
  },
]

export const isAssistantTool = (name: string) => ASSISTANT_TOOL_DEFS.some((t) => t.name === name)

/** The tools that change the workflow or start a run: they need a level that allows them. */
const CHANGING = new Set([
  ADD_NODE_TOOL,
  EDIT_NODE_TOOL,
  REMOVE_NODE_TOOL,
  ADD_CONNECTION_TOOL,
  REMOVE_CONNECTION_TOOL,
  ADD_OPTION_TOOL,
  RENAME_OPTION_TOOL,
  REMOVE_OPTION_TOOL,
])

// --- the context and the result -------------------------------------------------------------

export interface AssistantContext {
  readonly workflowId: string
  readonly level: PermissionLevel
  readonly outside: OutsideSource | null
  readonly program: boolean
  readonly turn: AssistantTurn
  /** Asks the user before a guarded step in a turn that holds outside content. Rejects at Stop. */
  readonly ask?: (step: "change" | "run", summary: string) => Promise<CardReply>
}

export interface AssistantResult {
  readonly outcome: ToolOutcome
  /** The guarded step: how it ended, for the action log. */
  readonly guarded?: {
    readonly kind: "change" | "run"
    readonly decidedBy: "level" | "user"
    readonly result: "ran" | "refused" | "stopped"
    readonly device: string | null
    readonly target: string
  }
  /** Outside content that the result holds: the turn holds it from now on (spec 007). */
  readonly outside?: { readonly source: OutsideSource | null; readonly program: boolean }
}

const refused = (text: string): AssistantResult => ({
  outcome: { output: text, failed: true },
})

const parseArgs = (call: ToolCall): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(call.input || "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const whole = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

// --- the graph, as the tools change it ------------------------------------------------------

type Build = { ok: true; graph: WorkflowGraph; done: string } | { ok: false; text: string }
const fail = (text: string): Build => ({ ok: false, text })

const find = (graph: WorkflowGraph, number: unknown): WorkflowNode | string => {
  const n = whole(number)
  if (n === null) return 'Give "node" as the number of a node.'
  return graph.nodes.find((x) => x.number === n) ?? `Node ${n} does not exist.`
}

const renumbered = (nodes: readonly WorkflowNode[]): WorkflowNode[] =>
  nodes.map((n, i) => ({ ...n, number: i + 1 }))

const replaceNode = (graph: WorkflowGraph, next: WorkflowNode): WorkflowGraph => ({
  ...graph,
  nodes: graph.nodes.map((n) => (n.id === next.id ? next : n)),
})

/** The rules of the form of a graph that every change must keep (spec 010, "Decision node rules"). */
export const shapeFault = (graph: WorkflowGraph): string | null => {
  if (graph.nodes.length > NODES_MAX) return `A workflow has at most ${NODES_MAX} nodes.`
  const ids = new Map(graph.nodes.map((n) => [n.id, n]))
  for (const n of graph.nodes) {
    if (n.name.trim() === "") return `Node ${n.number} has no name.`
    if (!(n.threshold >= 0 && n.threshold <= 1))
      return `The threshold of node ${n.number} must be between 0 and 1.`
    if (n.kind === "text" && n.options.length > 0)
      return `A text node has no options (node ${n.number}).`
    if (n.kind === "decision") {
      const labels = n.options.map((o) => o.label.trim())
      if (labels.length < OPTIONS_MIN)
        return `A decision node needs at least ${OPTIONS_MIN} options (node ${n.number}).`
      if (labels.some((l) => l === "") || new Set(labels).size !== labels.length)
        return `The options of node ${n.number} must be different and have a label.`
      if (n.accountId || n.model || n.effort)
        return `A decision node has no account, model or reasoning level (node ${n.number}).`
    }
  }
  const seen = new Set<string>()
  for (const c of graph.connections) {
    const from = ids.get(c.from)
    const to = ids.get(c.to)
    if (!from || !to) return "A connection names a node that does not exist."
    if (from.id === to.id) return `A connection joins node ${from.number} to itself.`
    if (from.kind === "decision") {
      if (!from.options.some((o) => o.id === c.optionId))
        return `A connection of the decision node ${from.number} must name one of its options.`
    } else if (c.optionId !== null) return `Node ${from.number} is a text node and has no options.`
    const key = c.optionId ?? `${c.from}|${c.to}`
    if (seen.has(key)) return `Node ${from.number} has this connection already.`
    seen.add(key)
  }
  return null
}

const secretFault = (graph: WorkflowGraph): string | null =>
  graph.nodes
    .flatMap((n) => [n.name, n.prompt, n.question, ...n.options.map((o) => o.label)])
    .some((t) => looksLikeSecret(t))
    ? "The text looks like a secret. Leave the secret out of the change."
    : null

const optionOf = (n: WorkflowNode, label: unknown) => {
  const want = typeof label === "string" ? label.trim() : ""
  return n.options.find((o) => o.label === want)
}

const addNode = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const kind = a.kind
  if (kind !== "text" && kind !== "decision") return fail('"kind" is "text" or "decision".')
  const name = (text(a.name) ?? "").trim()
  if (name === "") return fail("The node needs a name.")
  if (graph.nodes.length >= NODES_MAX)
    return fail(`A workflow has at most ${NODES_MAX} nodes. Remove a node first.`)
  const wanted: { label: string; to: number | null }[] = []
  for (const o of Array.isArray(a.options) ? a.options : []) {
    if (typeof o === "string") wanted.push({ label: o.trim(), to: null })
    else if (typeof o === "object" && o !== null)
      wanted.push({
        label: (text((o as Record<string, unknown>).label) ?? "").trim(),
        to: whole((o as Record<string, unknown>).to),
      })
  }
  const options = wanted.map((o) => o.label)
  const threshold = typeof a.threshold === "number" ? a.threshold : THRESHOLD_DEFAULT
  const next: WorkflowNode = {
    id: randomUUID(),
    number: graph.nodes.length + 1,
    kind,
    name,
    prompt: kind === "text" ? (text(a.prompt) ?? "") : "",
    accountId: kind === "text" ? (text(a.accountId) ?? null) : null,
    model: kind === "text" ? (text(a.model) ?? null) : null,
    effort: kind === "text" ? (text(a.effort) ?? null) : null,
    permission: null,
    continueOnFailure: a.continueOnFailure === true,
    question: kind === "decision" ? (text(a.question) ?? "") : "",
    threshold,
    options: kind === "decision" ? options.map((label) => ({ id: randomUUID(), label })) : [],
    x: graph.nodes.reduce((m, n) => Math.max(m, n.x), 0) + (graph.nodes.length > 0 ? 260 : 0),
    y: 0,
  }
  if (kind === "text" && options.length > 0) return fail("A text node has no options.")
  if (kind === "decision" && (a.prompt || a.accountId || a.model || a.effort))
    return fail("A decision node has no prompt, account, model or reasoning level.")
  // The connections that the call asks for are part of the same change (spec 010: a decision
  // node needs a connection for each option when it saves).
  const links: WorkflowConnection[] = []
  for (const [i, o] of wanted.entries()) {
    if (o.to === null) continue
    const target = graph.nodes.find((x) => x.number === o.to)
    if (!target) return fail(`The option "${o.label}" leads to node ${o.to}, which does not exist.`)
    links.push({
      id: randomUUID(),
      from: next.id,
      to: target.id,
      optionId: next.options[i]?.id ?? null,
    })
  }
  if (a.after !== undefined && a.after !== null) {
    const before = find(graph, a.after)
    if (typeof before === "string") return fail(before)
    let optionId: string | null = null
    if (before.kind === "decision") {
      const option = optionOf(before, a.afterOption)
      if (!option) return fail(`Name one option of node ${before.number} in "afterOption".`)
      optionId = option.id
    }
    links.push({ id: randomUUID(), from: before.id, to: next.id, optionId })
  }
  return {
    ok: true,
    graph: {
      nodes: [...graph.nodes, next],
      connections: [...graph.connections, ...links],
    },
    done: `Node ${next.number} "${name}" was added${links.length > 0 ? ` with ${links.length} connection${links.length === 1 ? "" : "s"}` : ""}.`,
  }
}

const CLEARABLE = new Set(["prompt", "question", "effort", "model"])

const editNode = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const found = find(graph, a.node)
  if (typeof found === "string") return fail(found)
  const clear = Array.isArray(a.clear)
    ? a.clear.filter((x): x is string => typeof x === "string")
    : []
  if (clear.some((c) => !CLEARABLE.has(c)))
    return fail('"clear" may name: prompt, question, effort, model.')
  const decision = found.kind === "decision"
  if (decision) {
    if (
      a.prompt !== undefined ||
      a.accountId !== undefined ||
      a.model !== undefined ||
      a.effort !== undefined ||
      a.continueOnFailure !== undefined
    )
      return fail(
        `Node ${found.number} is a decision node. It has a name, a question, a threshold and options only.`,
      )
    if (clear.some((c) => c !== "question"))
      return fail(
        `Node ${found.number} is a decision node. It has a question to clear, nothing else.`,
      )
  } else if (a.question !== undefined || a.threshold !== undefined || clear.includes("question")) {
    return fail(`Node ${found.number} is a text node. It has no question and no threshold.`)
  }
  if (a.accountId !== undefined && text(a.accountId) === undefined)
    return fail('"accountId" is a text.')
  if (found.accountId !== null && a.accountId !== undefined && a.accountId !== found.accountId)
    return fail(
      `Node ${found.number} keeps its account. You can change its model to one that the account offers. To use another account, add a new node.`,
    )
  let next: WorkflowNode = { ...found }
  const name = text(a.name)
  if (name !== undefined) next = { ...next, name: name.trim() }
  if (text(a.prompt) !== undefined) next = { ...next, prompt: a.prompt as string }
  if (text(a.accountId) !== undefined) next = { ...next, accountId: a.accountId as string }
  if (text(a.model) !== undefined) next = { ...next, model: a.model as string }
  if (text(a.effort) !== undefined) next = { ...next, effort: a.effort as string }
  if (typeof a.continueOnFailure === "boolean")
    next = { ...next, continueOnFailure: a.continueOnFailure }
  if (text(a.question) !== undefined) next = { ...next, question: a.question as string }
  if (a.threshold !== undefined) {
    if (typeof a.threshold !== "number") return fail('"threshold" is a number from 0 to 1.')
    next = { ...next, threshold: a.threshold }
  }
  for (const c of clear) {
    if (c === "prompt") next = { ...next, prompt: "" }
    else if (c === "question") next = { ...next, question: "" }
    else if (c === "effort") next = { ...next, effort: null }
    else next = { ...next, accountId: null, model: null, effort: null }
  }
  if (JSON.stringify(next) === JSON.stringify(found))
    return fail("Nothing changes: the node has these values already.")
  return {
    ok: true,
    graph: replaceNode(graph, next),
    done: `Node ${found.number} "${next.name}" was changed.`,
  }
}

const removeNode = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const found = find(graph, a.node)
  if (typeof found === "string") return fail(found)
  return {
    ok: true,
    graph: {
      nodes: renumbered(graph.nodes.filter((n) => n.id !== found.id)),
      connections: graph.connections.filter((c) => c.from !== found.id && c.to !== found.id),
    },
    done: `Node ${found.number} "${found.name}" was removed with its connections. The later nodes have a lower number now.`,
  }
}

const endsOf = (graph: WorkflowGraph, a: Record<string, unknown>) => {
  const from = find(graph, a.from)
  const to = find(graph, a.to)
  if (typeof from === "string") return from
  if (typeof to === "string") return to
  return { from, to }
}

const addConnection = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const ends = endsOf(graph, a)
  if (typeof ends === "string") return fail(ends)
  let optionId: string | null = null
  if (ends.from.kind === "decision") {
    const option = optionOf(ends.from, a.option)
    if (!option)
      return fail(
        `Name one option of node ${ends.from.number}: ${ends.from.options.map((o) => `"${o.label}"`).join(", ")}.`,
      )
    optionId = option.id
  } else if (a.option !== undefined && a.option !== "")
    return fail(`Node ${ends.from.number} is a text node and has no options.`)
  return {
    ok: true,
    graph: {
      ...graph,
      connections: [
        ...graph.connections,
        { id: randomUUID(), from: ends.from.id, to: ends.to.id, optionId },
      ],
    },
    done: `Node ${ends.from.number} is connected to node ${ends.to.number}.`,
  }
}

const removeConnection = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const ends = endsOf(graph, a)
  if (typeof ends === "string") return fail(ends)
  let optionId: string | null = null
  if (ends.from.kind === "decision") {
    const option = optionOf(ends.from, a.option)
    if (!option)
      return fail(`Name the option of node ${ends.from.number} that the connection leaves.`)
    optionId = option.id
  }
  const hit = graph.connections.find(
    (c) => c.from === ends.from.id && c.to === ends.to.id && c.optionId === optionId,
  )
  if (!hit)
    return fail(`Node ${ends.from.number} has no connection to node ${ends.to.number} like this.`)
  return {
    ok: true,
    graph: { ...graph, connections: graph.connections.filter((c) => c.id !== hit.id) },
    done: `The connection from node ${ends.from.number} to node ${ends.to.number} was removed.`,
  }
}

const decisionOf = (graph: WorkflowGraph, n: unknown): WorkflowNode | string => {
  const found = find(graph, n)
  if (typeof found === "string") return found
  return found.kind === "decision"
    ? found
    : `Node ${found.number} is a text node and has no options.`
}

const addOption = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const found = decisionOf(graph, a.node)
  if (typeof found === "string") return fail(found)
  const label = (text(a.option) ?? "").trim()
  if (label === "") return fail("The option needs a label.")
  if (optionOf(found, label)) return fail(`Node ${found.number} has the option "${label}" already.`)
  const target = find(graph, a.to)
  if (typeof target === "string") return fail(target)
  const option = { id: randomUUID(), label }
  return {
    ok: true,
    graph: {
      nodes: graph.nodes.map((n) =>
        n.id === found.id ? { ...found, options: [...found.options, option] } : n,
      ),
      connections: [
        ...graph.connections,
        { id: randomUUID(), from: found.id, to: target.id, optionId: option.id },
      ],
    },
    done: `The option "${label}" was added to node ${found.number}, with a connection to node ${target.number}.`,
  }
}

const renameOption = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const found = decisionOf(graph, a.node)
  if (typeof found === "string") return fail(found)
  const option = optionOf(found, a.option)
  if (!option) return fail(`Node ${found.number} has no option "${text(a.option) ?? ""}".`)
  const label = (text(a.label) ?? "").trim()
  if (label === "") return fail("The option needs a label.")
  return {
    ok: true,
    graph: replaceNode(graph, {
      ...found,
      options: found.options.map((o) => (o.id === option.id ? { ...o, label } : o)),
    }),
    done: `The option "${option.label}" of node ${found.number} is now "${label}".`,
  }
}

const removeOption = (graph: WorkflowGraph, a: Record<string, unknown>): Build => {
  const found = decisionOf(graph, a.node)
  if (typeof found === "string") return fail(found)
  const option = optionOf(found, a.option)
  if (!option) return fail(`Node ${found.number} has no option "${text(a.option) ?? ""}".`)
  return {
    ok: true,
    graph: {
      nodes: graph.nodes.map((n) =>
        n.id === found.id ? { ...n, options: n.options.filter((o) => o.id !== option.id) } : n,
      ),
      connections: graph.connections.filter((c) => c.optionId !== option.id),
    },
    done: `The option "${option.label}" was removed from node ${found.number} with its connection.`,
  }
}

const BUILDERS: Record<string, (graph: WorkflowGraph, a: Record<string, unknown>) => Build> = {
  [ADD_NODE_TOOL]: addNode,
  [EDIT_NODE_TOOL]: editNode,
  [REMOVE_NODE_TOOL]: removeNode,
  [ADD_CONNECTION_TOOL]: addConnection,
  [REMOVE_CONNECTION_TOOL]: removeConnection,
  [ADD_OPTION_TOOL]: addOption,
  [RENAME_OPTION_TOOL]: renameOption,
  [REMOVE_OPTION_TOOL]: removeOption,
}

/** A problem of the check in plain words, with node numbers, for the chat to tell the user. */
const problemText = (problem: CheckProblem, graph: WorkflowGraph): string => {
  const number = (id: string) => graph.nodes.find((n) => n.id === id)?.number ?? "?"
  const numbers = (ids: readonly string[]) => ids.map(number).join(", ")
  switch (problem.code) {
    case "option_unconnected": {
      const node = graph.nodes.find((n) => n.id === problem.nodeId)
      const option = node?.options.find((o) => o.id === problem.optionId)
      return `the option "${escapeOutside(option?.label ?? "?")}" of node ${number(problem.nodeId)} has no connection. Give every option a connection in the same call`
    }
    case "decision_options":
      return `the decision node ${number(problem.nodeId)} has fewer than ${OPTIONS_MIN} options`
    case "nodes_full":
      return `a workflow has at most ${NODES_MAX} nodes`
    case "deadlock":
      return `nodes ${numbers(problem.nodeIds)} wait for each other, so a run cannot end (a deadlock)`
    case "never_runs":
      return `node${problem.nodeIds.length === 1 ? "" : "s"} ${numbers(problem.nodeIds)} would never run`
  }
}

// --- the plain words of a failure of the app -------------------------------------------------

const APP_ERRORS: Record<string, string> = {
  workflow_running: "A run works or waits, so the graph cannot change now.",
  workflow_not_found: "This workflow does not exist any more.",
  node_permission_looser: "A node cannot have a looser permission level than its workflow.",
  run_empty: "The workflow has no node, so a run cannot start.",
  run_loop: "The connections make a loop of nodes, so a run cannot start.",
  run_check_problem: "The check found a problem in the graph, so a run cannot start.",
  run_queue_full: "Too many runs wait.",
  run_not_found: "This run does not exist.",
}
const appError = (error: AppError): string =>
  APP_ERRORS[error.code] ?? `The app refused it (${error.code}).`

// --- the tools ------------------------------------------------------------------------------

export interface AssistantDeps {
  readonly workflows: WorkflowsService
  readonly runs: RunsService
  readonly facts: RunFactsService
  readonly check: WorkflowCheckService
  readonly providers: Pick<ProvidersService, "accounts" | "models">
}

/** Runs a service call and gives the failure of the app as a value, not as a throw. */
const attempt = <A>(effect: Effect.Effect<A, AppError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      }),
    ),
  )

const say = (output: string, extra: Partial<AssistantResult> = {}): AssistantResult => ({
  outcome: { output: redactSecrets(output), failed: false },
  ...extra,
})

export const makeAssistantTools = (deps: AssistantDeps) => {
  const { workflows, runs, facts, check, providers } = deps
  const modelsOffered = modelsOfferedBy(providers)
  const graphOf = (id: string) => Effect.runPromise(workflows.graph(id))

  const staleText =
    "Refused: the workflow changed after you read it (the user changed it). Nothing was saved. Call read_workflow, read the graph again, tell the user that it changed, and make the change again only if it still fits."

  // --- reads ---------------------------------------------------------------------------------

  const listWorkflows = async (ctx: AssistantContext): Promise<AssistantResult> => {
    const own = await Effect.runPromise(workflows.get(ctx.workflowId))
    const all = await Effect.runPromise(workflows.list(own.serverId))
    const lines = all.map((w) => {
      const last = w.lastRun ? `last run: ${w.lastRun.state}` : "never run"
      return `- "${escapeOutside(w.name)}"${w.id === ctx.workflowId ? " (this workflow)" : ""}: ${w.nodeCount} node${w.nodeCount === 1 ? "" : "s"}, ${w.running ? "a run works or waits now" : last}`
    })
    return say(
      [
        `${all.length} workflow${all.length === 1 ? "" : "s"} on this server. You can read and change the graph of this workflow only.`,
        ...lines,
      ].join("\n"),
    )
  }

  const readWorkflow = async (ctx: AssistantContext): Promise<AssistantResult> => {
    const detail = await Effect.runPromise(workflows.get(ctx.workflowId))
    ctx.turn.seen = graphFingerprint(detail.graph)
    return say(
      [
        `Workflow "${escapeOutside(detail.name)}". ${detail.running ? "A run works or waits now: the graph cannot change until it ends." : "No run works now."}`,
        graphText(detail.graph),
        "Triggers: none. A schedule or a web hook is set on the canvas by the user, and you cannot set one.",
      ].join("\n"),
    )
  }

  /** The run that a call names, or the run that works, or the last run (a run of this workflow only). */
  const pickRun = async (ctx: AssistantContext, named: unknown) => {
    const all = await Effect.runPromise(facts.runs(ctx.workflowId))
    if (all.length === 0) return { text: "This workflow has never run. Tell the user: No run yet." }
    const want = typeof named === "string" ? named.trim() : ""
    if (want !== "") {
      const hit = all.find((r) => r.id === want || r.id.startsWith(want))
      return hit ? { run: hit } : { text: "No run like this. It is not a run of this workflow." }
    }
    const active = all.filter((r) => r.active)
    if (active.length > 1)
      return {
        text: `More than one run works or waits: ${active.map((r) => r.id.slice(0, 8)).join(", ")}. Ask the user which run.`,
      }
    return { run: active[0] ?? all[0] }
  }

  const marksOf = (
    nodes: readonly { outside: OutsideSource | null; program: boolean; result: string | null }[],
  ) => {
    let source: OutsideSource | null = null
    let program = false
    for (const n of nodes) {
      if (n.result === null || n.result === "") continue
      source ??= n.outside
      program ||= n.program || (n.outside !== null && carriesProgramMark(n.outside))
    }
    return source !== null || program ? { source, program } : undefined
  }

  const readRun = async (ctx: AssistantContext, a: Record<string, unknown>) => {
    const picked = await pickRun(ctx, a.run)
    if (!picked.run) return say(picked.text ?? "")
    const outside = marksOf(picked.run.nodes)
    return say(runFactsText([picked.run]), outside ? { outside } : {})
  }

  const readResult = async (ctx: AssistantContext, a: Record<string, unknown>) => {
    const number = whole(a.node)
    if (number === null) return refused('Give "node" as the number of a node.')
    const picked = await pickRun(ctx, a.run)
    if (!picked.run) return say(picked.text ?? "")
    const n = picked.run.nodes.find((x) => x.number === number)
    if (!n) return refused(`Node ${number} does not exist.`)
    const ended = n.state === "done" || n.state === "failed" || n.state === "cancelled"
    if (!ended)
      return say(
        `Node ${number} "${escapeOutside(n.name)}" has not ended in this run (${n.state === "not_reached" ? "not reached" : n.state}). It has no result to read. Tell the user so.`,
      )
    const outside = marksOf([n])
    return say(nodeLines(n).join("\n"), outside ? { outside } : {})
  }

  // --- the guard ------------------------------------------------------------------------------

  /** Asks the user when the turn holds outside content (spec 007). Null means: go on. */
  const guard = async (
    ctx: AssistantContext,
    kind: "change" | "run",
    target: string,
    always: boolean,
  ): Promise<{ stop?: AssistantResult; guarded?: AssistantResult["guarded"] }> => {
    const verdict = always
      ? ctx.outside !== null || ctx.program
        ? "ask"
        : "run"
      : guardVerdict({ level: ctx.level, outside: ctx.outside !== null, program: ctx.program })
    if (verdict !== "ask") return {}
    // A turn with no way to ask (no window) never runs a guarded step.
    const note = (
      result: "refused" | "stopped",
      decidedBy: "level" | "user",
      device: string | null,
    ) => ({
      kind,
      decidedBy,
      result,
      device,
      target,
    })
    if (!ctx.ask)
      return {
        stop: refused(
          "Refused: this turn holds outside content and no user can answer. Nothing was saved.",
        ),
        guarded: note("refused", "level", null),
      }
    let reply: CardReply
    try {
      reply = await ctx.ask(kind, target)
    } catch {
      return {
        stop: refused("Nothing was done: the turn was stopped."),
        guarded: note("stopped", "user", null),
      }
    }
    if (reply.answer === "deny")
      return {
        stop: {
          outcome: {
            output: "Nothing was done: the user refused. Tell the user that nothing changed.",
            failed: false,
          },
        },
        guarded: note("refused", "user", reply.device ?? null),
      }
    return {
      guarded: { kind, decidedBy: "user", result: "ran", device: reply.device ?? null, target },
    }
  }

  // --- changes --------------------------------------------------------------------------------

  const change = async (ctx: AssistantContext, call: ToolCall): Promise<AssistantResult> => {
    const build = BUILDERS[call.name]
    if (!build) return refused(`Unknown tool: ${call.name}`)
    const level = ctx.level === "read_only"
    const target = `${call.name}: ${redactSecrets(call.input).slice(0, 160)}`
    if (level)
      return {
        outcome: {
          output:
            "Refused: the permission level of this workflow is Read only. Nothing was saved. Tell the user.",
          failed: true,
          refused: "read_only",
          notRun: true,
        },
        guarded: { kind: "change", decidedBy: "level", result: "refused", device: null, target },
      }
    const current = await graphOf(ctx.workflowId)
    if (graphFingerprint(current) !== ctx.turn.seen) return refused(staleText)
    if (runs.active(ctx.workflowId))
      return refused(
        "Refused: a run works or waits, so the graph cannot change now. Nothing was saved.",
      )
    const built = build(current, parseArgs(call))
    if (!built.ok) return refused(`Nothing was saved: ${built.text}`)
    const fault = shapeFault(built.graph) ?? secretFault(built.graph)
    if (fault) return refused(`Nothing was saved: ${fault}`)
    const bad = await Effect.runPromise(modelsOffered(current, built.graph))
    if (bad) return refused(`Nothing was saved: ${bad} Tell the user why.`)
    // Every change passes the check before it saves (spec 010, "Flows", item 3).
    const outcome = await Effect.runPromise(check.checkGraph(built.graph))
    if (outcome.state === "problem")
      return refused(
        `Nothing was saved: the check found a problem in the new graph: ${outcome.problems
          .map((p) => problemText(p, built.graph))
          .slice(0, 3)
          .join("; ")}. Tell the user what the problem is.`,
      )
    if (outcome.state !== "passed")
      return refused(
        "Nothing was saved: the check could not finish for the new graph, so the change does not save.",
      )
    const gate = await guard(ctx, "change", target, false)
    if (gate.stop) return { ...gate.stop, ...(gate.guarded ? { guarded: gate.guarded } : {}) }
    // The user may have changed the workflow while the check worked or the card waited.
    if (graphFingerprint(await graphOf(ctx.workflowId)) !== graphFingerprint(current))
      return refused(staleText)
    const applied = await attempt(workflows.applyGraph(ctx.workflowId, built.graph, "chat"))
    if (!applied.ok) return refused(`Nothing was saved: ${appError(applied.error)}`)
    const saved = await graphOf(ctx.workflowId)
    ctx.turn.seen = graphFingerprint(saved)
    return {
      ...say(
        `${built.done} The change is saved, and the earlier graph is kept as a version. Tell the user that you changed the workflow and that the earlier graph is a version.\n${graphText(saved)}`,
      ),
      guarded: gate.guarded ?? {
        kind: "change",
        decidedBy: "level",
        result: "ran",
        device: null,
        target,
      },
    }
  }

  // --- runs -----------------------------------------------------------------------------------

  const startRun = async (
    ctx: AssistantContext,
    a: Record<string, unknown>,
  ): Promise<AssistantResult> => {
    const target = `start_run${typeof a.trigger === "string" && a.trigger !== "" ? `: ${redactSecrets(a.trigger).slice(0, 160)}` : ""}`
    if (ctx.level === "read_only")
      return {
        outcome: {
          output:
            "Refused: the permission level of this workflow is Read only, and it refuses to start a run. Tell the user.",
          failed: true,
          refused: "read_only",
          notRun: true,
        },
        guarded: { kind: "run", decidedBy: "level", result: "refused", device: null, target },
      }
    if (ctx.turn.runStarted)
      return refused(
        "Refused: you started a run in this turn already. A turn starts at most one run.",
      )
    if (a.fromNode !== undefined && a.fromNode !== null)
      return refused(
        "Not started: a run from a node is not built yet. Start the run from its start, or tell the user.",
      )
    if (runs.active(ctx.workflowId))
      return refused("Not started: a run works or waits. Wait for it to end, or stop it first.")
    const trigger = typeof a.trigger === "string" ? a.trigger : ""
    if (trigger.length > 2000)
      return refused("Not started: the text for the trigger is at most 2000 characters.")
    // The spec does not list the start of a run as a guarded step. A turn that holds outside
    // content asks at every level, also at "Full access" (docs/spec-questions.md, 010).
    const gate = await guard(ctx, "run", target, true)
    if (gate.stop) return { ...gate.stop, ...(gate.guarded ? { guarded: gate.guarded } : {}) }
    ctx.turn.runStarted = true
    const started = await attempt(
      runs.start({ workflowId: ctx.workflowId, ...(trigger ? { trigger } : {}) }, "chat"),
    )
    if (!started.ok) {
      ctx.turn.runStarted = false
      return refused(`Not started: ${appError(started.error)}`)
    }
    const run = started.value
    return {
      ...say(
        `Run ${run.id.slice(0, 8)} (id ${run.id}) started. State: ${run.state}. Tell the user that one run started. To tell how far it has gone, call read_run.`,
      ),
      guarded: gate.guarded ?? {
        kind: "run",
        decidedBy: "level",
        result: "ran",
        device: null,
        target,
      },
    }
  }

  const stopRun = async (
    ctx: AssistantContext,
    a: Record<string, unknown>,
  ): Promise<AssistantResult> => {
    const all = (await Effect.runPromise(facts.runs(ctx.workflowId))).filter((r) => r.active)
    if (all.length === 0) return say("No run works or waits. Nothing was stopped. Tell the user.")
    const want = typeof a.run === "string" ? a.run.trim() : ""
    const hit =
      want === ""
        ? all.length === 1
          ? all[0]
          : undefined
        : all.find((r) => r.id === want || r.id.startsWith(want))
    if (!hit)
      return refused(
        want === ""
          ? `More than one run works or waits: ${all.map((r) => r.id.slice(0, 8)).join(", ")}. Ask the user which run.`
          : "No run like this works or waits in this workflow.",
      )
    const stopped = await attempt(runs.stop(hit.id))
    if (!stopped.ok) return refused(`Not stopped: ${appError(stopped.error)}`)
    return say(`Run ${hit.id.slice(0, 8)} was stopped. Tell the user that the run was stopped.`)
  }

  // --- the entry ------------------------------------------------------------------------------

  const execute = async (ctx: AssistantContext, call: ToolCall): Promise<AssistantResult> => {
    const blocked = assistantGate(ctx.turn.origin)
    if (blocked) return refused(blocked)
    const a = parseArgs(call)
    switch (call.name) {
      case LIST_WORKFLOWS_TOOL:
        return listWorkflows(ctx)
      case READ_WORKFLOW_TOOL:
        return readWorkflow(ctx)
      case READ_RUN_TOOL:
        return readRun(ctx, a)
      case READ_RESULT_TOOL:
        return readResult(ctx, a)
      case START_RUN_TOOL:
        return startRun(ctx, a)
      case STOP_RUN_TOOL:
        return stopRun(ctx, a)
      default:
        return CHANGING.has(call.name) ? change(ctx, call) : refused(`Unknown tool: ${call.name}`)
    }
  }

  return { defs: ASSISTANT_TOOL_DEFS, execute }
}

export type AssistantTools = ReturnType<typeof makeAssistantTools>
