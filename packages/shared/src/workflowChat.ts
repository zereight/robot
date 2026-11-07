import { Schema } from "effect"
import type { ChatMeter } from "./compact.ts"
import type { OutsideSource } from "./outside.ts"
import type { ChatMarks, RunCard } from "./runs.ts"

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
      /**
       * True when the step did not happen: the user or a rule refused it, or there was nothing to
       * do. The card then names the step as a wish, never as a deed (spec 007, "Tool cards").
       */
      readonly notRun?: boolean
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
  /**
   * The line "Compacted" (spec 003, "Compact"). The model gets `summary` in place of every row
   * before `from`. The chat keeps those rows. `from` is the id of the first row that stays word
   * for word, and the line shows just before it. `at` is when the compact ended: the use of the
   * context is not known until a reply that ends after it. `auto` is true for an automatic compact.
   * `marks` are the marks of the chat when the summary was written: the summary holds what the
   * covered rows held, so it carries their mark (spec 007).
   */
  | {
      readonly kind: "compacted"
      readonly summary: string
      readonly at: number
      readonly auto: boolean
      readonly from: string | null
      readonly marks: ChatMarks
    }
  /**
   * The muted line after an automatic compact that failed (spec 003, "Automatic compact"): the turn
   * went on without it. `code` is the error code; the window writes the words. The model never
   * reads it.
   */
  | { readonly kind: "note"; readonly note: "compact_failed"; readonly code: string }
  /** The muted line of a busy provider (spec 006). The model never reads it. */
  | { readonly kind: "note"; readonly note: "busy_retry"; readonly n: number; readonly of: number }
  /**
   * The muted line after a proposal of the turn (spec 002, "Self-improvement", "Flows", 1): "Suggested
   * a change to the responsible document", "... to the prompt of node <number>", "... to the graph",
   * or "Suggested for memory". It has the link "Review".
   */
  | {
      readonly kind: "note"
      readonly note: "proposal"
      readonly proposalId: string
      readonly proposalKind: "document" | "prompt" | "graph" | "memory"
      readonly nodeNumber: number | null
    }
  /**
   * The muted line after a change that a linked device asked for in the chat and that the server
   * refused: "Not allowed. <server> does not let this device change workflows. Turn it on in
   * Settings → Devices on that computer." (spec 012, "No switch"). The graph did not change.
   */
  | { readonly kind: "note"; readonly note: "not_allowed"; readonly server: string }
  /** The muted line "20 proposals wait. Answer some before the responsible document can propose more." */
  | { readonly kind: "note"; readonly note: "proposals_full" }
  /** The muted line "Saved to memory" with its undo control (spec 008, "Flows", 1). */
  | {
      readonly kind: "note"
      readonly note: "memory_saved"
      readonly text: string
      readonly historyId: string
    }

export type ChatStatus = "done" | "streaming" | "stopped" | "failed"

export interface WorkflowChatMessage {
  readonly id: string
  readonly workflowId: string
  /** `app` is the line "Compacted": the app wrote it, no person and no model (spec 003). */
  readonly author: "user" | "assistant" | "app"
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
  /**
   * The name of a connected account that the chat does not use, because its program cannot be
   * locked to text only. Set while the stored choice is such an account (the next message or pick
   * replaces it), and when no other account is left. `null` otherwise.
   */
  readonly unsafeAccount: string | null
  /**
   * The cards that wait for the user, and the cards that the user answered lately: the approval
   * cards, the question cards and the picks of decision nodes (spec 003, flow 6; spec 007).
   */
  readonly cards: readonly RunCard[]
  /** The marks of the chat: outside content and a sensitive read (spec 007, "The mark of a place"). */
  readonly marks: ChatMarks
  /** The context meter and the state of Compact (spec 003). */
  readonly meter: ChatMeter
  /**
   * True while a compact works: the working line reads "Compacting…" (spec 003). `working` is true
   * too, so Stop shows.
   */
  readonly compacting: boolean
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
  /** The first source of outside content that the task of the node held (spec 007), or none. */
  readonly outside: OutsideSource | null
  /** True when the task held the program mark (spec 007). */
  readonly program: boolean
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
