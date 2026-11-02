import { Schema } from "effect"
import type { KnowledgeNote } from "./knowledge.ts"

export type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "file"
      readonly name: string
      /** Where the copy is, relative to the agent's workspace folder. */
      readonly path: string
      readonly size: number
    }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly id: string
      /** What the agent did, for example "read_file". */
      readonly name: string
      /** A short line for the card, for example the file name. */
      readonly label: string
      readonly state: "running" | "waiting" | "done" | "failed"
      readonly input: string
      readonly output: string
      /** Set while the card waits for the user: an approval or a question. */
      readonly ask?: ToolAsk
      /** Set for a tool that saved a memory item, so the card can offer undo. */
      readonly memoryId?: string
      /** Set when a linked device answered the approval: its answer and its name (spec 012). */
      readonly decision?: { readonly answer: "allow" | "deny"; readonly by: string }
      /** Set for a knowledge tool: what it read or changed, so the card can show it. */
      readonly knowledge?: KnowledgeNote
    }

/** A request that waits for the user. `askedAt` is the time when the agent asked (spec 007). */
export type ToolAsk =
  | {
      readonly kind: "approval"
      readonly summary: string
      readonly askedAt?: number
      /** True when the card has no "Always allow": it asks again the next time. */
      readonly once?: boolean
    }
  | {
      readonly kind: "question"
      readonly question: string
      readonly choices: readonly string[]
      readonly askedAt?: number
    }
  /** The agent wants to change an article that the user edited last. Old and new text show side by side. */
  | {
      readonly kind: "article"
      readonly title: string
      readonly before: string
      /** Null when the article would be deleted. */
      readonly after: string | null
      readonly askedAt?: number
    }

/** The text that the status island shows for a card that waits. */
export const askSummary = (ask: ToolAsk) =>
  ask.kind === "approval" ? ask.summary : ask.kind === "question" ? ask.question : ask.title

/** The kind of a card for the status island: an article card is an approval. */
export const askKind = (ask: ToolAsk): "approval" | "question" =>
  ask.kind === "question" ? "question" : "approval"

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
  /** The name of the linked device that sent this message. Null for this computer (spec 012). */
  readonly fromDevice: string | null
}

export type FilePart = Extract<MessagePart, { kind: "file" }>

export interface QueuedMessage {
  readonly id: string
  readonly text: string
  readonly files: readonly FilePart[]
  readonly replyTo: string | null
}

export const MESSAGE_MAX = 100_000
export const QUEUE_MAX = 10
export const ATTACH_MAX = 10
export const ATTACH_BYTES = 20 * 1024 * 1024

export const ChatSend = Schema.Struct({
  agentId: Schema.String,
  /** May be empty when files are attached. */
  text: Schema.String.check(Schema.isMaxLength(MESSAGE_MAX)),
  replyTo: Schema.NullOr(Schema.String),
  /** Full paths of files to copy into the agent's workspace. */
  files: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(ATTACH_MAX))),
})
export type ChatSend = typeof ChatSend.Type

/** The plain text of a message, without thinking and tool parts. */
export const messageText = (message: Pick<ChatMessage, "parts">) =>
  message.parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("")

export const messageFiles = (message: Pick<ChatMessage, "parts">) =>
  message.parts.filter((p): p is FilePart => p.kind === "file")

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
