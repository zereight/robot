import {
  type Agent,
  type MessageKey,
  type RecentWorkRow,
  recentReason,
  recentWords,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatSince } from "../chat/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { setOpenTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { taskTitle } from "../tasks/title.ts"
import { Button } from "../ui/controls.tsx"
import styles from "./agents.module.css"

/** How often the time since the last change is read again. */
const TICK_MS = 15_000

/**
 * The block "Recent work" of an agent profile (spec 002): the last 20 tasks of the agent, newest
 * first, with the state in words, and for a task that has not ended what it waits for. It changes
 * while the profile is open. It shows no thinking of the agent.
 */
export const RecentWork = (props: { agent: Agent; onNavigate: () => void }) => {
  const { t, locale } = useApp()
  const ui = useUi()
  const [rows, { refetch }] = createResource(
    () => props.agent.id,
    (agentId) => call("tasks.recent", { agentId }).catch((): readonly RecentWorkRow[] => []),
    { initialValue: [] as readonly RecentWorkRow[] },
  )
  onCleanup(window.robot.on("tasks.changed", () => void refetch()))
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(clock))

  const words = (row: RecentWorkRow) => {
    const { key, params } = recentWords(row)
    return t(key, params)
  }
  // A blocked task shows its reason after the word. A task with no reason shows none.
  const reason = (row: RecentWorkRow) => recentReason(row.task) || null
  const open = (row: RecentWorkRow) => {
    setOpenTarget({ kind: "task", id: row.task.id })
    ui.selectPage("tasks")
    props.onNavigate()
  }
  const showAll = () => {
    setOpenTarget({ kind: "agentTasks", id: props.agent.id })
    ui.selectPage("tasks")
    props.onNavigate()
  }

  return (
    <section class={styles.recent} data-testid="recent-work" aria-label={t("recent.title")}>
      <h3 class={styles.recentTitle}>{t("recent.title")}</h3>
      <Show
        when={rows().length > 0}
        fallback={
          <p class={styles.hint} data-testid="recent-empty">
            {t("recent.empty")}
          </p>
        }
      >
        <ul class={styles.recentList} data-testid="recent-list">
          <For each={rows()}>
            {(row) => (
              <li>
                <button
                  type="button"
                  class={styles.recentRow}
                  onClick={() => open(row)}
                  data-testid="recent-row"
                  data-state={row.task.state}
                >
                  <span class={styles.recentLabel} data-user-data data-testid="recent-label">
                    {taskTitle(row.task, t)}
                  </span>
                  <span class={styles.hint} data-testid="recent-source">
                    {t(`tasks.source.${row.task.source}` as MessageKey)}
                  </span>
                  <span class={styles.recentState} data-testid="recent-state">
                    {words(row)}
                  </span>
                  <Show when={reason(row)}>
                    {(text) => (
                      <span class={styles.hint} data-user-data data-testid="recent-reason">
                        {text()}
                      </span>
                    )}
                  </Show>
                  <span class={styles.hint} data-testid="recent-since">
                    {formatSince(locale(), row.changedAt, now())}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class={styles.actions}>
          <Button onClick={showAll} data-testid="recent-show-all">
            {t("recent.showAll")}
          </Button>
        </div>
      </Show>
    </section>
  )
}
