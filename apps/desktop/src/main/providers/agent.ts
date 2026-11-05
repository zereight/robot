import type { ListedStep, RefusalReason } from "@robot/shared"
import { withBusyRetries } from "./busyRetry.ts"
import {
  type ChatRequest,
  type ReplyBlock,
  type StreamEvent,
  streamChat,
  type ToolCall,
  type ToolDef,
  type Turn,
} from "./chat.ts"
import { type SpentEvent, spendTracker } from "./spent.ts"
import type { TurnInbox } from "./turn.ts"

export interface ToolOutcome {
  readonly output: string
  readonly failed: boolean
  /** Set when the permission level refused the step, so the card says why (spec 007). */
  readonly refused?: RefusalReason
  /** True when the step did not run because the user, or a rule, refused it (spec 005, 007). */
  readonly notRun?: boolean
}

/** A tool call as it shows in the reply, before and after it runs. */
export type ToolEvent =
  | { readonly type: "tool"; readonly state: "running"; readonly call: ToolCall }
  | {
      readonly type: "tool"
      readonly state: "done" | "failed"
      readonly call: ToolCall
      readonly output: string
      readonly refused?: RefusalReason
      /** The step did not run: the user or a rule refused it. The action log does not count it as run. */
      readonly notRun?: true
    }

/** The agent read a message that the user sent into the turn (spec 003). */
export interface JoinedEvent {
  readonly type: "joined"
  readonly id: string
}

/**
 * The program reported its list of steps (a plan, spec 006). Each event holds the whole list as it
 * stands now, so the last one is the list. "Keep going" (spec 005) reads it when the turn ends.
 * The reply does not show it.
 */
export interface PlanEvent {
  readonly type: "plan"
  readonly steps: readonly ListedStep[]
}

export type AgentEvent =
  | Exclude<StreamEvent, { type: "toolcall" }>
  | ToolEvent
  | JoinedEvent
  | PlanEvent
  | SpentEvent

/**
 * Asks the model, runs the tools it calls, gives it the results, and asks again, until it
 * answers without a tool call. Tools of one round run one after another, in order.
 *
 * Messages that the user sends during the turn (`inbox`) go to the model with the next request:
 * after the tool step that runs, or after the reply that streams. A reply with no tool call ends
 * the turn only when no message waits.
 */
export async function* runAgent(
  req: ChatRequest,
  execute: (call: ToolCall) => Promise<ToolOutcome>,
  /**
   * A call that waited for the user when the app closed (spec 005). `req.turns` already holds the
   * turn that made the call. The turn goes on with this call and asks the model after it.
   */
  resume?: ToolCall,
  inbox?: TurnInbox,
  /** More tools for each request: the set can grow during the turn (spec 018, "Many tools"). */
  moreTools?: () => readonly ToolDef[],
): AsyncGenerator<AgentEvent> {
  const turns: Turn[] = [...req.turns]
  let pending = resume
  /** Gives the waiting messages to the model, as one message of the user. False when none waits. */
  const join = function* (): Generator<AgentEvent, boolean> {
    const joined = inbox?.take() ?? []
    if (joined.length === 0) return false
    for (const message of joined) yield { type: "joined", id: message.id }
    turns.push({ role: "user", content: joined.map((m) => m.text).join("\n\n") })
    return true
  }
  // The number of steps in a turn is limited by the step limit of the task (spec 005), which the
  // caller enforces. The turn ends when the model answers without a tool call.
  for (;;) {
    let text = ""
    let blocks: readonly ReplyBlock[] | undefined
    const calls: ToolCall[] = []
    if (pending) {
      calls.push(pending)
    } else {
      const tools = moreTools ? [...(req.tools ?? []), ...moreTools()] : req.tools
      // Every request is billed on its own: the counts of one request are running totals, and
      // the next request starts from nothing. `spent` says what the request used since the last
      // report, so a task adds up all the requests of a turn (spec 005, "Usage of a task").
      const spend = spendTracker()
      const hook = req.busy
      const open = () => streamChat({ ...req, turns, ...(tools ? { tools } : {}) })
      // A busy provider is tried again only for an agent that uses the tools of the app, and only
      // for a request that has made no output yet (spec 006). A vendor runtime sets no hook.
      const events = hook
        ? withBusyRetries(open, {
            signal: req.signal,
            onWait: (n) => hook.wait(n),
            onTry: () => hook.again(),
          })
        : open()
      for await (const event of events) {
        if (event.type === "usage") {
          yield event
          const spent = spend(event)
          if (spent) yield spent
          continue
        }
        if (event.type === "toolcall")
          calls.push({ id: event.id, name: event.name, input: event.input })
        else if (event.type === "reply") blocks = event.blocks
        else {
          if (event.type === "text") text += event.text
          yield event
        }
      }
      if (calls.length === 0) {
        // The reply goes back as a turn of its own, so the messages of the user follow it.
        turns.push({ role: "assistant", content: text })
        if (yield* join()) continue
        return
      }
      // A reply with thinking goes back as the model made it, so that it goes on thinking.
      turns.push({
        role: "assistant",
        content: text,
        toolCalls: calls,
        ...(blocks ? { blocks } : {}),
      })
    }
    for (const call of calls) {
      // The card of a resumed call shows already, so it is not announced again.
      if (call !== pending) yield { type: "tool", state: "running", call }
      let outcome: ToolOutcome
      try {
        outcome = await execute(call)
      } catch (error) {
        if (req.signal.aborted) throw error
        outcome = { output: String(error instanceof Error ? error.message : error), failed: true }
      }
      yield {
        type: "tool",
        state: outcome.failed ? "failed" : "done",
        call,
        output: outcome.output,
        ...(outcome.refused ? { refused: outcome.refused } : {}),
        ...(outcome.notRun ? { notRun: true as const } : {}),
      }
      turns.push({ role: "tool", callId: call.id, name: call.name, content: outcome.output })
    }
    pending = undefined
    yield* join()
  }
}
