import { GO_ON_MESSAGE, type MessagePart, STEP_CUT_OUTPUT } from "@robot/shared"
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

/** The most lines of steps that the go-on message lists for a program that reads text only. */
const STEP_LINES_MAX = 40

/**
 * The turns for the backup model when the first try ran steps (spec 006, "Backup model"): the
 * turns of the chat, the work that the reply holds so far, and the short message that asks the
 * model to go on. The message is not a message of the user and has no row in the chat.
 *
 * An API model gets the work as it was: the text, each call and its result. A step that did not
 * end gets a result that says so, because a call needs one. A program reads text only, so with
 * `steps` the message also lists the steps that ran. When the reply holds no text and no step, the
 * message joins the last message of the user, so that two messages of the user do not follow each
 * other.
 */
export const goOnTurns = (
  base: readonly Turn[],
  parts: readonly MessagePart[],
  options: { readonly steps: boolean },
): Turn[] => {
  const turns: Turn[] = [...base]
  let text = ""
  let calls: ToolPart[] = []
  const flush = () => {
    if (calls.length === 0) {
      if (text.trim()) turns.push({ role: "assistant", content: text })
    } else {
      turns.push({ role: "assistant", content: text, toolCalls: calls.map(callOf) })
      for (const call of calls) {
        const ended = call.state === "done" || call.state === "failed"
        turns.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          content: ended ? call.output : STEP_CUT_OUTPUT,
        })
      }
    }
    text = ""
    calls = []
  }
  const steps: string[] = []
  for (const part of parts) {
    if (part.kind === "text") {
      // Text after a round of tools starts the next round.
      if (calls.length > 0) flush()
      text += part.text
    } else if (part.kind === "tool") {
      calls.push(part)
      steps.push(
        `- ${part.name}${part.label ? `: ${part.label}` : ""} (${part.state === "done" ? "done" : part.state === "failed" ? "failed" : "did not finish"})`,
      )
    }
  }
  flush()
  const listed =
    options.steps && steps.length > 0
      ? `\n\nSteps so far:\n${steps.slice(-STEP_LINES_MAX).join("\n")}`
      : ""
  const message = `${GO_ON_MESSAGE}${listed}`
  const last = turns.at(-1)
  if (last && last.role === "user")
    turns[turns.length - 1] = { role: "user", content: `${last.content}\n\n${message}` }
  else turns.push({ role: "user", content: message })
  return turns
}
