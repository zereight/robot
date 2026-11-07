import {
  filterTasks,
  isRetryable,
  isStoppable,
  type MessageKey,
  RUN_SOURCES,
  TASK_STATES,
  type TaskFilter,
  type TaskItem,
  type TaskView,
  taskDuration,
} from "@robot/shared"
import { OctagonX } from "lucide-solid"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime, formatElapsed } from "../chat/format.ts"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { formatSeconds } from "../lib/seconds.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { quietOfTask } from "../state/quiet.ts"
import { openRun } from "../state/runTarget.ts"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { showToast } from "../ui/toast.ts"
import { useRetry } from "./RetryNote.tsx"
import styles from "./tasks.module.css"
import { progressLine, stateWord, taskReason } from "./taskText.ts"

const toastError = (e: unknown) => {
  const text = describeError(e)
  showToast("error", text.key, text.params)
}

/** The state of a task. A running task whose turn is quiet shows the quiet line (spec 005). */
const StateText = (props: { task: Pick<TaskItem, "id" | "state"> }) => {
  const { t } = useApp()
  const quiet = () => (props.task.state === "running" ? quietOfTask(props.task.id) : undefined)
  return (
    <span
      class={styles.state}
      data-state={props.task.state}
      data-quiet={quiet() ? "true" : undefined}
      data-testid="task-state"
    >
      <Show when={props.task.state === "blocked"}>
        <OctagonX size={12} aria-hidden="true" />
      </Show>
      <Show when={quiet()} fallback={t(stateWord(props.task.state))}>
        {(q) => <span data-testid="task-quiet">{t("tasks.quiet", q())}</span>}
      </Show>
    </span>
  )
}

const Reason = (props: { task: TaskItem; testid: string; class?: string | undefined }) => {
  const { t, locale } = useApp()
  const text = () => taskReason(t, locale(), props.task)
  return (
    <Show when={text()}>
      {(line) => (
        <div class={props.class} data-testid={props.testid} data-code={props.task.reasonCode ?? ""}>
          {line()}
        </div>
      )}
    </Show>
  )
}

const duration = (task: TaskItem) => {
  const ms = taskDuration(task)
  return ms === null ? "–" : formatElapsed(ms)
}

/** The three times of a task (spec 005). A time that is not known shows as a dash, never as 0. */
const TimesList = (props: { view: TaskView }) => {
  const { t, locale } = useApp()
  const rows = () =>
    [
      ["wait", "tasks.times.wait", props.view.times.wait],
      ["first-reply", "tasks.times.firstReply", props.view.times.firstReply],
      ["total", "tasks.times.total", props.view.times.total],
    ] as const
  return (
    <dl class={styles.times} data-testid="task-times">
      <For each={rows()}>
        {([id, label, ms]) => (
          <div>
            <dt>{t(label)}</dt>
            <dd data-testid={`task-time-${id}`} data-ms={ms ?? ""}>
              {ms === null
                ? t("time.unknown")
                : t("time.seconds", { value: formatSeconds(ms, locale()) })}
            </dd>
          </div>
        )}
      </For>
    </dl>
  )
}

/** The moments of a task with their clock times, in plain text (spec 005, "Moments"). */
const Moments = (props: { view: TaskView }) => {
  const { t, locale } = useApp()
  const text = (moment: TaskView["moments"][number]) => {
    switch (moment.kind) {
      case "given":
        return `${t("tasks.moment.given")} · ${t("tasks.moment.given.by", {
          time: formatDateTime(locale(), props.view.runStartedAt),
          source: t(`tasks.source.${props.view.source}` as MessageKey),
        })}`
      case "started":
        return t("tasks.moment.started")
      case "ended":
        return t("tasks.moment.ended", {
          how: t(stateWord(moment.how ?? "done")),
        })
      case "closed":
        return t("tasks.moment.closed")
    }
  }
  return (
    <ol class={styles.moments} data-testid="task-moments">
      <For each={props.view.moments}>
        {(moment) => (
          <li data-testid="task-moment" data-moment={moment.kind}>
            <time class={styles.time} data-at={moment.at}>
              {new Date(moment.at).toLocaleTimeString(locale())}
            </time>
            <span class={styles.text}>{text(moment)}</span>
          </li>
        )}
      </For>
    </ol>
  )
}

const Usage = (props: { view: TaskView }) => {
  const { t } = useApp()
  const u = () => props.view.usage
  const dash = () => t("time.unknown")
  const cachedShare = () =>
    u().cached !== null && u().input
      ? Math.round(((u().cached ?? 0) / (u().input ?? 1)) * 100)
      : null
  return (
    <>
      <h3>{t("tasks.usage")}</h3>
      <p class={styles.meta} data-testid="task-usage">
        {t("tasks.usage.line", { input: u().input ?? dash(), output: u().output ?? dash() })}
        <Show when={cachedShare() !== null}>
          {" · "}
          <span data-testid="task-usage-cached">
            {t("tasks.usage.cached", { percent: cachedShare() ?? 0 })}
          </span>
        </Show>
      </p>
    </>
  )
}

const TaskDetail = (props: { id: string; onClose: () => void; onChanged: () => void }) => {
  const { t, locale } = useApp()
  const ui = useUi()
  const retry = useRetry()
  const [view, { refetch }] = createResource(() => call("tasks.get", { taskId: props.id }))
  onCleanup(window.robot.on("runs.changed", () => void refetch()))
  const act = (run: () => Promise<unknown>) =>
    run()
      .then(() => {
        void refetch()
        props.onChanged()
      })
      .catch(toastError)
  const open = (v: TaskView) => {
    ui.selectPlace({ kind: "workflow", id: v.workflowId })
    openRun(v.workflowId, v.runId)
    props.onClose()
  }
  return (
    <Dialog label={t("tasks.detail.title")} onClose={props.onClose} testId="task-detail">
      {retry.dialog()}
      <Show when={view()}>
        {(v) => (
          <div class={styles.detail}>
            <div class={styles.body}>
              <h2 class={styles.title}>{v().workflowName}</h2>
              <p class={styles.meta}>
                {t("tasks.node", { number: v().nodeNumber, name: v().nodeName })} ·{" "}
                {t(`tasks.source.${v().source}` as MessageKey)} · <StateText task={v()} />
              </p>
              <p class={styles.meta}>
                {t("tasks.run", {
                  time: formatDateTime(locale(), v().runStartedAt),
                  source: t(`tasks.source.${v().source}` as MessageKey),
                })}
              </p>
              <Reason task={v()} testid="task-detail-reason" class={styles.meta} />
              <Show when={v().retryOf}>
                <p class={styles.meta}>{t("tasks.retryOf")}</p>
              </Show>
              <h3>{t("tasks.times")}</h3>
              <TimesList view={v()} />
              <h3>{t("tasks.moments")}</h3>
              <Moments view={v()} />
              <Usage view={v()} />
              <Show when={v().steps > 0}>
                <p class={styles.meta}>{t("tasks.steps", { count: v().steps })}</p>
              </Show>
              <Show when={v().input !== ""}>
                <h3>{t("tasks.input")}</h3>
                <pre class={styles.text} data-testid="task-input">
                  {v().input}
                </pre>
              </Show>
              <h3>{t("tasks.result")}</h3>
              <Show
                when={v().result !== ""}
                fallback={<p class={styles.meta}>{t("tasks.result.none")}</p>}
              >
                <pre class={styles.text} data-testid="task-result">
                  {v().result}
                </pre>
              </Show>
              <Show when={progressLine(v())}>
                {(key) => (
                  <p
                    class={styles.meta}
                    data-testid="task-progress-line"
                    data-progress={v().progress}
                  >
                    {t(key())}
                  </p>
                )}
              </Show>
            </div>
            <div class={styles.actions}>
              <Show when={isStoppable(v().state)}>
                <Button
                  onClick={() => void act(() => call("tasks.stop", { taskId: v().id }))}
                  data-testid="task-stop"
                >
                  {t("tasks.stop")}
                </Button>
              </Show>
              <Show when={v().canRunNext}>
                <Button
                  onClick={() => void act(() => call("tasks.runNext", { taskId: v().id }))}
                  data-testid="task-run-next"
                >
                  {t("tasks.runNext")}
                </Button>
              </Show>
              <Show when={isRetryable(v().state)}>
                <Button
                  onClick={() =>
                    void act(() =>
                      retry.start((confirmed) =>
                        call("tasks.retry", {
                          taskId: v().id,
                          ...(confirmed ? { confirmed } : {}),
                        }),
                      ),
                    )
                  }
                  data-testid="task-retry"
                >
                  {t("tasks.retry")}
                </Button>
              </Show>
              <Button onClick={() => open(v())} data-testid="task-open-run">
                {t("tasks.openRun")}
              </Button>
              <span class={styles.spacer} />
              <Button variant="primary" onClick={props.onClose}>
                {t("tasks.detail.close")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  )
}

const FilterSelect = (props: {
  label: string
  testId: string
  value: string
  onChange: (value: string) => void
  children: import("solid-js").JSX.Element
}) => {
  const { t } = useApp()
  return (
    <label class={styles.filter}>
      <span>{props.label}</span>
      <select
        class={styles.select}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        data-testid={props.testId}
      >
        <option value="">{t("tasks.filter.all")}</option>
        {props.children}
      </select>
    </label>
  )
}

const TasksTab = () => {
  const { t } = useApp()
  const [filter, setFilter] = createSignal<TaskFilter>({})
  const [openId, setOpenId] = createSignal<string>()
  const [tasks, { refetch }] = createResource(
    () => true,
    () => call("tasks.list", undefined).catch(() => [] as readonly TaskItem[]),
    { initialValue: [] },
  )
  // A run changes often while it streams: read the table again at most every 200 ms.
  let timer: ReturnType<typeof setTimeout> | undefined
  const soon = () => {
    timer ??= setTimeout(() => {
      timer = undefined
      void refetch()
    }, 200)
  }
  onCleanup(window.robot.on("runs.changed", soon))
  onCleanup(() => timer && clearTimeout(timer))
  const shown = createMemo(() => filterTasks(tasks(), filter()))
  const workflows = createMemo(() => {
    const seen = new Map<string, string>()
    for (const task of tasks()) seen.set(task.workflowId, task.workflowName)
    return [...seen]
  })
  const set = <K extends keyof TaskFilter>(key: K, value: string) =>
    setFilter({ ...filter(), [key]: value === "" ? undefined : value })
  return (
    <div class={styles.body} data-testid="tasks-tab-body">
      <div class={styles.filters}>
        <FilterSelect
          label={t("tasks.filter.state")}
          testId="tasks-filter-state"
          value={filter().state ?? ""}
          onChange={(v) => set("state", v)}
        >
          <For each={TASK_STATES}>{(s) => <option value={s}>{t(stateWord(s))}</option>}</For>
        </FilterSelect>
        <FilterSelect
          label={t("tasks.filter.workflow")}
          testId="tasks-filter-workflow"
          value={filter().workflowId ?? ""}
          onChange={(v) => set("workflowId", v)}
        >
          <For each={workflows()}>{([id, name]) => <option value={id}>{name}</option>}</For>
        </FilterSelect>
        <FilterSelect
          label={t("tasks.filter.source")}
          testId="tasks-filter-source"
          value={filter().source ?? ""}
          onChange={(v) => set("source", v)}
        >
          <For each={RUN_SOURCES}>
            {(s) => <option value={s}>{t(`tasks.source.${s}` as MessageKey)}</option>}
          </For>
        </FilterSelect>
      </div>
      <Show
        when={tasks().length > 0}
        fallback={
          <p class={styles.muted} data-testid="tasks-empty">
            {t("tasks.empty")}
          </p>
        }
      >
        <Show
          when={shown().length > 0}
          fallback={
            <p class={styles.muted} data-testid="tasks-no-match">
              {t("tasks.noMatch")}
            </p>
          }
        >
          <table class={styles.table} data-testid="tasks-table">
            <thead>
              <tr>
                <th scope="col">{t("tasks.col.workflow")}</th>
                <th scope="col">{t("tasks.col.node")}</th>
                <th scope="col">{t("tasks.col.source")}</th>
                <th scope="col">{t("tasks.col.state")}</th>
                <th scope="col" class={styles.num}>
                  {t("tasks.col.duration")}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()}>
                {(task) => (
                  <tr data-testid="task-row" data-state={task.state} data-id={task.id}>
                    <td>{task.workflowName}</td>
                    <th scope="row">
                      <button
                        type="button"
                        class={styles.rowButton}
                        onClick={() => setOpenId(task.id)}
                        data-testid="task-open"
                      >
                        {t("tasks.node", { number: task.nodeNumber, name: task.nodeName })}
                      </button>
                    </th>
                    <td data-testid="task-source">
                      {t(`tasks.source.${task.source}` as MessageKey)}
                    </td>
                    <td>
                      <StateText task={task} />
                      <Reason task={task} testid="task-reason" class={styles.muted} />
                      <Show when={task.canRunNext}>
                        <button
                          type="button"
                          class={styles.rowButton}
                          onClick={() =>
                            void call("tasks.runNext", { taskId: task.id }).catch(toastError)
                          }
                          data-testid="task-run-next"
                        >
                          {t("tasks.runNext")}
                        </button>
                      </Show>
                    </td>
                    <td class={styles.num}>{duration(task)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>
      <Presence when={openId()}>
        {(id) => (
          <TaskDetail
            id={id}
            onClose={() => setOpenId(undefined)}
            onChanged={() => void refetch()}
          />
        )}
      </Presence>
    </div>
  )
}

/**
 * The events of this computer (spec 038). The list of events is not built yet (a later slice, see
 * docs/spec-questions.md, B2): the tab shows its empty line.
 */
const EventsTab = () => {
  const { t } = useApp()
  return (
    <div class={styles.body} data-testid="events-tab-body">
      <h2 class={styles.title}>{t("events.title")}</h2>
      <p class={styles.muted} data-testid="events-empty">
        {t("events.empty")}
      </p>
    </div>
  )
}

/** The page "Tasks": two tabs at the top of the header line, "Tasks" and "Events" (spec 005, 038). */
export const TasksPage = () => {
  const { t } = useApp()
  const ui = useUi()
  const tab = () => ui.ui.tasksTab
  const pick = ui.selectTasksTab
  const tabs = ["tasks", "events"] as const
  return (
    <>
      <header class={shell.header} data-testid="tasks-header">
        <div class={styles.tabs} role="tablist" aria-label={t("tasks.tabs")}>
          <For each={tabs}>
            {(name) => (
              <button
                type="button"
                role="tab"
                class={styles.tab}
                aria-selected={tab() === name}
                data-selected={tab() === name}
                onClick={() => pick(name)}
                data-testid={`${name}-tab`}
              >
                {t(`tasks.tab.${name}` as MessageKey)}
              </button>
            )}
          </For>
        </div>
      </header>
      <div class={`${shell.page} ${styles.page}`} data-testid="tasks-page">
        <Show when={tab() === "events"} fallback={<TasksTab />}>
          <EventsTab />
        </Show>
      </div>
    </>
  )
}
