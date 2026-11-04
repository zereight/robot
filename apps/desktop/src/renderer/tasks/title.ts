import type { MessageKey, MessageParams, Task } from "@robot/shared"

/**
 * The words that a window shows as the label of a task. The label of a memory check is stored once
 * and has no language, so a window shows its own words for it (spec 008). The label of the look of
 * an agent on the line holds the name of the channel only, so a window adds its own words to it
 * (spec 030: "Question from <channel>"). Any other label is text of the user or of the app and is
 * shown as it is.
 */
export const taskTitle = (
  task: Pick<Task, "label" | "source">,
  t: (key: MessageKey, params?: MessageParams) => string,
): string =>
  task.source === "memory_check"
    ? t("tasks.source.memory_check")
    : task.source === "question"
      ? t("tasks.source.questionFrom", { channel: task.label })
      : task.label

/**
 * The words for the source of a task. The source of the look of an agent on the line names its
 * channel: "Question from <channel>" (spec 030). Any other source has its own words.
 */
export const sourceWords = (
  task: Pick<Task, "label" | "source">,
  t: (key: MessageKey, params?: MessageParams) => string,
): string =>
  task.source === "question"
    ? t("tasks.source.questionFrom", { channel: task.label })
    : t(`tasks.source.${task.source}` as MessageKey)
