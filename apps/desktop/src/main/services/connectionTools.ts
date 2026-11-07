import {
  connectionToolLabel,
  plainLine,
  type RefusalReason,
  type RuleRef,
  readOnlyMarkCounts,
  redactSecrets,
  SEARCH_TOOLS_NAME,
  type TaskConnectionStep,
  UNKNOWN_TOOL_TEXT,
} from "@robot/shared"
import { McpCallStopped } from "../connections/mcp.ts"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall } from "../providers/chat.ts"
import type { ConnectionTurn } from "./Connections.ts"
import type { NodeToolContext } from "./NodeTools.ts"

/**
 * The tools of the connections for a text node (spec 018, "Rules", "Many tools"). The tools of
 * the app live in `NodeTools.ts`; this module holds only what is special to a connection, and
 * `NodeTools.ts` hands it the gate of spec 007 through `ConnectionHost`. It holds no state: the
 * connections of a task are in `ctx.connections`, which the run engine makes at the start of the
 * task.
 */

/** What the engine gives a task whose node may use connections (an API provider, spec 018). */
export interface ConnectionTaskContext {
  readonly turn: ConnectionTurn
  /** Writes a tool line for the run view. */
  readonly note: (line: TaskConnectionStep) => void
}

/** The result of a gate: who decided a step. */
export interface ConnectionDecided {
  readonly by: string
  readonly rule: RuleRef | null
}

/** What `NodeTools.ts` lends to this module. */
export interface ConnectionHost {
  /**
   * Runs a step through the gate of spec 007 (rules, level, card, action log). `work` runs only
   * when the step may go on. A refusal is logged and thrown.
   */
  guarded<A>(
    ctx: NodeToolContext,
    input: {
      readonly connection: string
      readonly tool: string
      readonly summary: string
      readonly risky: boolean
      readonly target: string
    },
    work: (decided: ConnectionDecided) => Promise<A>,
  ): Promise<A>
  /** The task holds outside content from now on (spec 007). */
  markOutside(ctx: NodeToolContext, connection: string, tool: string): void
  /** Writes one entry of the action log for a step that did not go through the gate. */
  log(ctx: NodeToolContext, target: string, result: "failed" | "refused"): void
  /** The outcome for a step that "Read only" refuses. */
  readOnly(ctx: NodeToolContext, target: string): ToolOutcome
  /** What a refusal thrown by the gate says, or null for any other error. */
  refusal(error: unknown): { readonly reason: RefusalReason | undefined } | null
}

/** The arguments in the text of the approval card are cut here. */
const ARGS_CARD_MAX = 2_000
/** The words of a search in the run view are cut here. */
const WORDS_MAX = 100
/** A name in a line of the run view is cut here. */
const NAME_MAX = 80

const parseArgs = (call: ToolCall): Record<string, unknown> => {
  try {
    const value = JSON.parse(call.input || "{}")
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The arguments as the card shows them: indented, with a secret hidden, and cut. */
export const argumentsText = (args: Record<string, unknown>): string => {
  const text = redactSecrets(JSON.stringify(args, null, 2))
  return text.length > ARGS_CARD_MAX ? `${text.slice(0, ARGS_CARD_MAX)}\n…` : text
}

export const makeConnectionTools = (host: ConnectionHost) => {
  /** True when the call is one that this module answers. */
  const owns = (ctx: NodeToolContext, name: string): boolean =>
    ctx.connections !== undefined &&
    (name.startsWith("mcp__") || (name === SEARCH_TOOLS_NAME && ctx.connections.turn.searching))

  const execute = async (ctx: NodeToolContext, call: ToolCall): Promise<ToolOutcome> => {
    const cx = ctx.connections
    if (!cx) return { output: `Unknown tool: ${call.name}`, failed: true }
    const args = parseArgs(call)

    // The step "Search tools": it changes nothing and sends nothing to a connection. It needs no
    // approval, makes no entry in the action log and gives no outside content (spec 018).
    if (call.name === SEARCH_TOOLS_NAME) {
      const query = typeof args.query === "string" ? args.query : ""
      const found = cx.turn.search(query)
      cx.note({ kind: "search", words: plainLine(query, WORDS_MAX), found: found.found })
      return { output: found.text, failed: false }
    }

    const target = cx.turn.resolve(call.name)
    if (!target) {
      // The node named a tool that it may not call: it did not search for it, or the connection
      // is out of its scope, or the name is made up. The connection gets no call (spec 018).
      host.log(ctx, plainLine(call.name, 200), "failed")
      cx.note({
        kind: "call",
        connection: "",
        tool: plainLine(call.name, NAME_MAX),
        result: "failed",
        how: "unknown",
      })
      return { output: UNKNOWN_TOOL_TEXT, failed: true, notRun: true }
    }
    const label = connectionToolLabel(target.connection, target.tool)
    const names = {
      connection: plainLine(target.connection, NAME_MAX),
      tool: plainLine(target.tool, NAME_MAX),
    }
    // "Read only" refuses every tool of a connection, also one with the read-only mark: the app
    // cannot check the mark (spec 018, "Rules").
    if (ctx.level === "read_only") {
      cx.note({ kind: "call", ...names, result: "refused", how: "read_only_level" })
      return host.readOnly(ctx, label)
    }
    const outside = ctx.marks.outside !== null
    // A call is not a risky step only when the connection marks the tool, the user trusts the mark,
    // and the task holds no outside content (spec 018, "Rules").
    const markHelps = target.readOnly && target.trusted && !outside
    const state: { decided: ConnectionDecided | null } = { decided: null }
    try {
      const output = await host.guarded(
        ctx,
        {
          connection: target.connection,
          tool: target.tool,
          summary: `${label}\n${argumentsText(args)}`,
          risky: !markHelps,
          target: label,
        },
        async (by) => {
          state.decided = by
          const result = await cx.turn.call(call.name, args, ctx.signal)
          if (!result.ok) throw new Error(plainLine(result.message, 500))
          // The result is data from outside: the task holds outside content from now on, also
          // when the tool says that it failed (spec 007, 018).
          host.markOutside(ctx, target.connection, target.tool)
          const text = redactSecrets(result.text)
          if (result.isError) throw new Error(text)
          return { output: text, failed: false } satisfies ToolOutcome
        },
      )
      cx.note({ kind: "call", ...names, result: "ran", how: howRan(ctx, state.decided, markHelps) })
      return output
    } catch (error) {
      const refusal = host.refusal(error)
      if (refusal) {
        cx.note({
          kind: "call",
          ...names,
          result: "refused",
          how: refusal.reason === "rule" ? "denied_rule" : "denied",
        })
        throw error
      }
      const how = state.decided ? howRan(ctx, state.decided, markHelps) : "user"
      if (ctx.signal.aborted || error instanceof McpCallStopped)
        cx.note({ kind: "call", ...names, result: "stopped", how })
      else cx.note({ kind: "call", ...names, result: "failed", how })
      throw error
    }
  }

  return { owns, execute }
}

/** Why the step ran: the line that the tool card shows (spec 018, "Rules"). */
const howRan = (
  ctx: NodeToolContext,
  decided: ConnectionDecided | null,
  markHelps: boolean,
): "mark" | "rule" | "level" | "user" => {
  if (!decided) return "user"
  if (decided.by === "allow_rule") return "rule"
  if (decided.by === "level") return markHelps && readOnlyMarkCounts(ctx.level) ? "mark" : "level"
  return "user"
}
