import {
  BACKUP_REFUSED_TEXT,
  type GraphProposalInput,
  guardVerdict,
  namesBackup,
  type OutsideSource,
  type PermissionLevel,
  type ProposalKind,
  type ProposalSource,
} from "@robot/shared"
import { Effect } from "effect"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall, ToolDef } from "../providers/chat.ts"
import type { CardReply } from "./Cards.ts"
import type { ProposalsService } from "./Proposals.ts"

/**
 * The tools with which the responsible document proposes a change (spec 002, "Self-improvement";
 * spec 010, "Assistant"). They are propose-only: no tool changes the document, a prompt, the graph
 * or the memory. A call makes a row that waits for the user, who answers on its card. The tools
 * have no way to accept, reject or undo a proposal.
 */

export const PROPOSE_DOCUMENT_TOOL = "propose_document_change"
export const PROPOSE_PROMPT_TOOL = "propose_prompt_change"
export const PROPOSE_GRAPH_TOOL = "propose_graph_change"

const reason = {
  type: "string",
  description:
    "One line of at most 200 characters: what in the work led to this change. The user reads it on the card.",
}

const graphNode = {
  type: "object",
  properties: {
    keep: {
      type: "integer",
      description:
        "The number that this node has now. The node keeps its place, its permission level and every field that you leave out. Leave out for a new node.",
    },
    kind: { type: "string", enum: ["text", "decision", "approval"] },
    name: { type: "string" },
    prompt: { type: "string", description: "A text node: its prompt." },
    accountId: { type: "string", description: "A text node: the id of a connected account." },
    model: { type: "string", description: "A text node: a model that the account offers." },
    effort: { type: "string", description: "A text node: a reasoning level of the model." },
    continueOnFailure: { type: "boolean" },
    question: { type: "string", description: "A decision or approval node: the question." },
    threshold: { type: "number", description: "A decision node: from 0 to 1." },
    options: {
      type: "array",
      items: { type: "string" },
      description: "A decision node: its options, at least two.",
    },
  },
  required: ["kind", "name"],
}

export const PROPOSE_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: PROPOSE_DOCUMENT_TOOL,
    description:
      "Propose a new text for the responsible document of this workflow. Give the whole new text. Nothing changes: the user accepts or rejects the proposal. Change as little as the work needs: the removed and the added words together are at most 2000 characters.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The whole new text of the responsible document." },
        reason,
      },
      required: ["text", "reason"],
    },
  },
  {
    name: PROPOSE_PROMPT_TOOL,
    description:
      "Propose a new prompt for one text node. Give the whole new prompt. Nothing changes: the user accepts or rejects the proposal. The removed and the added words together are at most 2000 characters.",
    schema: {
      type: "object",
      properties: {
        node: { type: "integer", description: "The number of the node." },
        prompt: { type: "string", description: "The whole new prompt of the node." },
        reason,
      },
      required: ["node", "prompt", "reason"],
    },
  },
  {
    name: PROPOSE_GRAPH_TOOL,
    description:
      'Propose a new graph: give the whole list of nodes and the whole list of connections as they should be. Nothing changes: the app checks the new graph, and the user accepts or rejects the proposal. A connection names its nodes by their place in your list of nodes, from 1. A connection that leaves a decision node names the option; one that leaves an approval node names the output ("Approve" or "Reject"). You cannot set a permission level, a folder, a trigger or a schedule.',
    schema: {
      type: "object",
      properties: {
        nodes: { type: "array", items: graphNode },
        connections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "integer", description: "The place of the node, from 1." },
              to: { type: "integer", description: "The place of the node, from 1." },
              option: { type: "string", description: "The option of the decision node." },
              output: {
                type: "string",
                description: 'The output of the approval node: "Approve" or "Reject".',
              },
            },
            required: ["from", "to"],
          },
        },
        reason,
      },
      required: ["nodes", "connections", "reason"],
    },
  },
]

export const isProposeTool = (name: string) => PROPOSE_TOOL_DEFS.some((t) => t.name === name)

export interface ProposeToolContext {
  readonly workflowId: string
  readonly source: ProposalSource
  readonly level: PermissionLevel
  readonly outside: OutsideSource | null
  readonly program: boolean
  /**
   * Asks the user before a prompt change or a graph change in a turn that holds outside content
   * (spec 007, "Guarded steps"). Rejects when the turn stops. Left out after a run: no user is at
   * the screen, and the card of the proposal carries the muted line (spec 002, "Outside content").
   */
  readonly ask?: (summary: string) => Promise<CardReply>
}

export type ProposeEvent =
  | {
      readonly kind: "made"
      readonly proposalId: string
      readonly proposalKind: ProposalKind
      readonly nodeNumber: number | null
    }
  | { readonly kind: "full" }

export interface ProposeToolResult {
  readonly outcome: ToolOutcome
  /** The guarded step that asked: how it ended, for the action log. */
  readonly guarded?: {
    readonly decidedBy: "level" | "user"
    readonly result: "ran" | "refused" | "stopped"
    readonly device: string | null
    readonly target: string
  }
  readonly event?: ProposeEvent
}

const parseArgs = (call: ToolCall): Record<string, unknown> => {
  try {
    const v = JSON.parse(call.input || "{}")
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "")

/** The graph of a call, as a form that `compileGraph` takes. A fault of the form is a refusal. */
const graphInput = (args: Record<string, unknown>): GraphProposalInput | string => {
  if (!Array.isArray(args.nodes) || !Array.isArray(args.connections))
    return 'Give "nodes" and "connections" as lists.'
  const nodes: GraphProposalInput["nodes"][number][] = []
  for (const n of args.nodes) {
    if (typeof n !== "object" || n === null) return "Each node is an object."
    const o = n as Record<string, unknown>
    if (namesBackup(o)) return BACKUP_REFUSED_TEXT
    if (o.kind !== "text" && o.kind !== "decision" && o.kind !== "approval")
      return 'Each node has a "kind": "text", "decision" or "approval".'
    nodes.push({
      ...(typeof o.keep === "number" && Number.isInteger(o.keep) ? { keep: o.keep } : {}),
      kind: o.kind,
      name: str(o.name),
      ...(typeof o.prompt === "string" ? { prompt: o.prompt } : {}),
      ...(typeof o.accountId === "string" ? { accountId: o.accountId } : {}),
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      ...(typeof o.effort === "string" ? { effort: o.effort } : {}),
      ...(typeof o.continueOnFailure === "boolean"
        ? { continueOnFailure: o.continueOnFailure }
        : {}),
      ...(typeof o.question === "string" ? { question: o.question } : {}),
      ...(typeof o.threshold === "number" ? { threshold: o.threshold } : {}),
      ...(Array.isArray(o.options)
        ? { options: o.options.filter((x): x is string => typeof x === "string") }
        : {}),
    })
  }
  const connections: GraphProposalInput["connections"][number][] = []
  for (const c of args.connections) {
    if (typeof c !== "object" || c === null) return "Each connection is an object."
    const o = c as Record<string, unknown>
    if (typeof o.from !== "number" || typeof o.to !== "number")
      return 'Each connection has "from" and "to" as numbers.'
    connections.push({
      from: o.from,
      to: o.to,
      ...(typeof o.option === "string" ? { option: o.option } : {}),
      ...(typeof o.output === "string" ? { output: o.output } : {}),
    })
  }
  return { nodes, connections }
}

export const makeProposeTools = (deps: { readonly proposals: ProposalsService }) => {
  const { proposals } = deps

  const execute = async (ctx: ProposeToolContext, call: ToolCall): Promise<ProposeToolResult> => {
    const args = parseArgs(call)
    let change: Parameters<ProposalsService["propose"]>[0]["change"]
    let summary: string
    if (call.name === PROPOSE_DOCUMENT_TOOL) {
      change = { kind: "document", text: str(args.text) }
      summary = str(args.reason)
    } else if (call.name === PROPOSE_PROMPT_TOOL) {
      if (typeof args.node !== "number" || !Number.isInteger(args.node))
        return {
          outcome: {
            output: 'Nothing was proposed: "node" is the number of a node.',
            failed: true,
          },
        }
      change = { kind: "prompt", node: args.node, prompt: str(args.prompt) }
      summary = str(args.reason)
    } else {
      const graph = graphInput(args)
      if (typeof graph === "string")
        return { outcome: { output: `Nothing was proposed: ${graph}`, failed: true } }
      change = { kind: "graph", graph }
      summary = str(args.reason)
    }

    // A prompt change or a graph change in a turn that holds outside content is a guarded step
    // (spec 007): the user is asked before the proposal is made. A change of the document is
    // always a proposal with no card (spec 007, "Guarded steps").
    let guarded: ProposeToolResult["guarded"]
    if (
      change.kind !== "document" &&
      ctx.ask &&
      guardVerdict({ level: ctx.level, outside: ctx.outside !== null, program: ctx.program }) ===
        "ask"
    ) {
      const target = `${change.kind === "prompt" ? `prompt of node ${change.node}` : "graph"}: ${summary}`
      let reply: CardReply
      try {
        reply = await ctx.ask(target)
      } catch {
        return {
          outcome: { output: "Nothing was proposed: the turn was stopped.", failed: true },
          guarded: { decidedBy: "user", result: "stopped", device: null, target },
        }
      }
      if (reply.answer === "deny")
        return {
          outcome: {
            output:
              "Nothing was proposed: the user refused. Tell the user that no proposal was made.",
            failed: false,
          },
          guarded: { decidedBy: "user", result: "refused", device: reply.device ?? null, target },
        }
      guarded = { decidedBy: "user", result: "ran", device: reply.device ?? null, target }
    }

    const made = await Effect.runPromise(
      proposals.propose({
        workflowId: ctx.workflowId,
        source: ctx.source,
        outside: ctx.outside,
        reason: summary,
        change,
      }),
    )
    if (!made.ok)
      return {
        outcome: { output: `Nothing was proposed: ${made.text}`, failed: true },
        ...(guarded ? { guarded } : {}),
        ...(made.reason === "full" ? { event: { kind: "full" } as const } : {}),
      }
    return {
      outcome: {
        output:
          "The proposal was made. It waits on the page Self-improvement of the workflow, and the user decides. Nothing has changed yet. Tell the user so, in one sentence.",
        failed: false,
      },
      ...(guarded ? { guarded } : {}),
      event: {
        kind: "made",
        proposalId: made.id,
        proposalKind: made.kind,
        nodeNumber: made.nodeNumber,
      },
    }
  }

  return { defs: PROPOSE_TOOL_DEFS, execute }
}

export type ProposeTools = ReturnType<typeof makeProposeTools>
