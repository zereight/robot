import {
  type ChatRequest,
  type ReplyBlock,
  type StreamEvent,
  streamChat,
  type ToolCall,
  type Turn,
} from "./chat.ts"

export interface ToolOutcome {
  readonly output: string
  readonly failed: boolean
}

/** A tool call as it shows in the reply, before and after it runs. */
export type ToolEvent =
  | { readonly type: "tool"; readonly state: "running"; readonly call: ToolCall }
  | {
      readonly type: "tool"
      readonly state: "done" | "failed"
      readonly call: ToolCall
      readonly output: string
    }

export type AgentEvent = Exclude<StreamEvent, { type: "toolcall" }> | ToolEvent

export const MAX_ROUNDS = 12

/**
 * Asks the model, runs the tools it calls, gives it the results, and asks again, until it
 * answers without a tool call. Tools of one round run one after another, in order.
 */
export async function* runAgent(
  req: ChatRequest,
  execute: (call: ToolCall) => Promise<ToolOutcome>,
  /**
   * A call that waited for the user when the app closed (spec 005). `req.turns` already holds the
   * turn that made the call. The turn goes on with this call and asks the model after it.
   */
  resume?: ToolCall,
): AsyncGenerator<AgentEvent> {
  const turns: Turn[] = [...req.turns]
  let pending = resume
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = ""
    let blocks: readonly ReplyBlock[] | undefined
    const calls: ToolCall[] = []
    if (pending) {
      calls.push(pending)
    } else {
      for await (const event of streamChat({ ...req, turns })) {
        if (event.type === "toolcall")
          calls.push({ id: event.id, name: event.name, input: event.input })
        else if (event.type === "reply") blocks = event.blocks
        else {
          if (event.type === "text") text += event.text
          yield event
        }
      }
      if (calls.length === 0) return
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
      }
      turns.push({ role: "tool", callId: call.id, name: call.name, content: outcome.output })
    }
    pending = undefined
  }
  yield { type: "text", text: "\n\n(Stopped: too many tool rounds.)" }
}
