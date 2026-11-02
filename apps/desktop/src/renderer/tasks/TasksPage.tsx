import {
  catalogues,
  filterTasks,
  isActive,
  type MessageKey,
  TASK_SOURCES,
  TASK_STATES,
  type Task,
  type TaskFilter,
  taskDuration,
  taskTree,
} from "@robot/shared"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { formatElapsed, formatTime } from "../chat/format.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { openTarget, takeTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./tasks.module.css"

// A reason with no text of its own shows the general error text.
const catalogueKeys = catalogues.en

const reasonKey = (task: Task): MessageKey =>
  task.error && `error.${task.error.code}` in catalogueKeys
    ? (`error.${task.error.code}` as MessageKey)
    : "error.unknown"

const duration = (task: Task) => {
  const ms = taskDuration(task)
  return ms === null ? "–" : formatElapsed(ms)
}

const TaskDetailDialog = (props: { id: string; onClose: () => void }) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [error, setError] = createSignal<ErrorText>()
  const [detail, { refetch }] = createResource(() => call("tasks.get", { id: props.id }))
  onCleanup(window.robot.on("tasks.changed", () => void refetch()))
  const act = async (run: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    }
  }
  const openSource = (task: Task) => {
    if (!task.sourceId || (task.source !== "chat" && task.source !== "channel")) return
    ui.selectPlace({ kind: task.source === "chat" ? "agent" : "channel", id: task.sourceId })
    props.onClose()
  }
  return (
    <Dialog label={t("tasks.detail.title")} onClose={props.onClose} testId="task-detail">
      <Show when={detail()}>
        {(d) => (
          <div class={styles.detail}>
            <h2 class={styles.title}>{d().task.label}</h2>
            <p class={styles.meta}>
              {d().task.agentName} · {t(`tasks.source.${d().task.source}` as MessageKey)} ·{" "}
              <span data-testid="task-detail-state" data-state={d().task.state}>
                {t(`tasks.state.${d().task.state}` as MessageKey)}
              </span>
            </p>
            <Show when={d().task.originName !== null}>
              <p class={styles.meta} data-testid="task-detail-computer">
                {t("tasks.detail.computer", {
                  name: d().task.originName || t("sync.anotherComputer"),
                })}
              </p>
            </Show>
            <Show when={d().task.waitsFor}>
              {(name) => (
                <p class={styles.meta} data-testid="task-detail-waits">
                  {t("tasks.waitsFor", { name: name() })}
                </p>
              )}
            </Show>
            <Show when={d().task.retryOf}>
              <p class={styles.meta}>{t("tasks.retryOf")}</p>
            </Show>
            <h3>{t("tasks.prompt")}</h3>
            <pre class={styles.text}>{d().task.prompt}</pre>
            <Show when={d().joined.length > 0}>
              <h3>{t("tasks.joined")}</h3>
              <ul class={styles.joined} data-testid="task-joined">
                <For each={d().joined}>
                  {(message) => (
                    <li data-testid="task-joined-item">
                      <time class={styles.joinedTime}>{formatTime(app.locale(), message.at)}</time>
                      <span class={styles.text}>{message.text}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={d().result}>
              <h3>{t("tasks.result")}</h3>
              <pre class={styles.text} data-testid="task-result">
                {d().result}
              </pre>
            </Show>
            <Show when={d().task.error}>
              {(e) => (
                <>
                  <h3>{t("tasks.error")}</h3>
                  <p class={styles.errorText} data-testid="task-error">
                    {t(reasonKey(d().task), { detail: e().detail })}
                  </p>
                </>
              )}
            </Show>
            <Show when={d().children.length > 0}>
              <h3>{t("tasks.children")}</h3>
              <ul class={styles.tree} data-testid="task-children">
                <For each={taskTree([d().task, ...d().children], d().task.id)}>
                  {(node) => (
                    <li style={{ "padding-left": `${node.depth * 16}px` }}>
                      <span data-state={node.task.state} class={styles.state}>
                        {t(`tasks.state.${node.task.state}` as MessageKey)}
                      </span>{" "}
                      {node.task.agentName}: {node.task.label}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={error()}>
              {(err) => <p class={styles.errorText}>{t(err().key, err().params)}</p>}
            </Show>
            <div class={styles.actions}>
              <Show when={isActive(d().task.state)}>
                <Button
                  onClick={() => act(() => call("tasks.stop", { id: d().task.id }))}
                  data-testid="task-stop"
                >
                  {t("tasks.stop")}
                </Button>
              </Show>
              <Show
                when={
                  !ui.linked() && (d().task.state === "failed" || d().task.state === "cancelled")
                }
              >
                <Button
                  onClick={() => act(() => call("tasks.retry", { id: d().task.id }))}
                  data-testid="task-retry"
                >
                  {t("tasks.retry")}
                </Button>
              </Show>
              <Show when={d().task.sourceId && ["chat", "channel"].includes(d().task.source)}>
                <Button onClick={() => openSource(d().task)} data-testid="task-open-source">
                  {t("tasks.openSource")}
                </Button>
              </Show>
              <span class={styles.spacer} />
              <Button variant="primary" onClick={props.onClose}>
                {t("tasks.close")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  )
}

export const TasksPage = () => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const devices = useDevices()
  const [filter, setFilter] = createSignal<TaskFilter>({})
  const [openId, setOpenId] = createSignal<string>()
  // The Today page asks for a task: its detail opens at once.
  createEffect(() => {
    if (openTarget()?.kind !== "task") return
    const target = takeTarget("task")
    if (target) setOpenId(target.id)
  })
  const [tasks, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("tasks.list", { serverId }).catch(() => []),
    { initialValue: [] },
  )
  onCleanup(
    window.robot.on("tasks.changed", ({ serverId }) => {
      if (serverId === ui.server()?.id) void refetch()
    }),
  )
  const shown = createMemo(() => filterTasks(tasks(), filter()))
  /** The names of the other computers that ran tasks. They show when this computer syncs. */
  const computers = createMemo(() => [
    ...new Set(tasks().flatMap((task) => (task.originName === null ? [] : [task.originName]))),
  ])
  const showComputers = () => computers().length > 0 || devices.sync.active() !== undefined
  const computerOf = (task: Task) =>
    task.originName === null
      ? t("tasks.computer.here")
      : task.originName || t("sync.anotherComputer")
  const setComputer = (value: string) =>
    setFilter({
      ...filter(),
      computer:
        value === ""
          ? undefined
          : value === "here"
            ? "here"
            : { name: value.slice("name:".length) },
    })
  const set = <K extends keyof TaskFilter>(key: K, value: TaskFilter[K] | "") =>
    setFilter({ ...filter(), [key]: value === "" ? undefined : value })

  return (
    <div class={`${shell.page} ${styles.page}`} data-testid="tasks-page">
      <div class={styles.filters}>
        <label class={styles.filter}>
          <span>{t("tasks.filter.state")}</span>
          <select
            class={styles.select}
            onChange={(e) => set("state", e.currentTarget.value as TaskFilter["state"] | "")}
            data-testid="tasks-filter-state"
          >
            <option value="">{t("tasks.filter.all")}</option>
            <For each={TASK_STATES}>
              {(s) => <option value={s}>{t(`tasks.state.${s}` as MessageKey)}</option>}
            </For>
          </select>
        </label>
        <label class={styles.filter}>
          <span>{t("tasks.filter.agent")}</span>
          <select
            class={styles.select}
            onChange={(e) => set("agentId", e.currentTarget.value)}
            data-testid="tasks-filter-agent"
          >
            <option value="">{t("tasks.filter.all")}</option>
            <For each={agents.agents()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
          </select>
        </label>
        <label class={styles.filter}>
          <span>{t("tasks.filter.source")}</span>
          <select
            class={styles.select}
            onChange={(e) => set("source", e.currentTarget.value as TaskFilter["source"] | "")}
            data-testid="tasks-filter-source"
          >
            <option value="">{t("tasks.filter.all")}</option>
            <For each={TASK_SOURCES}>
              {(s) => <option value={s}>{t(`tasks.source.${s}` as MessageKey)}</option>}
            </For>
          </select>
        </label>
        <Show when={showComputers()}>
          <label class={styles.filter}>
            <span>{t("tasks.filter.computer")}</span>
            <select
              class={styles.select}
              onChange={(e) => setComputer(e.currentTarget.value)}
              data-testid="tasks-filter-computer"
            >
              <option value="">{t("tasks.filter.all")}</option>
              <option value="here">{t("tasks.computer.here")}</option>
              <For each={computers()}>
                {(name) => (
                  <option value={`name:${name}`}>{name || t("sync.anotherComputer")}</option>
                )}
              </For>
            </select>
          </label>
        </Show>
        <input
          class={styles.search}
          type="search"
          placeholder={t("tasks.search")}
          aria-label={t("tasks.search")}
          onInput={(e) => set("query", e.currentTarget.value)}
          data-testid="tasks-search"
        />
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
                <th scope="col">{t("tasks.col.agent")}</th>
                <th scope="col">{t("tasks.col.label")}</th>
                <th scope="col">{t("tasks.col.source")}</th>
                <Show when={showComputers()}>
                  <th scope="col">{t("tasks.col.computer")}</th>
                </Show>
                <th scope="col">{t("tasks.col.state")}</th>
                <th scope="col" class={styles.num}>
                  {t("tasks.col.duration")}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()}>
                {(task) => (
                  <tr data-testid="task-row" data-state={task.state}>
                    <td>{task.agentName}</td>
                    <th scope="row">
                      <button
                        type="button"
                        class={styles.rowButton}
                        onClick={() => setOpenId(task.id)}
                        data-testid="task-open"
                      >
                        {task.label}
                      </button>
                    </th>
                    <td>{t(`tasks.source.${task.source}` as MessageKey)}</td>
                    <Show when={showComputers()}>
                      <td data-testid="task-computer">{computerOf(task)}</td>
                    </Show>
                    <td>
                      <span class={styles.state} data-state={task.state} data-testid="task-state">
                        {t(`tasks.state.${task.state}` as MessageKey)}
                      </span>
                      <Show when={task.waitsFor}>
                        {(name) => (
                          <div class={styles.muted} data-testid="task-waits">
                            {t("tasks.waitsFor", { name: name() })}
                          </div>
                        )}
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
        {(id) => <TaskDetailDialog id={id} onClose={() => setOpenId(undefined)} />}
      </Presence>
    </div>
  )
}
