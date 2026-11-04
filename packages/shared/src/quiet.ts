import { formatRunTime } from "./notifications.ts"
import type { TaskSource } from "./task.ts"

/**
 * The quiet line (spec 005, "Quiet line"). A turn is quiet when it shows no sign of life for the
 * quiet time. Every place that shows the turn as working then reads "No answer from <name> for
 * <time>" in place of its working text.
 */

/** The quiet time is this long, or half of the silent limit when that is shorter. */
export const QUIET_MS = 90_000

/** The quiet time for a silent limit in minutes. The limit 0 is "Never": the time is 90 seconds. */
export const quietTimeMs = (limitMinutes: number) =>
  limitMinutes <= 0 ? QUIET_MS : Math.min(QUIET_MS, (limitMinutes * 60_000) / 2)

/** One turn that is quiet now. `seconds` is the time on the quiet clock when this was sent. */
export interface QuietTurn {
  readonly taskId: string
  readonly agentId: string
  /** The thread of a chat turn that is not the main thread. Null for the main thread. */
  readonly threadId: string | null
  readonly source: TaskSource
  /** The chat agent or the channel that the task came from. */
  readonly sourceId: string | null
  /** The name of the model account, or of the vendor program (spec 006). */
  readonly name: string
  readonly seconds: number
}

/** The whole state: every turn that is quiet now. A server sends it at each start and end. */
export interface QuietState {
  readonly turns: readonly QuietTurn[]
}

/** What a place shows: the name and the time as text. */
export interface QuietShown {
  readonly name: string
  readonly time: string
}

/**
 * The time on the quiet clock now. A client counts on from the value it got and the moment it
 * got it, so a server does not push each second.
 */
export const quietSeconds = (turn: Pick<QuietTurn, "seconds">, receivedAt: number, now: number) =>
  turn.seconds + Math.max(0, Math.floor((now - receivedAt) / 1000))

/** The time of the quiet line: m:ss, and h:mm:ss after one hour. */
export const formatQuiet = (seconds: number) => formatRunTime(seconds * 1000)

export const quietShown = (
  turn: Pick<QuietTurn, "name" | "seconds">,
  receivedAt: number,
  now: number,
): QuietShown => ({ name: turn.name, time: formatQuiet(quietSeconds(turn, receivedAt, now)) })

/**
 * The quiet turn that the working line of a chat shows: the turn of this agent in this thread
 * (null is the main thread). A part of a channel shows in the plan of the channel, not here.
 */
export const quietOfChat = (
  turns: readonly QuietTurn[],
  agentId: string,
  threadId: string | null,
): QuietTurn | undefined =>
  turns.find((t) => t.agentId === agentId && t.source !== "channel" && t.threadId === threadId)

export const quietOfTask = (turns: readonly QuietTurn[], taskId: string): QuietTurn | undefined =>
  turns.find((t) => t.taskId === taskId)
