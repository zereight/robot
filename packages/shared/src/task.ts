export const TASK_STATES = ["queued", "running", "waiting", "done", "failed", "cancelled"] as const
export type TaskState = (typeof TASK_STATES)[number]

export const TASK_SOURCES = ["chat", "channel", "routine", "workflow"] as const
export type TaskSource = (typeof TASK_SOURCES)[number]

/** States in which a task can still be stopped. */
export const ACTIVE_STATES: readonly TaskState[] = ["queued", "running", "waiting"]
export const isActive = (state: TaskState) => ACTIVE_STATES.includes(state)

export const TASK_LABEL_MAX = 60

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
  /** The name of the other computer where the task ran, when it came by sync (017). Null here. */
  readonly originName: string | null
  /** The name of the other computer whose task of this agent runs now, while this one waits. */
  readonly waitsFor: string | null
}

export interface TaskDetail {
  readonly task: Task
  /** Child tasks of every depth, oldest first. Each one names its parent. */
  readonly children: readonly Task[]
  /** The text of the reply, when there is one. Cut at 4000 characters. */
  readonly result: string
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
