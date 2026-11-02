import type { MessagePart } from "@robot/shared"

/**
 * A text that changes when a message grows or changes how it looks: a part is added, text or
 * output gets longer, a card changes state. An effect that reads it runs again for those changes.
 *
 * The state of a chat keeps the same objects when a message is updated (only the fields that
 * differ change), so "the parts are a new list" no longer tells that a reply grew.
 */
export const shapeOf = (
  message: { readonly status: string; readonly parts: readonly MessagePart[] } | undefined,
): string => {
  if (!message) return ""
  let shape = `${message.status}:${message.parts.length}`
  for (const part of message.parts) {
    if (part.kind === "text" || part.kind === "thinking") shape += `|${part.text.length}`
    else if (part.kind === "tool")
      shape += `|${part.state}.${part.input.length}.${part.output.length}${part.ask ? "a" : ""}${
        part.memory ? "m" : ""
      }${part.knowledge ? "k" : ""}${part.settings ? "s" : ""}${part.decision ? "d" : ""}${
        part.answeredInChat ? "q" : ""
      }${part.secret ?? ""}`
    else shape += `|${part.kind}`
  }
  return shape
}
