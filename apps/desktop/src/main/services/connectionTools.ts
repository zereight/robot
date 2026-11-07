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

/**
 * The most characters of arguments that a call may have. The card shows all of them (spec 018,
 * "Rules"), so a call with more is refused before any card and before anything goes to the
 * connection: no hidden part, and no "Always allow" for a card that shows less than it sends.
 */
export const ARGS_CARD_MAX = 20_000
/** What the node reads when the arguments are too long. */
export const ARGS_TOO_LONG_TEXT = `Refused: the arguments are longer than ${ARGS_CARD_MAX} characters, so the user cannot check them. Nothing was sent. Call the tool again with shorter arguments.`
/** A connection name in a line of the card or the log is cut here, and a tool name at NAME_MAX. */
const CONNECTION_NAME_MAX = 40
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

/**
 * The arguments as the card shows them: indented, with a secret hidden, and whole. Null when they
 * are longer than `ARGS_CARD_MAX`: the call is refused then, never shown in part.
 */
export const argumentsText = (args: Record<string, unknown>): string | null => {
  const raw = JSON.stringify(args, null, 2)
  // The size is checked before the secrets are hidden, so a huge value costs no scan.
  if (raw.length > ARGS_CARD_MAX) return null
  const text = redactSecrets(raw)
  return text.length > ARGS_CARD_MAX ? null : text
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
    // The names come from the connection (the server and the user's form). In the card, the tool
    // line and the action log they are plain lines: no newline or direction control can forge a
    // line above the real arguments (spec 018, 007). A rule still matches the raw names.
    const names = {
      connection: plainLine(target.connection, CONNECTION_NAME_MAX),
      tool: plainLine(target.tool, NAME_MAX),
    }
    const label = connectionToolLabel(names.connection, names.tool)
    // "Read only" refuses every tool of a connection, also one with the read-only mark: the app
    // cannot check the mark (spec 018, "Rules").
    if (ctx.level === "read_only") {
      cx.note({ kind: "call", ...names, result: "refused", how: "read_only_level" })
      return host.readOnly(ctx, label)
    }
    // The card shows the arguments whole or the call does not go on: nothing is sent, no card.
    const shown = argumentsText(args)
    if (shown === null) {
      host.log(ctx, label, "refused")
      cx.note({ kind: "call", ...names, result: "refused", how: "too_long" })
      return { output: ARGS_TOO_LONG_TEXT, failed: true, notRun: true }
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
          summary: `${label}\n${shown}`,
          risky: !markHelps,
          target: label,
        },
        async (by) => {
          state.decided = by
          const result = await cx.turn.call(call.name, args, ctx.signal)
          // What comes back is data from outside: the task holds outside content from now on, also
          // when the tool says that it failed, and also when the failure holds the text of the
          // server (the message of its JSON-RPC error). Only the two texts of the app itself (the
          // time limit, an unknown tool) are not outside (spec 007, 018).
          if (!result.ok) {
            if (result.reason !== "timeout" && result.message !== UNKNOWN_TOOL_TEXT)
              host.markOutside(ctx, names.connection, names.tool)
            // One plain line, cut and with a secret hidden: it cannot forge lines or a step.
            throw new Error(plainLine(result.message, 500))
          }
          host.markOutside(ctx, names.connection, names.tool)
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
      // Stop while the card waits: nobody decided the step, so the line does not say "Allowed by you".
      const how = state.decided ? howRan(ctx, state.decided, markHelps) : "none"
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
