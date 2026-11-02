import type { MessagePart } from "@robot/shared"
import type { ToolCall, Turn } from "./chat.ts"

/**
 * What a turn needs to go on after the app was closed while a card waited (spec 005): the turns
 * of the reply so far, and the call that waits for the user.
 */
export interface Resume {
  readonly turns: readonly Turn[]
  readonly call: ToolCall
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const callOf = (p: ToolPart): ToolCall => ({ id: p.id, name: p.name, input: p.input })

/**
 * Rebuilds the turns of a reply from its saved parts. It returns nothing unless the last part is
 * a card that waits for the user and every step before it has ended. Calls of the same round that
 * did not start yet were never saved, so the model sees the round as it was saved and asks again
 * if it still needs them.
 */
export const resumeOf = (parts: readonly MessagePart[]): Resume | undefined => {
  const last = parts.at(-1)
  if (last?.kind !== "tool" || last.state !== "waiting" || last.ask === undefined) return undefined
  const turns: Turn[] = []
  let text = ""
  let calls: ToolPart[] = []
  const flush = () => {
    if (calls.length === 0) return
    turns.push({ role: "assistant", content: text, toolCalls: calls.map(callOf) })
    for (const call of calls) {
      if (call.state === "waiting" || call.state === "running") continue
      turns.push({ role: "tool", callId: call.id, name: call.name, content: call.output })
    }
    text = ""
    calls = []
  }
  for (const part of parts) {
    if (part.kind === "text") {
      // Text after a round of tools starts the next round.
      if (calls.length > 0) flush()
      text += part.text
    } else if (part.kind === "tool") {
      if (part !== last && part.state !== "done" && part.state !== "failed") return undefined
      calls.push(part)
    }
  }
  flush()
  return { turns, call: callOf(last) }
}
