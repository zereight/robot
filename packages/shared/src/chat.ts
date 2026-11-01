import { Schema } from "effect"

export type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly id: string
      /** What the agent did, for example "read_file". */
      readonly name: string
      /** A short line for the card, for example the file name. */
      readonly label: string
      readonly state: "running" | "done" | "failed"
      readonly input: string
      readonly output: string
    }

export type MessageStatus = "done" | "streaming" | "stopped" | "failed"

export interface ChatMessage {
  readonly id: string
  readonly agentId: string
  readonly author: "user" | "agent"
  readonly parts: readonly MessagePart[]
  readonly status: MessageStatus
  /** Why a reply failed: an error code, a detail, and when a usage limit resets. */
  readonly error: {
    readonly code: string
    readonly detail: string
    readonly resetsAt: number | null
  } | null
  readonly replyTo: string | null
  readonly model: string | null
  readonly createdAt: number
  readonly editedAt: number | null
}

export interface QueuedMessage {
  readonly id: string
  readonly text: string
  readonly replyTo: string | null
}

export const MESSAGE_MAX = 100_000
export const QUEUE_MAX = 10

export const ChatSend = Schema.Struct({
  agentId: Schema.String,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MESSAGE_MAX)),
  replyTo: Schema.NullOr(Schema.String),
})
export type ChatSend = typeof ChatSend.Type

/** The plain text of a message, without thinking and tool parts. */
export const messageText = (message: Pick<ChatMessage, "parts">) =>
  message.parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("")

/** Rows from one sender within this time join under one header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000

/** True when `message` starts a new header group after `previous`. */
export const startsGroup = (previous: ChatMessage | undefined, message: ChatMessage) =>
  !previous ||
  previous.author !== message.author ||
  message.createdAt - previous.createdAt > GROUP_WINDOW_MS ||
  !sameDay(previous.createdAt, message.createdAt) ||
  message.replyTo !== null

export const sameDay = (a: number, b: number) => {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}
