import { Schema } from "effect"
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
      /**
       * True when the step asked the user (an approval card): from the time the card opens, while it
       * waits, and after the answer. Such a step stays a card (spec 003, "Folded tool steps").
       */
      readonly asked?: boolean
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
  /** The replies that count as unread, after "Mark as unread" (spec 003, "Mark as unread"). */
  readonly unread: ChatUnread
  /**
   * The id of the one message that "Edit" can change now: the last message of the user, when the
   * rules of `editRefusal` allow it and no run that the chat started follows it. `null`: no message.
   */
  readonly editableId: string | null
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

// --- Folded tool steps (spec 003, "Folded tool steps") ------------------------------------------

export type ChatToolPart = Extract<ChatPart, { readonly kind: "tool" }>

/**
 * The tools whose step carries a memory, a proposal or a feedback note (spec 003: a step with such
 * a note leaves the series). The user sees what the responsible document saved or proposed, so
 * these steps stay cards.
 */
const MARKED_TOOLS: ReadonlySet<string> = new Set([
  "memory_save",
  "propose_document_change",
  "propose_prompt_change",
  "propose_graph_change",
  "add_run_feedback",
])

/**
 * True for a tool step that may join a series: a plain step, finished or still running. A step that
 * waits for the user or asked the user, failed, did not happen (refused, or nothing to do) or
 * carries a note stays out of the series, so the user sees what needs them. A step that asked stays
 * a card after the answer too, so it never goes from a card into a line.
 *
 * A running step joins the series, so that the line of a series stands still while the series
 * grows: a step that showed as its own card and then folded away moved the reply up and down on
 * every step of a long turn.
 */
export const isFoldableChatTool = (part: ChatPart): part is ChatToolPart =>
  part.kind === "tool" &&
  (part.state === "done" || part.state === "running") &&
  part.notRun !== true &&
  part.asked !== true &&
  !MARKED_TOOLS.has(part.name)

/** One row of the body of a reply: one part, or a series of folded tool steps. */
export type ChatSegment =
  | {
      readonly kind: "part"
      /** Stable while the reply grows: the place of the part in the reply. */
      readonly key: string
      readonly part: ChatPart
    }
  | {
      readonly kind: "tools"
      /** Stable while the series grows: the id of its first step. */
      readonly key: string
      readonly parts: readonly ChatToolPart[]
    }

/**
 * The rows of the body of a reply. The thoughts are left out: the chat draws them as one line above
 * the body, so thinking between two steps does not split a series (spec 003). With `fold` true each
 * series of plain tool steps is one row. A text, a file, a note or a step that stays a card ends a
 * series. With `fold` false every part is its own row.
 */
export const groupChatParts = (
  parts: readonly ChatPart[],
  fold: boolean,
): readonly ChatSegment[] => {
  const out: ChatSegment[] = []
  parts.forEach((part, index) => {
    if (part.kind === "thinking") return
    const last = out.at(-1)
    if (fold && isFoldableChatTool(part)) {
      if (last?.kind === "tools") out[out.length - 1] = { ...last, parts: [...last.parts, part] }
      else out.push({ kind: "tools", key: `t${part.id}`, parts: [part] })
    } else out.push({ kind: "part", key: `p${index}`, part })
  })
  return out
}

// --- Mark as unread (spec 003, "Mark as unread") -----------------------------------------------

/** The unread replies of a chat: how many, and the first of them (where the chat opens). */
export interface ChatUnread {
  readonly count: number
  readonly firstId: string | null
}

export const NO_UNREAD: ChatUnread = { count: 0, firstId: null }

/** The place that "Mark as unread" keeps: the message, and its time if the message is gone later. */
export interface UnreadMark {
  readonly id: string
  readonly at: number
}

/**
 * A reply that can be read or unread: a finished reply of the responsible document with content.
 * A reply that still streams is not finished, and a failed reply is an error row.
 */
export const isReadableReply = (message: Pick<WorkflowChatMessage, "author" | "status">): boolean =>
  message.author === "assistant" && (message.status === "done" || message.status === "stopped")

/**
 * The unread replies when the user marked `mark` as unread: that reply and every later reply
 * count. When the marked message is gone (an edit removed it), the first message that is not older
 * takes its place. No mark, or no reply from the place on, gives no unread reply.
 */
export const unreadOf = (
  messages: readonly Pick<WorkflowChatMessage, "id" | "author" | "status" | "createdAt">[],
  mark: UnreadMark | null,
): ChatUnread => {
  if (mark === null) return NO_UNREAD
  let from = messages.findIndex((m) => m.id === mark.id)
  if (from < 0) from = messages.findIndex((m) => m.createdAt >= mark.at)
  if (from < 0) return NO_UNREAD
  let count = 0
  let firstId: string | null = null
  for (const m of messages.slice(from))
    if (isReadableReply(m)) {
      count++
      firstId ??= m.id
    }
  return count === 0 ? NO_UNREAD : { count, firstId }
}

// --- Edit the last message (spec 003, "Message rows") -----------------------------------------

/** Why "Edit" is off for a message. `null` in place of a reason: it can be edited. */
export type EditRefusal = "working" | "not_last" | "steps_ran"

/**
 * Edit is for the last message of the user, as the spec says. The spec states nothing more, so the
 * rule fails closed (docs/spec-questions.md, rows for B4):
 * - while a turn of the chat works, no message changes;
 * - the message must be the last message of the user, a plain sent message (not one that waits to
 *   be read), and a reply of the responsible document must follow it;
 * - no reply after it may hold a step that ran (a tool step that did not fail to start, a proposal,
 *   a memory note or a feedback line). Edit removes the replies after the message, and a change
 *   that a step made cannot be taken back by that. A step that did not happen does not count.
 */
export const editRefusal = (
  messages: readonly WorkflowChatMessage[],
  id: string,
  working: boolean,
): EditRefusal | null => {
  if (working) return "working"
  const at = messages.findIndex((m) => m.id === id)
  const message = messages[at]
  if (message?.author !== "user" || message.status !== "done" || message.pending) return "not_last"
  const later = messages.slice(at + 1)
  if (later.some((m) => m.author === "user")) return "not_last"
  if (!later.some((m) => m.author === "assistant")) return "not_last"
  if (later.some((m) => m.status === "streaming")) return "working"
  const ran = later.some((m) =>
    m.parts.some(
      (p) =>
        (p.kind === "tool" && p.notRun !== true) ||
        (p.kind === "note" &&
          (p.note === "feedback_added" || p.note === "proposal" || p.note === "memory_saved")),
    ),
  )
  return ran ? "steps_ran" : null
}

/** The last message of the user that `editRefusal` allows to edit, or `null`. */
export const editableMessageId = (
  messages: readonly WorkflowChatMessage[],
  working: boolean,
): string | null => {
  const last = messages.findLast((m) => m.author === "user")
  return last && editRefusal(messages, last.id, working) === null ? last.id : null
}
