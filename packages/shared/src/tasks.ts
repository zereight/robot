import type { TaskProgress } from "./chat.ts"
import type { ActionLogEntry } from "./outside.ts"
import type { RunSource, TaskState } from "./runs.ts"
import type { TaskUsage } from "./taskUsage.ts"
import type { NodeKind } from "./workflows.ts"

// The Tasks page, the queue, the slots, the moments, the quiet line and the retry note (spec 005).
// The words of the states and the reasons are the words of spec 005. This file holds the rules
// that do not depend on the window, so that the main process, the window and the tests share them.

// ---------------------------------------------------------------------------------------------
// Tasks at once (spec 005, "Queue"; spec 013, "General").
// ---------------------------------------------------------------------------------------------

export const TASKS_AT_ONCE_MIN = 1
export const TASKS_AT_ONCE_MAX = 8
export const TASKS_AT_ONCE_DEFAULT = 4

/** True when `value` is a whole number that the setting "Tasks at once" accepts. */
export const isTasksAtOnce = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= TASKS_AT_ONCE_MIN &&
  value <= TASKS_AT_ONCE_MAX

// ---------------------------------------------------------------------------------------------
// The order of the queue (spec 005, "Queue").
// ---------------------------------------------------------------------------------------------

/** The reason codes of a queued task. The text of the reason is built from the code. */
export const QUEUE_SLOT = "slot"
export const QUEUE_BEHIND = "behind"

/** Where a task in the queue comes from. A memory check is last in the order (spec 008). */
export type QueueSource = RunSource | "memory"

/**
 * The rank of a task that waits (spec 005, "Queue"): a lower rank starts first.
 * 0: a task that went on after a wait for the user and needs a slot again.
 * 1: a pick of "Run next". 2: a run that the user started (by hand or from the chat).
 * 3: a run that a trigger started. 4: a memory check.
 */
export const queueRank = (entry: {
  readonly source: QueueSource
  readonly resumed: boolean
  readonly picked: boolean
}): 0 | 1 | 2 | 3 | 4 =>
  entry.resumed
    ? 0
    : entry.picked
      ? 1
      : entry.source === "memory"
        ? 4
        : entry.source === "schedule"
          ? 3
          : 2

/** The quiet clock and the clock of the silent limit (spec 005, "Quiet line"). */
export const QUIET_MS = 90_000
/** The quiet time for a silent limit in ms. The limit 0 is "Never": the time is 90 seconds. */
export const quietTimeMs = (limitMs: number, capMs: number = QUIET_MS) =>
  limitMs <= 0 ? capMs : Math.min(capMs, limitMs / 2)

/** The time of the quiet line: m:ss, and h:mm:ss after one hour (spec 005). */
export const formatClock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  const ss = String(total % 60).padStart(2, "0")
  const hours = Math.floor(total / 3600)
  if (hours === 0) return `${Math.floor(total / 60)}:${ss}`
  return `${hours}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${ss}`
}

/** One turn that is quiet now. `seconds` is the time on the quiet clock when this was sent. */
export interface QuietTurn {
  readonly taskId: string
  readonly workflowId: string
  /** The name of the model account, or of the vendor program (spec 006). */
  readonly name: string
  readonly seconds: number
}

// ---------------------------------------------------------------------------------------------
// The Tasks page (spec 005, "Tasks page").
// ---------------------------------------------------------------------------------------------

/** One row of the table of tasks. */
export interface TaskItem {
  readonly id: string
  readonly runId: string
  readonly workflowId: string
  readonly workflowName: string
  readonly nodeNumber: number
  readonly nodeName: string
  readonly kind: NodeKind
  /** The source of a task is the source of its run. */
  readonly source: RunSource
  readonly state: TaskState
  readonly reasonCode: string | null
  readonly reasonText: string | null
  /** For a queued task: the task of the same workflow that it waits behind, when there is one. */
  readonly behind: {
    readonly runId: string
    readonly runStartedAt: number
    readonly nodeNumber: number
    readonly nodeName: string
  } | null
  /** For a task that waits for a free slot: the number of slots now. */
  readonly slots: number | null
  readonly retryOf: string | null
  readonly progress: TaskProgress
  readonly createdAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  /** The quiet line of the turn now, or null. Not stored (spec 005, "Quiet line"). */
  readonly quiet: { readonly name: string; readonly seconds: number } | null
  /** True when "Run next" is on for this task: it is queued and not first yet. */
  readonly canRunNext: boolean
}

/** A moment of a task (spec 005, "Moments"). */
export interface TaskMoment {
  readonly kind: "given" | "started" | "ended" | "closed"
  readonly at: number
  /** For "ended": how the turn ended. */
  readonly how?: "done" | "failed" | "blocked" | "cancelled"
}

/** The three times of a task, in ms (spec 005, "Times"). Null: not known, shown as "—". */
export interface TaskTimes {
  readonly wait: number | null
  readonly firstReply: number | null
  readonly total: number | null
}

/** The view of one task. */
export interface TaskView extends TaskItem {
  readonly input: string
  readonly result: string
  readonly times: TaskTimes
  readonly moments: readonly TaskMoment[]
  readonly usage: TaskUsage
  readonly steps: number
  readonly keptGoing: number
  readonly runState: TaskState
  readonly runStartedAt: number
}

export interface TaskFilter {
  readonly state?: TaskState | undefined
  readonly workflowId?: string | undefined
  readonly source?: RunSource | undefined
}

/** Keeps the tasks that match every filter that is set. */
export const filterTasks = <T extends Pick<TaskItem, "state" | "workflowId" | "source">>(
  tasks: readonly T[],
  filter: TaskFilter,
): T[] =>
  tasks.filter(
    (t) =>
      (!filter.state || t.state === filter.state) &&
      (!filter.workflowId || t.workflowId === filter.workflowId) &&
      (!filter.source || t.source === filter.source),
  )

/** States in which a task can be stopped, and in which it can be tried again (spec 005). */
export const STOPPABLE: readonly TaskState[] = ["queued", "running", "waiting"]
export const RETRYABLE: readonly TaskState[] = ["failed", "blocked", "cancelled"]
export const isStoppable = (state: TaskState) => STOPPABLE.includes(state)
export const isRetryable = (state: TaskState) => RETRYABLE.includes(state)

/** How long a task ran, in ms. Null while it has not started. */
export const taskDuration = (
  task: Pick<TaskItem, "startedAt" | "finishedAt">,
  now: number = Date.now(),
) => (task.startedAt === null ? null : Math.max(0, (task.finishedAt ?? now) - task.startedAt))

/**
 * The three times of a task. A time is never made up: what was not seen stays null. A task that
 * the app stopped ("The app stopped") has no known end, so its total is null.
 */
export const taskTimes = (task: {
  readonly state: TaskState
  readonly reasonCode: string | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly firstReplyAt: number | null
  readonly finishedAt: number | null
}): TaskTimes => {
  const span = (end: number | null) => (end === null ? null : Math.max(0, end - task.createdAt))
  const ended = ["done", "failed", "blocked", "cancelled"].includes(task.state)
  const unseen = task.reasonCode === "restart"
  return {
    wait: span(task.startedAt),
    firstReply: span(task.firstReplyAt),
    total: ended && !unseen ? span(task.finishedAt) : null,
  }
}

/**
 * The moments of a task (spec 005, "Moments"): Given, Started, Ended, Closed. A moment that did
 * not happen does not show. A task that the app stopped has no known end of the turn.
 */
export const taskMoments = (task: {
  readonly createdAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly endedAs: string | null
  readonly finishedAt: number | null
}): TaskMoment[] => {
  const moments: TaskMoment[] = [{ kind: "given", at: task.createdAt }]
  if (task.startedAt !== null) moments.push({ kind: "started", at: task.startedAt })
  const how = task.endedAs
  if (
    task.endedAt !== null &&
    (how === "done" || how === "failed" || how === "blocked" || how === "cancelled")
  )
    moments.push({ kind: "ended", at: task.endedAt, how })
  if (task.finishedAt !== null) moments.push({ kind: "closed", at: task.finishedAt })
  return moments
}

// ---------------------------------------------------------------------------------------------
// The retry note (spec 005, "Retry note").
// ---------------------------------------------------------------------------------------------

/** The note lists at most this many steps. */
export const RETRY_NOTE_STEPS = 5

/**
 * A step that may change things: a file write, a shell command, or a tool of a connection, with
 * the result Ran, Failed or Stopped. A step that failed or stopped may have run in part. A
 * refused step did not run.
 */
export const mayChange = (step: Pick<ActionLogEntry, "kind" | "access" | "result">): boolean => {
  if (step.result === "refused") return false
  if (step.kind === "shell" || step.kind === "connection") return true
  return step.kind === "file" && step.access === "write"
}

export interface RetryStep {
  readonly kind: "file" | "shell" | "connection"
  readonly target: string
  readonly result: "ran" | "failed" | "stopped"
}

export interface RetryNote {
  /** The name of the computer where the task ran, when the list is not here. Null: it is here. */
  readonly computer: string | null
  /** The steps that may have changed things, newest first. At most 5. */
  readonly steps: readonly RetryStep[]
  /** How many more steps exist than the list shows. */
  readonly more: number
}

/**
 * The note for a retry, from the steps of the first try (oldest first), or null when none of
 * them may have changed things and the retry starts at once.
 */
export const retryNote = (steps: readonly ActionLogEntry[]): RetryNote | null => {
  const changing = steps.filter(mayChange).reverse()
  if (changing.length === 0) return null
  return {
    computer: null,
    steps: changing.slice(0, RETRY_NOTE_STEPS).map((s) => ({
      kind: s.kind as RetryStep["kind"],
      target: s.target,
      result: s.result as RetryStep["result"],
    })),
    more: Math.max(0, changing.length - RETRY_NOTE_STEPS),
  }
}

/** What a retry request answers: the new try started, or the note that the user must read first. */
export type RetryResult =
  | { readonly started: true; readonly runId: string }
  | { readonly started: false; readonly note: RetryNote }
