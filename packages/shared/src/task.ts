import type { Verdict } from "./check.ts"

export const TASK_STATES = [
  "queued",
  "running",
  "waiting",
  "review",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const
export type TaskState = (typeof TASK_STATES)[number]

/** Where a task came from. "agent" is a message of another agent (spec 007). */
export const TASK_SOURCES = ["chat", "channel", "routine", "workflow", "agent"] as const
export type TaskSource = (typeof TASK_SOURCES)[number]

/** States in which a task can still be stopped. A task in review is not one of them (spec 005). */
export const ACTIVE_STATES: readonly TaskState[] = ["queued", "running", "waiting"]
export const isActive = (state: TaskState) => ACTIVE_STATES.includes(state)

/** States that a task never leaves by itself. "In review" is not one of them (spec 005). */
export const FINAL_STATES: readonly TaskState[] = ["done", "failed", "blocked", "cancelled"]
export const isFinal = (state: TaskState) => FINAL_STATES.includes(state)

/** A blocked task counts as a failed one for the lead, routines, workflows and notices (spec 005). */
export const isFailure = (state: TaskState) => state === "failed" || state === "blocked"

/**
 * True while the work of a request has not stopped: a part is queued, running, waiting, or in
 * review (spec 004). The summary of the lead waits while this holds, and so does the check.
 */
export const requestOpen = (states: readonly TaskState[]) =>
  states.some((s) => isActive(s) || s === "review")

// ---------------------------------------------------------------------------------------------
// Blocked (spec 005).
// ---------------------------------------------------------------------------------------------

/** The word at the start of the last line of a reply that could not do the work. */
export const BLOCKED_WORD = "Blocked:"

/** The reason of a blocked task is cut at this many characters. */
export const BLOCKED_REASON_MAX = 200

/**
 * The code that a blocked task keeps as its error, with the reason as the detail. A blocked task
 * whose last line gave no reason has its own code, so that the text is never empty.
 */
export const BLOCKED_CODE = "blocked"
export const BLOCKED_EMPTY_CODE = "blocked_empty"

/**
 * Told to the agent of a task that comes from a part of a plan, a message of another agent, a
 * routine or a workflow (spec 005). A task of a direct chat gets no such text, because the user
 * reads the reply there.
 */
export const BLOCKED_RULE =
  'If you could not do the work, end your reply with a last line that starts with "Blocked:" and gives the reason in one sentence. Write that line in no other case.'

/** True when a task of this source gets the rule of "Blocked" in its instructions. */
export const toldAboutBlocked = (task: Pick<Task, "source" | "parentId">) =>
  task.source === "agent" ||
  task.source === "routine" ||
  task.source === "workflow" ||
  (task.source === "channel" && task.parentId !== null)

/**
 * Reads the last line of a reply that has text. When it starts with "Blocked:" in any letter
 * case, the reason is the text after the colon, with the spaces at both ends removed, cut at 200
 * characters. Gives null when the reply is not blocked, and "" when the line gave no reason.
 */
export const blockedReason = (text: string): string | null => {
  const last = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line !== "")
  if (last === undefined || last.slice(0, BLOCKED_WORD.length).toLowerCase() !== "blocked:")
    return null
  const reason = last.slice(BLOCKED_WORD.length).trim()
  return [...reason].length > BLOCKED_REASON_MAX
    ? [...reason].slice(0, BLOCKED_REASON_MAX).join("")
    : reason
}

/** How a turn that ended with no error and was not stopped ends the task. */
export type TurnEnd =
  | { readonly state: "done" }
  | { readonly state: "blocked"; readonly reason: string }
  | { readonly state: "review" }

/**
 * The end of a turn that ended with no error (spec 005). A turn with an error is Failed and a turn
 * that the user stopped is Cancelled, so neither comes here. A "Blocked:" line beats review: a part
 * that could not do the work is not offered for review.
 */
export const endOfTurn = (replyText: string, options: { readonly review: boolean }): TurnEnd => {
  const reason = blockedReason(replyText)
  if (reason !== null) return { state: "blocked", reason }
  return options.review ? { state: "review" } : { state: "done" }
}

/** The error that a blocked task keeps. */
export const blockedError = (reason: string) =>
  reason === "" ? { code: BLOCKED_EMPTY_CODE, detail: "" } : { code: BLOCKED_CODE, detail: reason }

/** True when this error is the one that `blockedError` makes. */
export const isBlockedError = (error: { readonly code: string } | null) =>
  error !== null && (error.code === BLOCKED_CODE || error.code === BLOCKED_EMPTY_CODE)

// ---------------------------------------------------------------------------------------------
// Review (spec 004, 005).
// ---------------------------------------------------------------------------------------------

/** "Request changes" takes a text of 1 to 2000 characters. */
export const REVIEW_CHANGES_MAX = 2000

/** True when the text of "Request changes" is allowed. */
export const validChanges = (text: string) => {
  const length = [...text.trim()].length
  return length >= 1 && length <= REVIEW_CHANGES_MAX
}

/** The label of the part that "Request changes" starts: the old label with a prefix, cut at 48. */
export const CHANGES_PREFIX = "Changes: "
export const changesLabel = (label: string, max = 48) => {
  const full = [...`${CHANGES_PREFIX}${label}`]
  return full.length > max ? `${full.slice(0, max - 1).join("")}…` : full.join("")
}

export const TASK_LABEL_MAX = 60

/**
 * How far the turn of a task went (spec 005). It only goes up. `not_sent`: the request has not
 * been given to the model or to the program of the vendor. `sent`: it was given and nothing came
 * back. `started`: something came back.
 */
export const TASK_PROGRESS = ["not_sent", "sent", "started"] as const
export type TaskProgress = (typeof TASK_PROGRESS)[number]
export const isTaskProgress = (value: unknown): value is TaskProgress =>
  typeof value === "string" && (TASK_PROGRESS as readonly string[]).includes(value)

/** The higher of two progress values. A value that is not known counts as the lowest. */
export const raiseProgress = (
  current: TaskProgress | null | undefined,
  next: TaskProgress,
): TaskProgress =>
  TASK_PROGRESS.indexOf(next) > TASK_PROGRESS.indexOf(current ?? "not_sent")
    ? next
    : (current ?? next)

/** The error code of a task that the app ended because the silent limit was reached (spec 005). */
export const SILENT_CODE = "silent_limit"
/** The same for a limit of one minute, which reads in the singular. */
export const SILENT_CODE_ONE = "silent_limit_1"
/** The code and the detail of the failure for a silent limit of this many minutes. */
export const silentFailure = (minutes: number) =>
  minutes === 1
    ? { code: SILENT_CODE_ONE, detail: "1" }
    : { code: SILENT_CODE, detail: String(minutes) }

export interface Task {
  readonly id: string
  readonly agentId: string
  readonly agentName: string
  readonly prompt: string
  /** A short name for lists. */
  readonly label: string
  readonly source: TaskSource
  /** The chat agent or channel that the task came from. */
  readonly sourceId: string | null
  readonly parentId: string | null
  /** The earlier task that this one tries again. */
  readonly retryOf: string | null
  /** The message that started the task, or holds its reply. */
  readonly messageId: string | null
  readonly state: TaskState
  readonly error: { readonly code: string; readonly detail: string } | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  /**
   * When the message that started the task was sent. Null when no message started it (a routine,
   * a workflow, a part of a plan, a retry): its times count from `createdAt` (spec 005).
   */
  readonly askedAt: number | null
  /** When the first part of the reply that the user can see was stored. Null until then. */
  readonly firstReplyAt: number | null
  /** The name of the other computer where the task ran, when it came by sync (019). Null here. */
  readonly originName: string | null
  /** The name of the other computer whose task of this agent runs now, while this one waits. */
  readonly waitsFor: string | null
  /** How far the turn went. Null for a task from before the app kept it (spec 005). */
  readonly progress: TaskProgress | null
  /**
   * What a finished part must hold: one line, up to 200 characters, written by the lead in the
   * plan (spec 004, 005). Null for a task that has none.
   */
  readonly doneTest: string | null
  /** The verdict of the lead after the check: "met" or "not_met". Not a state (spec 005). */
  readonly verdict: Verdict | null
  /** The reason of a verdict "not_met", up to 160 characters. Null for "met" and for no reason. */
  readonly verdictReason: string | null
  /** When the lead gave the verdict. Null until then. */
  readonly judgedAt: number | null
  /** When the user decided on the part (accept, request changes). Null when not (spec 004). */
  readonly decidedAt: number | null
}

export interface TaskDetail {
  readonly task: Task
  /** Child tasks of every depth, oldest first. Each one names its parent. */
  readonly children: readonly Task[]
  /** The text of the reply, when there is one. Cut at 4000 characters. */
  readonly result: string
  /** The messages that the user sent into the turn of the task, oldest first (spec 003). */
  readonly joined: readonly { readonly text: string; readonly at: number }[]
}

/** One line of a prompt, cut to a label. */
export const taskLabel = (prompt: string) => {
  const line =
    prompt
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  return [...line].length > TASK_LABEL_MAX
    ? `${[...line].slice(0, TASK_LABEL_MAX - 1).join("")}…`
    : line
}

export interface TaskFilter {
  readonly state?: TaskState | undefined
  readonly agentId?: string | undefined
  readonly source?: TaskSource | undefined
  readonly query?: string | undefined
  /** `here` keeps the tasks of this computer. A name keeps the tasks of that other computer. */
  readonly computer?: "here" | { readonly name: string } | undefined
}

/** Keeps tasks that match every set filter. The query matches the label, ignoring case. */
export const filterTasks = (tasks: readonly Task[], filter: TaskFilter) => {
  const q = filter.query?.trim().toLocaleLowerCase()
  return tasks.filter(
    (t) =>
      (!filter.state || t.state === filter.state) &&
      (!filter.agentId || t.agentId === filter.agentId) &&
      (!filter.source || t.source === filter.source) &&
      (!filter.computer ||
        (filter.computer === "here"
          ? t.originName === null
          : t.originName === filter.computer.name)) &&
      (!q || t.label.toLocaleLowerCase().includes(q)),
  )
}

/** How long a task ran, in ms. Null while it has not started. */
export const taskDuration = (task: Pick<Task, "startedAt" | "finishedAt">, now = Date.now()) =>
  task.startedAt === null ? null : Math.max(0, (task.finishedAt ?? now) - task.startedAt)

/** The three times of a task in ms (spec 005). Null when a time is not known. */
export interface TaskTimes {
  readonly wait: number | null
  readonly firstReply: number | null
  readonly total: number | null
}

/** An end that the app did not see: the real end time is not known. */
const UNSEEN_ENDS = new Set(["app_stopped"])

/** The three times of a task. A time is never made up: what was not seen stays null. */
export const taskTimes = (
  task: Pick<
    Task,
    "state" | "error" | "createdAt" | "startedAt" | "finishedAt" | "askedAt" | "firstReplyAt"
  >,
): TaskTimes => {
  const from = task.askedAt ?? task.createdAt
  const span = (end: number | null, start: number) =>
    end === null ? null : Math.max(0, end - start)
  const ended = isFinal(task.state) && !(task.error && UNSEEN_ENDS.has(task.error.code))
  return {
    wait: span(task.startedAt, task.createdAt),
    firstReply: span(task.firstReplyAt, from),
    total: ended ? span(task.finishedAt, from) : null,
  }
}

/**
 * True when the parts hold something the user sees as a reply: text, or a card that asks the user.
 * Thinking, the working line and tool cards do not count (spec 005).
 */
export const hasVisibleReply = (
  parts: readonly { readonly kind: string; readonly text?: unknown; readonly ask?: unknown }[],
) =>
  parts.some(
    (p) =>
      (p.kind === "text" && typeof p.text === "string" && p.text.trim() !== "") ||
      (p.kind === "tool" && p.ask !== undefined),
  )

/** The median of a list of numbers. Null for an empty list. */
export const median = (values: readonly number[]) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Orders tasks as a tree: each task comes right after its parent. */
export const taskTree = (tasks: readonly Task[], rootId: string) => {
  const out: { task: Task; depth: number }[] = []
  const visit = (parentId: string, depth: number) => {
    for (const task of tasks.filter((t) => t.parentId === parentId)) {
      out.push({ task, depth })
      visit(task.id, depth + 1)
    }
  }
  visit(rootId, 0)
  return out
}
