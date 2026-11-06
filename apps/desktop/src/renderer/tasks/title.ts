import type { MessageKey, MessageParams, Task } from "@robot/shared"

/**
 * The words that a window shows as the label of a task. The label of a memory check is stored once
 * and has no language, so a window shows its own words for it (spec 008). Any other label is text
 * of the user or of the app and is shown as it is.
 */
export const taskTitle = (
  task: Pick<Task, "label" | "source">,
  t: (key: MessageKey, params?: MessageParams) => string,
): string => (task.source === "memory_check" ? t("tasks.source.memory_check") : task.label)

/** The words for the source of a task. */
export const sourceWords = (
  task: Pick<Task, "source">,
  t: (key: MessageKey, params?: MessageParams) => string,
): string => t(`tasks.source.${task.source}` as MessageKey)
