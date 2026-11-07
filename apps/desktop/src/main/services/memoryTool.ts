import {
  charLength,
  guardVerdict,
  looksLikeSecret,
  MEMORY_TOOL_MAX,
  type OutsideSource,
  type PermissionLevel,
  type ProposalSource,
} from "@robot/shared"
import { Effect } from "effect"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall, ToolDef } from "../providers/chat.ts"
import type { ActionLogService } from "./ActionLog.ts"
import type { CardReply } from "./Cards.ts"
import type { MemoryService } from "./Memory.ts"
import type { ProposalsService } from "./Proposals.ts"

/**
 * The memory tool (spec 008, "Concepts", "Flows" 1 and 5): a text node and the responsible document
 * in the chat save, suggest, search and read facts with it. The app puts no item into a prompt by
 * itself: a node gets an item only when it reads it here.
 *
 * "Ask me first" (the default): the tool makes a proposal, and the user decides. "Save at once": the
 * tool makes an item, and Undo stays. "Save at once" counts only while the switch "Self-improvement"
 * of the workflow is on (spec 002). A save in a turn or a task that holds outside content is a
 * guarded step and asks first (spec 007); a proposal is not memory and asks nothing (spec 008).
 */

export const MEMORY_SEARCH_TOOL = "memory_search"
export const MEMORY_SAVE_TOOL = "memory_save"

export const MEMORY_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: MEMORY_SEARCH_TOOL,
    description:
      "Search the memory of this workflow: short facts that were kept from earlier work. Give a few words to find the facts that relate to your work. With no words you get the newest facts. Read before you start work that may depend on a preference or an earlier decision.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few words. Leave out for the newest facts." },
      },
      required: [],
    },
  },
  {
    name: MEMORY_SAVE_TOOL,
    description: `Keep one lasting fact in the memory of this workflow: a preference, a name or a decision that later work will need. At most ${MEMORY_TOOL_MAX} characters. Never keep a key, a password or a token. Depending on the choice of the user, the fact is saved at once or only suggested, and the user decides.`,
    schema: {
      type: "object",
      properties: { text: { type: "string", description: "The fact, in one or two sentences." } },
      required: ["text"],
    },
  },
]

export const isMemoryTool = (name: string) =>
  name === MEMORY_SEARCH_TOOL || name === MEMORY_SAVE_TOOL

/** What a memory step did, for the muted line of the run view or the chat. */
export type MemoryEvent =
  | { readonly kind: "saved"; readonly text: string; readonly historyId: string }
  | { readonly kind: "suggested"; readonly proposalId: string }
  | { readonly kind: "full" }

export interface MemoryToolContext {
  readonly workflowId: string
  /** The task of a node. Null in the chat and after a run. */
  readonly taskId: string | null
  readonly level: PermissionLevel
  /** The marks of the turn or the task: outside content and the program mark (spec 007). */
  readonly outside: OutsideSource | null
  readonly program: boolean
  /** The run or the message that the proposal names as its source. */
  readonly source: ProposalSource
  /**
   * True when the tool may save at once. False after a run: the turn has no user at the screen, so
   * a fact is a proposal.
   */
  readonly mayPress: boolean
  readonly signal: AbortSignal
  /** Shows an approval card for the save and waits (spec 007). Rejects when the turn stops. */
  readonly ask: (text: string) => Promise<CardReply>
}

export interface MemoryToolResult {
  readonly outcome: ToolOutcome
  readonly event?: MemoryEvent
}

const parse = (call: ToolCall): Record<string, unknown> => {
  try {
    const v = JSON.parse(call.input || "{}")
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const fail = (output: string): MemoryToolResult => ({ outcome: { output, failed: true } })
const ok = (output: string, event?: MemoryEvent): MemoryToolResult => ({
  outcome: { output, failed: false },
  ...(event ? { event } : {}),
})

export const makeMemoryTool = (deps: {
  readonly memory: MemoryService
  readonly proposals: ProposalsService
  readonly actionLog: ActionLogService
}) => {
  const { memory, proposals, actionLog } = deps
  const search = async (ctx: MemoryToolContext, call: ToolCall): Promise<MemoryToolResult> => {
    const query = typeof parse(call).query === "string" ? (parse(call).query as string) : ""
    const found = await Effect.runPromise(memory.search(ctx.workflowId, query))
    if (found.items.length === 0)
      return ok(found.total === 0 ? "The memory is empty." : "No fact relates to these words.")
    const lines = found.items.map((i) => `- ${i.text.replaceAll("\n", " ")}`)
    return ok(
      [
        `${found.items.length} of ${found.total} facts:`,
        ...lines,
        ...(found.more ? ["More facts exist. Give other words to find them."] : []),
      ].join("\n"),
    )
  }

  const save = async (ctx: MemoryToolContext, call: ToolCall): Promise<MemoryToolResult> => {
    const text = typeof parse(call).text === "string" ? (parse(call).text as string).trim() : ""
    if (text === "") return fail("Nothing was saved: the fact is empty.")
    if (charLength(text) > MEMORY_TOOL_MAX)
      return fail(
        `Nothing was saved: a fact is at most ${MEMORY_TOOL_MAX} characters. Say it shorter and try again.`,
      )
    if (looksLikeSecret(text))
      return fail(
        "Nothing was saved: the text looks like a secret. Leave the secret out of the fact. The user can type it by hand.",
      )
    const settings = memory.settings(ctx.workflowId)
    if (!settings?.enabled) return fail("Nothing was saved: memory is off for this workflow.")
    if (memory.known(ctx.workflowId, text) || proposals.waitingFact(ctx.workflowId, text))
      return ok("The fact is known already. Nothing was added.")
    const atOnce = settings.mode === "now" && settings.selfImprovement && ctx.mayPress
    if (!atOnce) {
      const made = await Effect.runPromise(
        proposals.propose({
          workflowId: ctx.workflowId,
          source: ctx.source,
          taskId: ctx.taskId,
          outside: ctx.outside,
          reason: "",
          change: { kind: "memory", text },
        }),
      )
      if (made.ok)
        return ok(
          "Suggested. The fact waits for the user, who decides. It is not in the memory yet.",
          { kind: "suggested", proposalId: made.id },
        )
      if (made.reason === "known") return ok(made.text)
      return {
        outcome: { output: `Nothing was suggested: ${made.text}`, failed: true },
        ...(made.reason === "full" ? { event: { kind: "full" } as const } : {}),
      }
    }
    // Save at once is a guarded step: in a turn or a task that holds outside content it asks first.
    const asks = guardVerdict({
      level: ctx.level,
      outside: ctx.outside !== null,
      program: ctx.program,
    })
    let decidedBy: "level" | "user" = "level"
    let device: string | null = null
    if (asks === "ask") {
      let reply: CardReply
      try {
        reply = await ctx.ask(text)
      } catch {
        actionLog.add({
          workflowId: ctx.workflowId,
          kind: "memory",
          target: text,
          decidedBy: "user",
          result: "stopped",
          taskId: ctx.taskId,
          outside: ctx.outside,
        })
        return fail("Nothing was saved: the work was stopped.")
      }
      decidedBy = "user"
      device = reply.device ?? null
      if (reply.answer === "deny") {
        actionLog.add({
          workflowId: ctx.workflowId,
          kind: "memory",
          target: text,
          decidedBy,
          result: "refused",
          taskId: ctx.taskId,
          outside: ctx.outside,
          ...(device ? { device } : {}),
        })
        return ok("Nothing was saved: the user refused. Tell the user that the fact was not saved.")
      }
    }
    const saved = await Effect.runPromise(
      memory.insert(ctx.workflowId, text, { actor: "node", source: "node", taskId: ctx.taskId }),
    )
    actionLog.add({
      workflowId: ctx.workflowId,
      kind: "memory",
      target: text,
      decidedBy,
      result: "ran",
      taskId: ctx.taskId,
      outside: ctx.outside,
      ...(device ? { device } : {}),
    })
    return ok("Saved to the memory.", {
      kind: "saved",
      text,
      historyId: saved.historyId,
    })
  }

  return {
    defs: MEMORY_TOOL_DEFS,
    execute: (ctx: MemoryToolContext, call: ToolCall): Promise<MemoryToolResult> =>
      call.name === MEMORY_SEARCH_TOOL ? search(ctx, call) : save(ctx, call),
  }
}

export type MemoryTool = ReturnType<typeof makeMemoryTool>
