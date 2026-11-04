import type { MessagePart } from "./chat.ts"
import { messageFiles, messageText } from "./chat.ts"
import { translate } from "./i18n/index.ts"
import type { Locale } from "./settings.ts"
import type { TaskState } from "./task.ts"

// The answers for a channel (spec 028, S104, with 004 and 005): the pure rules of which text goes
// to Teams when a job that a Teams message started ends, and which cards make a waiting line.
// Nothing here touches a page, a clock or a database.

/**
 * How a job in a channel began, when a message from Teams began it:
 * - "lead": the lead read the job (alone, or with parts). The summary of the lead goes to Teams.
 * - "mention": a member answers because a mention, the fast pick, or the user in the app (for a
 *   job that waited for a member) chose it. The reply of that member goes to Teams.
 * A part of a job, a retry of a part, a nudge and a request for changes keep the kind of the job.
 */
export type TeamsJobKind = "lead" | "mention"

export const isTeamsJobKind = (value: unknown): value is TeamsJobKind =>
  value === "lead" || value === "mention"

/** A message of an agent in a channel, as far as these rules need to know it. */
export interface JobMessage {
  readonly kind: "text" | "plan" | "summary"
  readonly parts: readonly MessagePart[]
}

/** What goes to Teams for one reply: the words, and the number of files or pictures. */
export interface JobReply {
  readonly text: string
  readonly files: number
}

const replyOfMessage = (message: JobMessage | undefined): JobReply =>
  message
    ? { text: messageText(message), files: messageFiles(message).length }
    : { text: "", files: 0 }

/**
 * The reply of the lead for a request that ended (spec 028, "Answers and the outbox"). `messages`
 * are the messages of the lead task, oldest first.
 * - When the lead made parts, it is the summary. The plan message never goes. With no summary the
 *   reply is empty: the answer is the line "Done. There is no reply text."
 * - When the lead made no parts, it is the reply text of the lead: its newest message.
 */
export const leadReply = (messages: readonly JobMessage[]): JobReply => {
  const summary = messages.findLast((m) => m.kind === "summary")
  if (summary) return replyOfMessage(summary)
  // A plan means that parts began. The plan message is not an answer.
  if (messages.some((m) => m.kind === "plan")) return { text: "", files: 0 }
  return replyOfMessage(messages.findLast((m) => m.kind === "text"))
}

/** The reply of a member that a mention chose: its newest message in the channel for the task. */
export const memberReply = (messages: readonly JobMessage[]): JobReply =>
  replyOfMessage(messages.findLast((m) => m.kind === "text"))

/**
 * The text of one answer of a member that a mention chose: the name of the member, a colon and the
 * reply text (spec 028). The marker is not part of it.
 */
export const memberAnswer = (locale: Locale, name: string, text: string): string =>
  translate(locale, "teams.line.member", { name, text })

/**
 * The name in the lines "could not finish" and "was stopped" for a job of a channel. A request that
 * the lead read is the channel. A reply of a member that was chosen is that member, so that the
 * line says which member did not finish.
 */
export const jobName = (kind: TeamsJobKind, channelName: string, memberName: string): string =>
  kind === "lead" ? channelName : memberName

/**
 * True when a part of a job that a Teams message started holds the job back, so that Teams gets one
 * waiting line for it (spec 028, "Answers and the outbox"):
 * - the part is in review, or
 * - the part failed or was blocked, and no later try replaced it (its card waits for "Retry" or
 *   "End the request").
 * Only a job that is still open counts. A job that ended gave its answer already, and a part of a
 * job that a restart stopped must not make a line after the restart.
 */
export const partHoldsJobBack = (part: {
  readonly state: TaskState
  readonly replaced: boolean
  readonly jobOpen: boolean
}): boolean => {
  if (!part.jobOpen) return false
  if (part.state === "review") return true
  return (part.state === "failed" || part.state === "blocked") && !part.replaced
}

/** The key of a card in the set of cards that got their waiting line. */
export const waitingKey = {
  /** An approval or a question of an agent. */
  card: (agentId: string, callId: string) => `${agentId}:${callId}`,
  /** A part in review, or a failed or blocked part. */
  part: (taskId: string) => `part:${taskId}`,
  /** The request to pick a member. */
  pick: (messageId: string) => `pick:${messageId}`,
}
