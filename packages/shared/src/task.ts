import type { TaskUsage, TreeUsage } from "./taskUsage.ts"
import type { RecentPlace } from "./work.ts"

export const TASK_STATES = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const
export type TaskState = (typeof TASK_STATES)[number]

/**
 * Where a task came from. "agent" is a message of another agent (spec 007). "handover" is the
 * message that starts a handover of a chat (spec 003, "Hand over"): its depth is 0. "teams" is a
 * message from Teams to the direct chat of an agent (spec 028): its depth is 0, and it is a normal
 * source in the queue (spec 005). "memory_check" is the short turn that finds facts that an agent
 * did not save (spec 008): its depth is 0, it posts no message, and it is last in the queue.
 * "follow_up" is the turn that an agent asked for
 * itself to look at one thing again later (spec 005, "Follow-up"): its depth is 0, and it is a
 * background source. "mention" is a name in a direct chat (spec 003): its depth is 0, its source
 * id is the chat's own agent, and the user reads the reply in that chat.
 */
export const TASK_SOURCES = [
  "chat",
  "routine",
  "workflow",
  "agent",
  "handover",
  "teams",
  "memory_check",
  "follow_up",
  "mention",
] as const
export type TaskSource = (typeof TASK_SOURCES)[number]

/**
 * What a message from another agent was (spec 029): "send" is the tool "send message", "reply" is
 * the answer that comes back to the sender. Only a task with the source "agent" has one.
 */
export const AGENT_MESSAGE_KINDS = ["send", "reply"] as const
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number]

/**
 * The queue of an agent holds at most this many queued tasks (spec 005, "Queue"). A task that
 * waits for the user or for a task that it gave out does not count.
 */
export const TASKS_QUEUED_MAX = 20

/**
 * The rank of a task that waits in the queue (spec 005, "Queue"): a lower rank starts first. 0 is a
 * task that went on after a wait and needs a slot again, 1 a pick of "Run next", 2 a normal source,
 * 3 a background source and 4 a memory check.
 */
export const queueRank = (source: TaskSource, picked: boolean): 1 | 2 | 3 | 4 =>
  picked
    ? 1
    : source === "memory_check"
      ? 4
      : source === "routine" || source === "workflow" || source === "follow_up"
        ? 3
        : 2

/** States in which a task can still be stopped (spec 005). */
export const ACTIVE_STATES: readonly TaskState[] = ["queued", "running", "waiting"]
export const isActive = (state: TaskState) => ACTIVE_STATES.includes(state)

/** States that a task never leaves by itself (spec 005). */
export const FINAL_STATES: readonly TaskState[] = ["done", "failed", "blocked", "cancelled"]
export const isFinal = (state: TaskState) => FINAL_STATES.includes(state)

/** A blocked task counts as a failed one for routines, workflows and notices (spec 005). */
export const isFailure = (state: TaskState) => state === "failed" || state === "blocked"

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
 * Told to the agent of a task that comes from a message of another agent, a routine or a workflow
 * (spec 005). A task of a direct chat gets no such text, because the user
 * reads the reply there.
 */
export const BLOCKED_RULE =
  'If you could not do the work, end your reply with a last line that starts with "Blocked:" and gives the reason in one sentence. Write that line in no other case.'

/** True when a task of this source gets the rule of "Blocked" in its instructions. */
export const toldAboutBlocked = (task: Pick<Task, "source">) =>
  task.source === "agent" || task.source === "routine" || task.source === "workflow"

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

/**
 * The end of a turn that ended with no error (spec 005). A turn with an error is Failed and a turn
 * that the user stopped is Cancelled, so neither comes here.
 */
export const endOfTurn = (replyText: string): TurnEnd => {
  const reason = blockedReason(replyText)
  return reason !== null ? { state: "blocked", reason } : { state: "done" }
}

/** The error that a blocked task keeps. */
export const blockedError = (reason: string) =>
  reason === "" ? { code: BLOCKED_EMPTY_CODE, detail: "" } : { code: BLOCKED_CODE, detail: reason }

/** True when this error is the one that `blockedError` makes. */
export const isBlockedError = (error: { readonly code: string } | null) =>
  error !== null && (error.code === BLOCKED_CODE || error.code === BLOCKED_EMPTY_CODE)

/** How a turn ended (spec 005, "Moments"): the state that the end gave the task. */
export const ENDED_AS = ["done", "failed", "blocked", "cancelled"] as const
export type EndedAs = (typeof ENDED_AS)[number]
export const isEndedAs = (value: unknown): value is EndedAs =>
  typeof value === "string" && (ENDED_AS as readonly string[]).includes(value)

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
  /** The chat agent that the task came from. */
  readonly sourceId: string | null
  readonly parentId: string | null
  /** The earlier task that this one tries again. */
  readonly retryOf: string | null
  /** The message that started the task, or holds its reply. */
  readonly messageId: string | null
  /**
   * The thread of a chat task that is not the main thread (spec 003). A linked device cannot open
   * it in this version (011, 012).
   */
  readonly threadId?: string
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
  /**
   * For a queued task of this computer: what it waits behind (spec 005, "Tasks page"), the work of
   * its agent or a free slot. Absent or null when nothing is known.
   */
  readonly behind?: RecentPlace | null
  /** How far the turn went. Null for a task from before the app kept it (spec 005). */
  readonly progress: TaskProgress | null
  /**
   * When the turn of the task ended, and how (spec 005, "Moments"). Null while the turn goes on,
   * for a task that never started, and for a task that the app stopped (the real time is not
   * known).
   */
  readonly endedAt: number | null
  readonly endedAs: EndedAs | null
  /**
   * What the turns of this task used, as the provider reports it (spec 005, "Usage of a task"). A
   * number that the provider did not report is null. It holds no text of a message.
   */
  readonly usage: TaskUsage
  /**
   * The token limit of the run, for the first task of a run of a routine that has a limit (spec
   * 009). It is kept when the run starts, so a later edit of the routine does not change it.
   */
  readonly tokenLimit: number | null
}

export interface TaskDetail {
  readonly task: Task
  /** Child tasks of every depth, oldest first. Each one names its parent. */
  readonly children: readonly Task[]
  /** The text of the reply, when there is one. Cut at 4000 characters. */
  readonly result: string
  /** The messages that the user sent into the turn of the task, oldest first (spec 003). */
  readonly joined: readonly { readonly text: string; readonly at: number }[]
  /**
   * The total of the task and the tasks below it, with one line for each agent. Null for a task
   * with no child task (spec 005, "Usage of a task").
   */
  readonly tree: TreeUsage | null
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
