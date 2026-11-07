import type { MessageKey, MessageParams, TaskItem, TaskState } from "@robot/shared"
import { formatDateTime } from "../chat/format.ts"
import { reasonText } from "../lib/runText.ts"

type T = (key: MessageKey, params?: MessageParams) => string

/** The word of a state of a task (spec 005, "States"). */
export const stateWord = (state: TaskState): MessageKey =>
  `workflows.run.state.${state}` as MessageKey

/**
 * Why a task is not running or done, in the words of spec 005, "States and reasons": a queued
 * task waits for a free slot or behind a node; a task that waits for the user waits for an
 * approval, an answer or a pick; a failed, blocked or cancelled task shows its reason.
 */
export const taskReason = (
  t: T,
  locale: "en" | "ko",
  task: Pick<TaskItem, "state" | "reasonCode" | "reasonText" | "behind" | "slots" | "progress">,
): string | null => {
  if (task.state === "queued") {
    if (task.behind)
      return t("tasks.reason.behind", {
        node: task.behind.nodeName,
        time: formatDateTime(locale, task.behind.runStartedAt),
      })
    if (task.reasonCode === "behind" && task.reasonText)
      return t("tasks.reason.behindNode", { node: task.reasonText })
    const count = task.slots ?? Number(task.reasonText)
    return t("tasks.reason.slot", { count: Number.isFinite(count) ? count : 0 })
  }
  if (task.state === "running" || task.state === "done") return null
  return reasonText(t, task.reasonCode, task.reasonText)
}

/** The line that beside Retry says how far the turn went (spec 005, "How far a turn went"). */
export const progressLine = (
  task: Pick<TaskItem, "state" | "reasonCode" | "progress">,
): MessageKey | null =>
  task.state === "failed" || task.state === "blocked"
    ? (`tasks.progress.${task.progress}` as MessageKey)
    : null
