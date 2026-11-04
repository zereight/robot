import { splitAssignment } from "@robot/shared"

/**
 * A request body as the stand-in models of the tests read it. The text of a member in a channel
 * starts with its assignment (spec 004, "What a member reads"). A stand-in model decides by the
 * last message of the user, as the earlier text of a member ended with its assignment, so this
 * puts the assignment back behind the last message of the user. A request with no assignment is
 * not changed.
 */
export const asOldShape = <T extends { messages: { role: string; content: string | null }[] }>(
  body: T,
): T => {
  const system = body.messages.find((m) => m.role === "system")
  const split = typeof system?.content === "string" ? splitAssignment(system.content) : null
  if (!split) return body
  const at = body.messages.map((m) => m.role).lastIndexOf("user")
  const messages = [...body.messages]
  messages.splice(at + 1, 0, { role: "user", content: split.assignment })
  return { ...body, messages }
}
