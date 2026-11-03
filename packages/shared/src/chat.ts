import { Schema } from "effect"
import type { SettingsNote } from "./agentSettings.ts"
import type { KnowledgeNote } from "./knowledge.ts"
import type { MemoryNote } from "./memory.ts"
import type { OutsideSource } from "./outside.ts"
import type { RuntimeKind } from "./providers.ts"
import type { SecretAsk } from "./secrets.ts"
import type { SensitiveLabel } from "./sensitive.ts"
import type { TaskProgress } from "./task.ts"
import type { RefusalReason } from "./tools.ts"

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
  /** A skill chip (spec 017): the name and a copy of the instructions at the time of sending. */
  | { readonly kind: "skill"; readonly name: string; readonly instructions: string }
  /**
   * A muted line with no task: the watch of a routine checked and saw no change (spec 009,
   * "Post when nothing changed"). `routine` is the name of the routine at that time.
   */
  | { readonly kind: "note"; readonly note: "watch_unchanged"; readonly routine: string }
  /**
   * A muted line with no task: a part of a starter was not made (spec 002, "Starters"). `name` is
   * the name that the routine or skill would have had. `why` is "limit" when the server held 50
   * routines or 100 skills, and "error" for any other failure. The model never reads it.
   */
  | {
      readonly kind: "note"
      readonly note: "starter_not_made"
      readonly what: "routine" | "skill"
      readonly name: string
      readonly why: "limit" | "error"
    }
  /**
   * The line "Compacted" (spec 003, "Compact"). The model gets `summary` in place of every older
   * row of the thread. The chat keeps those rows. `at` is when the compact ended: the use of the
   * context is not known until a reply that ends after it. `auto` is true for an automatic compact.
   */
  | {
      readonly kind: "compacted"
      readonly summary: string
      readonly at: number
      readonly auto: boolean
    }
  /**
   * A muted line with no task: an automatic compact failed and the turn went on without it (spec
   * 003, "Automatic compact"). `code` is the error code; the window writes the words.
   */
  | { readonly kind: "note"; readonly note: "compact_failed"; readonly code: string }
  /**
   * The muted line "Handed over to <name>" in the chat that the user left (spec 003, "Hand over").
   * It links to the new thread. `toName` is the name that the other agent had then. The model
   * never reads it.
   */
  | {
      readonly kind: "note"
      readonly note: "handed_over"
      readonly toName: string
      readonly toAgentId: string
      readonly toThreadId: string
    }
  /**
   * The handover card (spec 003, "Hand over"): the brief that the app wrote, and the place it
   * came from. The card is no words of the user (spec 007). `fromThreadId` is null for a main
   * thread. The model gets the brief as information from a colleague.
   */
  | {
      readonly kind: "handover"
      readonly brief: string
      readonly fromName: string
      readonly fromAgentId: string
      readonly fromThreadId: string | null
    }
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
      /** Set for the memory tool: a saved item (with undo) or a suggestion (with a link). */
      readonly memory?: MemoryNote
      /** Set when a linked device answered the approval: its answer and its name (spec 012). */
      readonly decision?: { readonly answer: "allow" | "deny"; readonly by: string }
      /** Set for a knowledge tool: what it read or changed, so the card can show it. */
      readonly knowledge?: KnowledgeNote
      /** Set when a message of the user in the chat answered this question card (spec 003). */
      readonly answeredInChat?: boolean
      /** Set when a protected card ended: the value was saved, or the user cancelled (spec 020). */
      readonly secret?: "saved" | "cancelled"
      /** Set for the settings tool: what the call changed, so the chat shows a line with Undo. */
      readonly settings?: SettingsNote
      /**
       * Set when the step did not run because the permission level refused it: the card says
       * "Refused: read only" (spec 007). The action log reads this to record the result Refused,
       * with the level as the one who decided.
       */
      readonly refused?: RefusalReason
      /**
       * Set when the app refused or failed the step for a reason of its own (spec 005): a code
       * that the card translates, for example the limit of the chain of messages.
       */
      readonly reason?: { readonly code: string; readonly detail?: string }
    }

/** A request that waits for the user. `askedAt` is the time when the agent asked (spec 007). */
export type ToolAsk =
  | {
      readonly kind: "approval"
      readonly summary: string
      readonly askedAt?: number
      /** True when the card has no "Always allow": it asks again the next time. */
      readonly once?: boolean
      /**
       * Set when a guarded step asks because the turn holds outside content (spec 007). The card
       * says so and names this first source. Such a card always has `once`.
       */
      readonly outside?: OutsideSource
      /**
       * Set when a step that sends data out asks because the turn read a credential place (spec
       * 007, "Sensitive places"). The card says "This turn read a place with keys or logins." and
       * names the label of the first place. Such a card always has `once`.
       */
      readonly sensitive?: SensitiveLabel
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
  /** The agent asks for the value of a saved secret: a card with a hidden field (spec 020). */
  | SecretAsk

/** The text that the status island shows for a card that waits. */
export const askSummary = (ask: ToolAsk) =>
  ask.kind === "approval"
    ? ask.summary
    : ask.kind === "question"
      ? ask.question
      : ask.kind === "secret"
        ? `${ask.label || ask.name} (${ask.origin})`
        : ask.title

/**
 * The kind of a card for the status island: an article card is an approval. A protected card
 * counts as a question, and the island has no field for it (spec 020).
 */
export const askKind = (ask: ToolAsk): "approval" | "question" =>
  ask.kind === "question" || ask.kind === "secret" ? "question" : "approval"

/**
 * Whether the card has the choice "Always allow for this agent" (spec 007): an approval, not the
 * card that asks again each time. An article card and a question have none.
 */
export const askAllowsAlways = (ask: ToolAsk): boolean => ask.kind === "approval" && !ask.once

export type MessageStatus = "done" | "streaming" | "stopped" | "failed"

export interface ChatMessage {
  readonly id: string
  readonly agentId: string
  /** The thread of the message (spec 003, "Threads"). Null for the main thread. */
  readonly threadId?: string | null
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
  /**
   * A message that the user sent into a running turn and that the agent did not read yet (spec
   * 003): "waiting" can still be deleted, "handed" went to the program already. Null otherwise.
   */
  readonly unread?: "waiting" | "handed"
  /**
   * How far the turn of a failed reply went (spec 005), for the line on its failed row. Set only
   * for a failed reply whose task is known.
   */
  readonly progress?: TaskProgress | null
}

/**
 * A request that a restart cut off, and that the user has not answered since (spec 003, "Rules").
 * The notice shows above the message box while the reply `messageId` is the last message.
 */
export interface CutNotice {
  /** The task that the restart ended. "Send again" retries it. */
  readonly taskId: string
  /** The reply of that task. The notice shows only while this is the last message of the chat. */
  readonly messageId: string
  readonly progress: TaskProgress
}

export type FilePart = Extract<MessagePart, { kind: "file" }>
export type SkillPart = Extract<MessagePart, { kind: "skill" }>

export interface QueuedMessage {
  readonly id: string
  readonly text: string
  readonly files: readonly FilePart[]
  readonly replyTo: string | null
  /** The skill chip of the message, with its copy of the instructions. */
  readonly skill?: SkillPart
  /**
   * Why the message does not go yet: the task queue of the agent is full (spec 005, "Queue"). It
   * goes when a queued task starts or ends.
   */
  readonly blocked?: { readonly code: string; readonly detail: string }
}

/**
 * Why messages wait in the queue while the agent works, whatever the setting says: the program of
 * the agent takes no input during a turn (spec 003). Null when the setting decides.
 */
export interface QueueHold {
  readonly runtime: RuntimeKind
}

/** The chat of an agent: its messages, its queue, and what holds the queue. */
export interface ChatHistory {
  readonly messages: readonly ChatMessage[]
  readonly queue: readonly QueuedMessage[]
  readonly hold: QueueHold | null
  /** The request that a restart cut off, or null (spec 003). */
  readonly cut?: CutNotice | null
}

export const MESSAGE_MAX = 100_000
/** The message queue of one thread holds at most this many messages (spec 003). */
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
  /** The skill of the chip in the message box (spec 017). */
  skillId: Schema.optionalKey(Schema.String),
  /** The thread of the message (spec 003). None or null for the main thread. */
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  handoverOf(previous) !== undefined ||
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

/** The handover card of a message, if it is one (spec 003, "Hand over"). */
export const handoverOf = (message: Pick<ChatMessage, "parts">) =>
  message.parts.find((p): p is Extract<MessagePart, { kind: "handover" }> => p.kind === "handover")

/** The muted line "Handed over to <name>" of a message, if it is one. */
export const handedOverOf = (message: Pick<ChatMessage, "parts">) =>
  message.parts.find(
    (p): p is Extract<MessagePart, { kind: "note"; note: "handed_over" }> =>
      p.kind === "note" && p.note === "handed_over",
  )

/**
 * The words of the user in a chat (spec 007): the text of the messages that the user wrote. A
 * handover card has the author "user" in the chat, but it is no words of the user: only the text
 * that the user typed in the dialog is (spec 003, "Hand over"). Files, skill chips and cards add
 * no words. A check of a step at the level "Ask when unsure" reads the words from here.
 */
export const userWords = (messages: readonly Pick<ChatMessage, "author" | "parts">[]): string[] =>
  messages.flatMap((m) =>
    m.author === "user" && handoverOf(m) === undefined && messageText(m).trim() !== ""
      ? [messageText(m)]
      : [],
  )

/** The skill chip of a message, if it has one. */
export const messageSkill = (message: Pick<ChatMessage, "parts">) =>
  message.parts.find((p): p is SkillPart => p.kind === "skill")

/**
 * True when the saved parts of a message are one muted note or the line "Compacted": it is no turn
 * of the chat.
 */
export const isNoteOnly = (parts: string | readonly MessagePart[]): boolean => {
  try {
    const list = typeof parts === "string" ? (JSON.parse(parts) as MessagePart[]) : parts
    return list.length > 0 && list.every((p) => p.kind === "note" || p.kind === "compacted")
  } catch {
    return false
  }
}
