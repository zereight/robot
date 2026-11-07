import { Schema } from "effect"

/** The limits of the message box (spec 003). */
export const CHAT_MESSAGE_MAX = 100_000
export const CHAT_QUEUE_MAX = 10
export const CHAT_ATTACH_MAX = 10
export const CHAT_ATTACH_BYTES = 20 * 1024 * 1024
/** The most skills the command picker shows (spec 003, flow 7). */
export const SKILL_PICKER_MAX = 30
/** Rows from the same sender within this time join under one header (spec 003). */
export const CHAT_GROUP_MS = 5 * 60 * 1000

export type ChatPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "file"
      readonly name: string
      /** Where the copy is, relative to the folder of the workflow. */
      readonly path: string
      readonly size: number
    }
  /** A skill chip (spec 017): the name and a copy of the instructions at the time of sending. */
  | { readonly kind: "skill"; readonly name: string; readonly instructions: string }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly label: string
      readonly state: "running" | "done" | "failed"
      readonly input: string
      readonly output: string
    }
  /**
   * The muted line "Feedback added to the run" (spec 003, "Feedback"). `startedAt` is when the run
   * started. `nodes` lists the numbers of the nodes that will get the feedback. An empty list means
   * that no node will get it.
   */
  | {
      readonly kind: "note"
      readonly note: "feedback_added"
      readonly runId: string
      readonly startedAt: number
      readonly nodes: readonly number[]
    }
  /** The muted line of a busy provider (spec 006). The model never reads it. */
  | { readonly kind: "note"; readonly note: "busy_retry"; readonly n: number; readonly of: number }

export type ChatStatus = "done" | "streaming" | "stopped" | "failed"

export interface WorkflowChatMessage {
  readonly id: string
  readonly workflowId: string
  readonly author: "user" | "assistant"
  readonly parts: readonly ChatPart[]
  readonly status: ChatStatus
  /** The reason of a failed reply: a code of the error table, and the detail. */
  readonly error: { readonly code: string; readonly detail: string | null } | null
  /** The id of the message that this one replies to (spec 003, flow 5). */
  readonly replyTo: string | null
  /** Set while a message that was sent into a turn waits to be read: "Read at the next step". */
  readonly pending: boolean
  readonly model: string | null
  readonly createdAt: number
  readonly finishedAt: number | null
}

/** A message that waits in the queue above the box (setting "Wait in a queue"). */
export interface QueuedChatMessage {
  readonly id: string
  readonly text: string
  readonly files: readonly string[]
}

/** The notice above the box after a restart cut off the last request (spec 003, "Rules"). */
export interface ChatNotice {
  readonly messageId: string
  /** True when the request had not reached the model: the notice offers "Send again". */
  readonly notSent: boolean
}

/** Why the message box cannot send now. `null`: it can. */
export type ChatBlock = "no_provider" | "no_model" | null

/**
 * The account and the model that answer in the chat, shown in its header. `feedback` is false for
 * an account that has no tools in this chat (a vendor program): the chat then cannot add feedback
 * to a run.
 */
export interface ChatAnswer {
  readonly accountId: string
  readonly accountName: string
  readonly model: string
  readonly feedback: boolean
}

export interface WorkflowChatHistory {
  readonly workflowId: string
  readonly workflowName: string
  readonly messages: readonly WorkflowChatMessage[]
  /** The messages in the queue, oldest first. */
  readonly queue: readonly QueuedChatMessage[]
  /** True while a turn of the chat works. */
  readonly working: boolean
  /** When the working turn started. */
  readonly workingSince: number | null
  /** The notice of a request that a restart cut off. */
  readonly notice: ChatNotice | null
  readonly block: ChatBlock
  /** Who answers now. `null` when no account is connected. */
  readonly answer: ChatAnswer | null
}

export const WorkflowChatSend = Schema.Struct({
  workflowId: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(CHAT_MESSAGE_MAX)),
  /** Full paths of the files to attach. The app copies them into the folder of the workflow. */
  files: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(CHAT_ATTACH_MAX))),
  /** The id of a skill that the chip in the box names (spec 017). */
  skillId: Schema.optionalKey(Schema.String),
  replyTo: Schema.optionalKey(Schema.String),
})
export type WorkflowChatSend = typeof WorkflowChatSend.Type

/** The text of a message: all text parts, joined. */
export const chatText = (message: Pick<WorkflowChatMessage, "parts">): string =>
  message.parts
    .filter((p): p is Extract<ChatPart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("")

export const chatFiles = (message: Pick<WorkflowChatMessage, "parts">) =>
  message.parts.filter((p): p is Extract<ChatPart, { kind: "file" }> => p.kind === "file")

/** True when `message` starts a new group under a header: other sender, or more than 5 minutes. */
export const startsChatGroup = (
  previous: WorkflowChatMessage | undefined,
  message: WorkflowChatMessage,
) =>
  !previous ||
  previous.author !== message.author ||
  message.createdAt - previous.createdAt > CHAT_GROUP_MS

export const sameChatDay = (a: number, b: number) => {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

/**
 * The slash picker (spec 003, flow 7): opens only when the slash is the first character of the
 * message and no space follows yet. Returns the text after the slash, or `null` when the picker
 * stays closed. A path such as `~/notes/todo` never opens it.
 */
export const slashQuery = (text: string): string | null => {
  if (!text.startsWith("/")) return null
  const rest = text.slice(1)
  return /\s/.test(rest) ? null : rest
}

/** Names and numbers of the nodes that a feedback line lists, for the chat to say. */
export const feedbackLine = (nodes: readonly number[]) => nodes.join(", ")

/**
 * What the chat knows about one task of a run, for the answers of spec 003 ("Progress, stops,
 * results and feedback"). The words of `state` are the words of spec 005.
 */
export type RunNodeState =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "not_reached"

export interface RunNodeFact {
  readonly number: number
  readonly name: string
  readonly kind: "text" | "decision"
  readonly state: RunNodeState
  /** The reason in words, when the state has one (spec 005, "States and reasons"). */
  readonly reason: string | null
  /** What the node wrote. `null`: the node has not ended. */
  readonly result: string | null
  /** A decision node: the probability of each option and the option that won. */
  readonly decision: {
    readonly options: readonly { readonly label: string; readonly probability: number }[]
    readonly taken: string | null
  } | null
}

export interface RunFact {
  readonly id: string
  readonly state: string
  /** The reason that the run stopped, in words. */
  readonly reason: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly source: string
  /** True while the run works or waits. */
  readonly active: boolean
  readonly nodes: readonly RunNodeFact[]
}
