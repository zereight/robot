import type { MessageKey, Task } from "@robot/shared"
import { Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { quietOfTaskLine } from "../state/quiet.ts"
import { useUi } from "../state/ui.tsx"

/**
 * The state of a task as text. While the turn of a running task is quiet, the quiet line replaces
 * "Running" (spec 005, "Quiet line"). The Tasks page and the activity panel of a direct chat use it.
 */
export const TaskStateText = (props: { task: Pick<Task, "id" | "state"> }) => {
  const { t } = useApp()
  const ui = useUi()
  const quiet = () =>
    props.task.state === "running"
      ? quietOfTaskLine(ui.linked() ? ui.server()?.id : undefined, props.task.id)
      : undefined
  return (
    <Show when={quiet()} fallback={t(`tasks.state.${props.task.state}` as MessageKey)}>
      {(q) => t("quiet.line", { name: q().name, time: q().time })}
    </Show>
  )
}
