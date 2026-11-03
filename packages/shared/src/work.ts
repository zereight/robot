import type { Verdict } from "./check.ts"
import type { MessageKey } from "./i18n/en.ts"
import {
  type Decision,
  type EndedAs,
  isFinal,
  type Task,
  type TaskSource,
  type TaskState,
} from "./task.ts"

// ---------------------------------------------------------------------------------------------
// The work record (spec 005, "Moments"; spec 002, "Recent work").
// ---------------------------------------------------------------------------------------------

export type MomentId = "given" | "started" | "ended" | "decided" | "judged" | "closed"

/** Who gave a task: its lead (for a part), another agent, or the place it came from. */
export type GivenBy =
  | { readonly kind: "lead"; readonly name: string }
  | { readonly kind: "agent" }
  | { readonly kind: "source"; readonly source: Exclude<TaskSource, "agent"> }

export type Moment =
  | { readonly id: "given"; readonly at: number; readonly by: GivenBy }
  | { readonly id: "started"; readonly at: number }
  | { readonly id: "ended"; readonly at: number; readonly how: EndedAs }
  | {
      readonly id: "decided"
      readonly at: number
      readonly decision: Decision
      readonly text: string | null
    }
  | {
      readonly id: "judged"
      readonly at: number
      readonly verdict: Verdict
      readonly reason: string | null
    }
  | { readonly id: "closed"; readonly at: number; readonly state: TaskState }

/**
 * The moments of a task, in the order of the spec: Given, Started, Ended, Decided, Judged,
 * Closed. A moment that did not happen is left out. `leadName` is the name of the agent that gave
 * the task as a part of its plan, or null. A task of a chat, a routine or a workflow has no
 * decision and no verdict, so it has no such moments.
 */
export const taskMoments = (task: Task, leadName: string | null): Moment[] => {
  const moments: Moment[] = [
    {
      id: "given",
      at: task.createdAt,
      by:
        leadName !== null
          ? { kind: "lead", name: leadName }
          : task.source === "agent"
            ? { kind: "agent" }
            : { kind: "source", source: task.source },
    },
  ]
  if (task.startedAt !== null) moments.push({ id: "started", at: task.startedAt })
  if (task.endedAt !== null && task.endedAs !== null)
    moments.push({ id: "ended", at: task.endedAt, how: task.endedAs })
  if (task.decidedAt !== null && task.decision !== null)
    moments.push({
      id: "decided",
      at: task.decidedAt,
      decision: task.decision,
      text: task.decision === "changes" ? task.decisionText : null,
    })
  if (task.judgedAt !== null && task.verdict !== null)
    moments.push({
      id: "judged",
      at: task.judgedAt,
      verdict: task.verdict,
      reason: task.verdict === "not_met" ? task.verdictReason : null,
    })
  if (isFinal(task.state) && task.finishedAt !== null)
    moments.push({ id: "closed", at: task.finishedAt, state: task.state })
  return moments
}

/** The profile of an agent lists this many tasks (spec 002, "Recent work"). */
export const RECENT_WORK_MAX = 20

/** What a task that waits for the user waits for. */
export type RecentWait = "approval" | "question" | "user"

/** The place of the work that an agent does now, while a task waits behind it. */
export type RecentPlace =
  | { readonly kind: "channel"; readonly name: string }
  | { readonly kind: "routine"; readonly name: string }
  | { readonly kind: "workflow"; readonly name: string }
  | { readonly kind: "computer"; readonly name: string }
  | { readonly kind: "chat" }
  | { readonly kind: "agent" }
  /** The agent works in another thread of its chat (spec 003). */
  | { readonly kind: "thread" }
  /** All slots are in use (spec 005, "Queue"): `count` is the number of slots. */
  | { readonly kind: "slot"; readonly count: number }

/** One row of the block "Recent work". */
export interface RecentWorkRow {
  readonly task: Task
  /** For a task that waits for an approval or a question: which. Null for any other state. */
  readonly wait: RecentWait | null
  /** For a queued task: the place of the work that it waits behind. Null when none is known. */
  readonly behind: RecentPlace | null
  /** When the task last changed, in ms. */
  readonly changedAt: number
}

/** When a task last changed: the latest of the moments that it has. */
export const lastChange = (
  task: Pick<Task, "createdAt" | "startedAt" | "endedAt" | "decidedAt" | "judgedAt" | "finishedAt">,
): number =>
  Math.max(
    task.createdAt,
    task.startedAt ?? 0,
    task.endedAt ?? 0,
    task.decidedAt ?? 0,
    task.judgedAt ?? 0,
    task.finishedAt ?? 0,
  )

/**
 * The words for the state of a row (spec 002): what a task that has not ended waits for, and the
 * plain state for the others. A blocked task also shows its reason (see `recentReason`).
 */
/** The words of what a queued task waits behind (spec 005, "Tasks page"). */
export const behindWords = (
  place: RecentPlace,
): { readonly key: MessageKey; readonly params?: Record<string, string> } => {
  switch (place.kind) {
    case "channel":
      return { key: "recent.behind.channel", params: { name: place.name } }
    case "routine":
      return { key: "recent.behind.routine", params: { name: place.name } }
    case "workflow":
      return { key: "recent.behind.workflow", params: { name: place.name } }
    case "computer":
      return { key: "recent.behind.computer", params: { name: place.name } }
    case "chat":
      return { key: "recent.behind.chat" }
    case "agent":
      return { key: "recent.behind.agent" }
    case "thread":
      return { key: "recent.behind.thread" }
    case "slot":
      return { key: "recent.behind.slot", params: { count: String(place.count) } }
  }
}

export const recentWords = (
  row: Pick<RecentWorkRow, "wait" | "behind"> & { readonly task: Pick<Task, "state"> },
): { readonly key: MessageKey; readonly params?: Record<string, string> } => {
  const { state } = row.task
  if (state === "review") return { key: "recent.waits.review" }
  if (state === "waiting") {
    if (row.wait === "approval") return { key: "recent.waits.approval" }
    if (row.wait === "question") return { key: "recent.waits.question" }
    return { key: "tasks.state.waiting" }
  }
  if (state === "queued" && row.behind) return behindWords(row.behind)
  return { key: `tasks.state.${state}` as MessageKey }
}

/** The reason that a blocked task shows with its state. Null for any other state. */
export const recentReason = (task: Pick<Task, "state" | "error">): string | null =>
  task.state === "blocked" ? (task.error?.detail ?? "") : null
