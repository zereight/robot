import type { ChatMessage, MessagePart } from "@robot/shared"

// The rows of a conversation, as on the desktop (spec 003): a date line when the day changes, and
// one header for the messages of one sender within 5 minutes. The app cannot load the runtime of
// `@robot/shared` (it needs Effect), so the same rules are here, with tests.

/** The fields of a chat message that the rows need. */
export interface RowMessage {
  readonly id: string
  readonly author: "user" | "agent"
  /** The agent that wrote it. Two agents are two senders (spec 003). */
  readonly agentId: string | null
  readonly parts: readonly MessagePart[]
  readonly createdAt: number
  readonly replyTo: string | null
}

export const GROUP_WINDOW_MS = 5 * 60 * 1000

export const sameDay = (a: number, b: number) => {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

/** True when `message` starts a new header after `previous`. */
export const startsGroup = (previous: RowMessage | undefined, message: RowMessage) =>
  !previous ||
  previous.author !== message.author ||
  (message.author === "agent" && previous.agentId !== message.agentId) ||
  message.createdAt - previous.createdAt > GROUP_WINDOW_MS ||
  !sameDay(previous.createdAt, message.createdAt) ||
  message.replyTo !== null

export type Row<M extends RowMessage> =
  | { readonly kind: "date"; readonly key: string; readonly at: number }
  | { readonly kind: "message"; readonly key: string; readonly message: M; readonly head: boolean }

/** The rows of a list of messages in the order of time. */
export const buildRows = <M extends RowMessage>(messages: readonly M[]): Row<M>[] => {
  const rows: Row<M>[] = []
  let previous: M | undefined
  for (const message of messages) {
    if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
      rows.push({ kind: "date", key: `date:${message.id}`, at: message.createdAt })
    }
    rows.push({ kind: "message", key: message.id, message, head: startsGroup(previous, message) })
    previous = message
  }
  return rows
}

/** The plain text of a message, without thinking and tool parts. */
export const messageText = (message: Pick<ChatMessage, "parts">) =>
  message.parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("")

/** The first line of a message, short, for a quote line. */
export const quoteText = (message: Pick<ChatMessage, "parts"> | undefined, max = 80) => {
  const line = (message ? messageText(message) : "").replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The tool card of a message that waits for the user, if one does. */
export const waitingTool = (message: Pick<ChatMessage, "parts">) =>
  message.parts.find(
    (p): p is Extract<MessagePart, { kind: "tool" }> =>
      p.kind === "tool" && p.state === "waiting" && p.ask !== undefined,
  )
