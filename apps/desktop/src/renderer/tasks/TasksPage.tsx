import {
  behindWords,
  catalogues,
  filterTasks,
  isActive,
  type MessageKey,
  type Moment,
  TASK_SOURCES,
  TASK_STATES,
  type Task,
  type TaskFilter,
  taskDuration,
  taskMoments,
  taskTimes,
  taskTree,
} from "@robot/shared"
import { Eye, OctagonX } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { formatElapsed, formatHitTime, formatTime } from "../chat/format.ts"
import { openThread } from "../chat/threads.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { formatSeconds } from "../lib/seconds.ts"
import { AgentName, useShownText } from "../orgs/AgentName.tsx"
import { useRetry } from "../retry/RetryNote.tsx"
import { useEndRequest, useReview } from "../review/Review.tsx"
import shell from "../shell/shell.module.css"
import { makeSkillFromWork } from "../skills/SkillForm.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { openTarget, takeTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { showToast } from "../ui/toast.ts"
import { TaskStateText } from "./TaskStateText.tsx"
import { TaskUsageView } from "./TaskUsageView.tsx"
import styles from "./tasks.module.css"
import { sourceWords, taskTitle } from "./title.ts"

// A reason with no text of its own shows the general error text.
const catalogueKeys = catalogues.en

const reasonKey = (task: Task): MessageKey =>
  task.error && `error.${task.error.code}` in catalogueKeys
    ? (`error.${task.error.code}` as MessageKey)
    : "error.unknown"

/** The icon of a state that has one: a part in review has an eye, a blocked task a stop sign. */
const StateIcon = (props: { state: Task["state"] }) => (
  <>
    <Show when={props.state === "review"}>
      <Eye size={12} aria-hidden="true" />
    </Show>
    <Show when={props.state === "blocked"}>
      <OctagonX size={12} aria-hidden="true" />
    </Show>
  </>
)

/**
 * "Run next" is on for a queued task of this computer that has not started (spec 005, "Queue"). A
 * linked computer and the phone do not have it (011, 012).
 */
const canRunNext = (task: Task, linked: boolean) =>
  !linked && task.state === "queued" && task.originName === null

/** What a queued task waits behind, in words (spec 005, "Tasks page"). */
const BehindLine = (props: { task: Task; testid: string; class: string | undefined }) => {
  const { t } = useApp()
  return (
    <Show when={props.task.state === "queued" && props.task.behind}>
      {(behind) => {
        const words = () => behindWords(behind())
        return (
          <div class={props.class} data-testid={props.testid}>
            {t(words().key, words().params)}
          </div>
        )
      }}
    </Show>
  )
}

/** The sources of a task whose place the button "Open source place" opens. */
const OPENS_PLACE: readonly Task["source"][] = ["chat", "channel", "handover", "teams"]

/** A request has parts that may still be open, so "End the request" is offered (spec 004, 005). */
const OPEN_REQUEST = new Set<Task["state"]>([
  "queued",
  "running",
  "waiting",
  "review",
  "failed",
  "blocked",
])

const duration = (task: Task) => {
  const ms = taskDuration(task)
  return ms === null ? "–" : formatElapsed(ms)
}

/** The three times of a task (spec 005). A time that is not known shows as a dash, never as 0. */
const TaskTimesList = (props: { task: Task }) => {
  const { t, locale } = useApp()
  const times = () => taskTimes(props.task)
  const rows = () =>
    [
      ["wait", "tasks.times.wait", times().wait],
      ["first-reply", "tasks.times.firstReply", times().firstReply],
      ["total", "tasks.times.total", times().total],
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

/**
 * The moments of a task with their clock times, in plain text (spec 005). A moment that did not
 * happen is not listed. The three times above keep their own meaning.
 */
const MomentsList = (props: { task: Task; leadName: string | null }) => {
  const { t, locale } = useApp()
  const text = (moment: Moment): string => {
    switch (moment.id) {
      case "given":
        return moment.by.kind === "lead"
          ? t("moments.given.lead", { name: moment.by.name })
          : t(
              moment.by.kind === "agent"
                ? "moments.given.agent"
                : (`moments.given.${moment.by.source}` as MessageKey),
            )
      case "started":
        return t("moments.started")
      case "ended":
        return t(`moments.ended.${moment.how}` as MessageKey)
      case "decided":
        return moment.decision === "accepted"
          ? t("moments.decided.accepted")
          : t("moments.decided.changes", { text: moment.text ?? "" })
      case "judged":
        return moment.verdict === "met"
          ? t("moments.judged.met")
          : t("moments.judged.not_met", { reason: moment.reason || t("tasks.verdict.noReason") })
      case "closed":
        return t("moments.closed", { state: t(`tasks.state.${moment.state}` as MessageKey) })
    }
  }
  return (
    <ol class={styles.moments} data-testid="task-moments">
      <For each={taskMoments(props.task, props.leadName)}>
        {(moment) => (
          <li data-testid="task-moment" data-moment={moment.id}>
            <time class={styles.joinedTime} data-at={moment.at}>
              {formatHitTime(locale(), moment.at)}
            </time>
            <span class={styles.text}>{text(moment)}</span>
          </li>
        )}
      </For>
    </ol>
  )
}

const TaskDetailDialog = (props: { id: string; onClose: () => void }) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [error, setError] = createSignal<ErrorText>()
  const retry = useRetry()
  const reviewing = useReview((e) => setError(e))
  const ending = useEndRequest((e) => setError(e))
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
    if (!task.sourceId || !OPENS_PLACE.includes(task.source)) return
    // A linked device has the main thread only (spec 003, 012): the button is off for a thread.
    if (ui.linked() && task.threadId) return
    // A handover is a message in a thread of the agent that runs it (spec 003, 005).
    const inChat = task.source === "chat" || task.source === "handover" || task.source === "teams"
    if (inChat) openThread(task.sourceId, task.threadId)
    ui.selectPlace({ kind: inChat ? "agent" : "channel", id: task.sourceId })
    props.onClose()
  }
  return (
    <Dialog label={t("tasks.detail.title")} onClose={props.onClose} testId="task-detail">
      {retry.dialog()}
      {reviewing.dialog()}
      {ending.dialog()}
      <Show when={detail()}>
        {(d) => (
          <div class={styles.detail}>
            <h2 class={styles.title}>{taskTitle(d().task, t)}</h2>
            <p class={styles.meta}>
              <AgentName id={d().task.agentId} name={d().task.agentName} /> ·{" "}
              {sourceWords(d().task, t)} ·{" "}
              <span
                class={styles.state}
                data-testid="task-detail-state"
                data-state={d().task.state}
              >
                <StateIcon state={d().task.state} />
                <TaskStateText task={d().task} />
              </span>
            </p>
            <Show when={d().task.originName !== null}>
              <p class={styles.meta} data-testid="task-detail-computer">
                {t("tasks.detail.computer", {
                  name: d().task.originName || t("sync.anotherComputer"),
                })}
              </p>
            </Show>
            <BehindLine task={d().task} testid="task-detail-behind" class={styles.meta} />
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
            <h3>{t("tasks.times")}</h3>
            <TaskTimesList task={d().task} />
            <h3>{t("moments.title")}</h3>
            <MomentsList task={d().task} leadName={d().leadName} />
            {/* The tokens and the cost of the task, and the total of its tree (spec 005). */}
            <TaskUsageView usage={d().task.usage} tree={d().tree} />
            <h3>{t("tasks.prompt")}</h3>
            <pre class={styles.text}>{d().task.prompt}</pre>
            {/* The done test and the verdict of the lead belong to a part of a channel (spec 004, 005). */}
            <Show when={d().task.doneTest}>
              {(doneTest) => (
                <>
                  <h3>{t("tasks.doneTest")}</h3>
                  <p class={styles.text} data-testid="task-done-test">
                    {doneTest()}
                  </p>
                </>
              )}
            </Show>
            <Show when={d().task.verdict}>
              {(verdict) => (
                <>
                  <h3>{t("tasks.verdict")}</h3>
                  <p class={styles.verdict} data-testid="task-verdict" data-verdict={verdict()}>
                    {t(`tasks.verdict.${verdict()}` as MessageKey)}
                  </p>
                  <Show when={verdict() === "not_met"}>
                    <p class={styles.text} data-testid="task-verdict-reason">
                      {d().task.verdictReason || t("tasks.verdict.noReason")}
                    </p>
                  </Show>
                </>
              )}
            </Show>
            {/* The questions of a part, with who answered each one (spec 004, 005). */}
            <Show when={d().questions.length > 0}>
              <h3>{t("tasks.questions")}</h3>
              <ul class={styles.questions} data-testid="task-questions">
                <For each={d().questions}>
                  {(item) => (
                    <li data-testid="task-question" data-by={item.by}>
                      <span class={styles.text}>{item.question}</span>
                      <span class={styles.questionBy} data-testid="task-question-by">
                        {item.by === "user"
                          ? t("tasks.question.user")
                          : item.by === "lead"
                            ? t("tasks.question.lead", { name: item.name ?? "" })
                            : item.by === "with_lead"
                              ? t("tasks.question.withLead", { name: item.name ?? "" })
                              : item.by === "passed"
                                ? t("tasks.question.passed", { name: item.name ?? "" })
                                : t("tasks.question.open")}
                      </span>
                      <Show when={item.reason}>
                        <span class={styles.questionReason} data-testid="task-question-reason">
                          {item.reason}
                        </span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
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
                        <StateIcon state={node.task.state} />
                        <TaskStateText task={node.task} />
                      </span>{" "}
                      <AgentName id={node.task.agentId} name={node.task.agentName} />:{" "}
                      {taskTitle(node.task, t)}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={error()}>
              {(err) => <p class={styles.errorText}>{t(err().key, err().params)}</p>}
            </Show>
            {/* How far the turn went (spec 005). It sits with Retry. A Stop of the user shows no line. */}
            <Show when={d().task.state === "failed" && d().task.progress}>
              {(progress) => (
                <p class={styles.meta} data-testid="task-progress-line" data-progress={progress()}>
                  {t(`progress.line.${progress()}` as MessageKey)}
                </p>
              )}
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
              <Show when={canRunNext(d().task, ui.linked())}>
                <Button
                  onClick={() => act(() => call("tasks.runNext", { id: d().task.id }))}
                  data-testid="task-run-next"
                >
                  {t("tasks.runNext")}
                </Button>
              </Show>
              <Show when={d().task.state === "review"}>
                <Show
                  when={!ui.linked() && d().task.originName === null}
                  fallback={
                    // The user decides on the computer that owns the task (spec 005, 012, 019).
                    <span class={styles.muted} data-testid="task-decide-on">
                      {t("review.decideOn", {
                        name: ui.linked()
                          ? (ui.server()?.name ?? "")
                          : d().task.originName || t("sync.anotherComputer"),
                      })}
                    </span>
                  }
                >
                  <Button
                    onClick={() => void reviewing.accept(d().task.id)}
                    data-testid="task-accept"
                  >
                    {t("tasks.accept")}
                  </Button>
                  <Button
                    onClick={() => reviewing.requestChanges(d().task.id)}
                    data-testid="task-request-changes"
                  >
                    {t("tasks.requestChanges")}
                  </Button>
                </Show>
              </Show>
              <Show
                when={
                  !ui.linked() &&
                  (d().task.state === "failed" ||
                    d().task.state === "blocked" ||
                    d().task.state === "cancelled")
                }
              >
                <Button
                  onClick={() =>
                    act(() =>
                      retry.start((confirmed) =>
                        call("tasks.retry", {
                          id: d().task.id,
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
              <Show
                when={
                  !ui.linked() &&
                  d().task.source === "channel" &&
                  d().task.originName === null &&
                  OPEN_REQUEST.has(d().task.state)
                }
              >
                <Button onClick={() => ending.start(d().task.id)} data-testid="task-end-request">
                  {t("tasks.endRequest")}
                </Button>
              </Show>
              {/* "Make a skill" needs the model account of this computer: a client has none (spec 017). */}
              <Show when={!ui.linked() && d().task.state === "done"}>
                <Button
                  onClick={() => makeSkillFromWork({ kind: "task", id: d().task.id })}
                  data-testid="task-make-skill"
                >
                  {t("skills.make")}
                </Button>
              </Show>
              <Show when={d().task.sourceId && OPENS_PLACE.includes(d().task.source)}>
                <Button
                  onClick={() => openSource(d().task)}
                  disabled={ui.linked() && d().task.threadId !== undefined}
                  title={
                    ui.linked() && d().task.threadId !== undefined
                      ? t("tasks.openSource.thread")
                      : undefined
                  }
                  data-testid="task-open-source"
                >
                  {t("tasks.openSource")}
                </Button>
                <Show when={ui.linked() && d().task.threadId !== undefined}>
                  <span class={styles.meta} data-testid="task-open-source-off">
                    {t("tasks.openSource.thread")}
                  </span>
                </Show>
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
  const shownText = useShownText()
  const devices = useDevices()
  const [filter, setFilter] = createSignal<TaskFilter>({})
  const [openId, setOpenId] = createSignal<string>()
  // The Today page asks for a task: its detail opens at once.
  createEffect(() => {
    if (openTarget()?.kind !== "task") return
    const target = takeTarget("task")
    if (target) setOpenId(target.id)
  })
  // The profile of an agent asks for the tasks of that agent: the filter is set to it (spec 002).
  createEffect(() => {
    if (openTarget()?.kind !== "agentTasks") return
    const target = takeTarget("agentTasks")
    if (target) setFilter({ agentId: target.id })
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
            <option value="" selected={!filter().agentId}>
              {t("tasks.filter.all")}
            </option>
            <For each={agents.agents()}>
              {(a) => (
                <option value={a.id} selected={filter().agentId === a.id}>
                  {shownText(a.id, a.name)}
                </option>
              )}
            </For>
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
                    <td>
                      <AgentName id={task.agentId} name={task.agentName} />
                    </td>
                    <th scope="row">
                      <button
                        type="button"
                        class={styles.rowButton}
                        onClick={() => setOpenId(task.id)}
                        data-testid="task-open"
                      >
                        {taskTitle(task, t)}
                      </button>
                    </th>
                    <td>{sourceWords(task, t)}</td>
                    <Show when={showComputers()}>
                      <td data-testid="task-computer">{computerOf(task)}</td>
                    </Show>
                    <td>
                      <span class={styles.state} data-state={task.state} data-testid="task-state">
                        <StateIcon state={task.state} />
                        <TaskStateText task={task} />
                      </span>
                      <Show when={task.waitsFor}>
                        {(name) => (
                          <div class={styles.muted} data-testid="task-waits">
                            {t("tasks.waitsFor", { name: name() })}
                          </div>
                        )}
                      </Show>
                      <BehindLine task={task} testid="task-behind" class={styles.muted} />
                      <Show when={canRunNext(task, ui.linked())}>
                        <button
                          type="button"
                          class={styles.rowButton}
                          onClick={() =>
                            void call("tasks.runNext", { id: task.id }).catch((e: unknown) => {
                              const error = describeError(e)
                              showToast("error", error.key, error.params)
                            })
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
        {(id) => <TaskDetailDialog id={id} onClose={() => setOpenId(undefined)} />}
      </Presence>
    </div>
  )
}
