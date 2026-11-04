import { type Agent, isActive, type Task } from "@robot/shared"
import { X } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { formatElapsed } from "../chat/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { TaskStateText } from "../tasks/TaskStateText.tsx"
import { taskTitle } from "../tasks/title.ts"
import { IconButton } from "../ui/controls.tsx"
import { motionMs } from "../ui/Presence.tsx"
import styles from "./activity.module.css"

interface Shown {
  readonly task: Task
  readonly leaving: boolean
}

/**
 * The activity panel of a direct chat: what this agent does now. A card comes in when a task
 * starts and leaves when it ends. The clock shows the time of the task, in figures of one width.
 */
export const AgentActivity = (props: { agent: Agent }) => {
  const { t } = useApp()
  const ui = useUi()
  const [tasks, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("tasks.list", { serverId }),
  )
  onCleanup(window.robot.on("tasks.changed", () => void refetch()))

  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clock))

  const active = createMemo(() =>
    (tasks() ?? []).filter((task) => task.agentId === props.agent.id && isActive(task.state)),
  )

  // Cards stay a short while after their task ends, so the exit motion can play.
  const [shown, setShown] = createStore<{ list: Shown[] }>({ list: [] })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  onCleanup(() => {
    for (const timer of timers) clearTimeout(timer)
  })
  createEffect(() => {
    const current = active()
    const ids = new Set(current.map((task) => task.id))
    const kept = shown.list.filter((s) => !ids.has(s.task.id))
    const ms = motionMs("fast")
    const leaving = kept.map((s) => ({ task: s.task, leaving: ms > 0 }))
    const next: Shown[] = [
      ...current.map((task) => ({ task, leaving: false })),
      ...(ms > 0 ? leaving : []),
    ]
    setShown("list", reconcile(next, { key: "task.id" as never, merge: true }))
    if (ms > 0 && kept.length > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        setShown("list", (list) => list.filter((s) => !s.leaving))
      }, ms + 40)
      timers.add(timer)
    }
  })

  return (
    <div class={styles.activity} data-testid="agent-activity">
      <Show when={shown.list.length > 0} fallback={<p class={styles.empty}>{t("panel.empty")}</p>}>
        <ul class={styles.list}>
          <For each={shown.list}>
            {(item) => (
              <li
                class={styles.card}
                data-state={item.task.state}
                data-leaving={item.leaving}
                data-testid="activity-task"
              >
                <span class={styles.label}>{taskTitle(item.task, t)}</span>
                <span class={styles.meta}>
                  <span class={styles.dot} aria-hidden="true" />
                  <span data-testid="activity-task-state">
                    <TaskStateText task={item.task} />
                  </span>
                  <Show when={item.task.startedAt !== null}>
                    <span class={styles.elapsed}>
                      {formatElapsed(now() - (item.task.startedAt ?? now()))}
                    </span>
                  </Show>
                  <span class={styles.spacer} />
                  <IconButton
                    label={t("tasks.stop")}
                    onClick={() => call("tasks.stop", { id: item.task.id })}
                    data-testid="activity-stop"
                  >
                    <X size={12} />
                  </IconButton>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
