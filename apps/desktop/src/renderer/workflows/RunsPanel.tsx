import type { MessageKey, RunDetail, RunNode, RunSummary, RunTask } from "@robot/shared"
import { createResource, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { outsideText, reasonText, sensitiveText } from "../lib/runText.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./runs.module.css"

/** The word of a state of a run, a task or a node that has no task (spec 005). */
const stateWord = (state: string): MessageKey =>
  (state === "skipped" || state === "not_reached"
    ? `runs.state.${state}`
    : `workflows.run.state.${state}`) as MessageKey

const Badge = (props: { state: string; testId: string }) => {
  const { t } = useApp()
  return (
    <span class={styles.badge} data-state={props.state} data-testid={props.testId}>
      {t(stateWord(props.state))}
    </span>
  )
}

/** The marks a task holds (spec 007): outside content, a sensitive read, the program mark. */
const TaskMarks = (props: { task: RunTask; number: number }) => {
  const { t } = useApp()
  return (
    <Show when={props.task.outside || props.task.sensitive || props.task.program}>
      <ul class={styles.marks} data-testid={`run-node-marks-${props.number}`}>
        <Show when={props.task.outside}>
          {(source) => (
            <li data-testid={`run-node-outside-${props.number}`}>
              {t("runs.mark.outside", { source: outsideText(t, source()) })}
            </li>
          )}
        </Show>
        <Show when={props.task.sensitive}>
          {(label) => (
            <li data-testid={`run-node-sensitive-${props.number}`}>
              {t("runs.mark.sensitive", { label: sensitiveText(t, label()) })}
            </li>
          )}
        </Show>
        <Show when={props.task.program}>
          <li data-testid={`run-node-program-${props.number}`}>{t("runs.mark.program")}</li>
        </Show>
      </ul>
    </Show>
  )
}

const NodeCard = (props: { node: RunNode }) => {
  const { t } = useApp()
  const task = () => props.node.task
  const reason = () => reasonText(t, task()?.reasonCode ?? null, task()?.reasonText ?? null)
  return (
    <li class={styles.node} data-testid={`run-node-${props.node.number}`}>
      <div class={styles.nodeHead}>
        <strong>{t("runs.node", { number: props.node.number, name: props.node.name })}</strong>
        <span class={styles.kind}>{t(`runs.kind.${props.node.kind}` as MessageKey)}</span>
        <Badge state={props.node.state} testId={`run-node-state-${props.node.number}`} />
      </div>
      <Show when={reason()}>
        {(text) => (
          <p class={styles.reason} data-testid={`run-node-reason-${props.node.number}`}>
            {t("runs.reason")}: {text()}
          </p>
        )}
      </Show>
      <Show when={task()}>
        {(task) => (
          <>
            <TaskMarks task={task()} number={props.node.number} />
            <Show when={task().decision}>
              {(decision) => (
                <div class={styles.decision} data-testid={`run-node-decision-${props.node.number}`}>
                  <Show when={decision().options.length > 0}>
                    <span>{t("runs.decision")}</span>
                    <ul>
                      <For each={decision().options}>
                        {(o) => (
                          <li>
                            {o.label} {Math.round(o.probability * 100)}%
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show when={decision().taken}>
                    {(label) => <span>{t("runs.decision.taken", { label: label() })}</span>}
                  </Show>
                </div>
              )}
            </Show>
            <Show when={props.node.kind === "text"}>
              <Show when={task().input !== ""}>
                <details class={styles.io}>
                  <summary>{t("runs.input")}</summary>
                  <pre tabindex="0" data-testid={`run-node-input-${props.node.number}`}>
                    {task().input}
                  </pre>
                </details>
              </Show>
              <div class={styles.io}>
                <span class={styles.label}>{t("runs.result")}</span>
                <Show
                  when={task().result !== ""}
                  fallback={<span class={styles.muted}>{t("runs.result.none")}</span>}
                >
                  <pre tabindex="0" data-testid={`run-node-result-${props.node.number}`}>
                    {task().result}
                  </pre>
                </Show>
              </div>
            </Show>
            <p class={styles.meta}>
              <Show when={task().usage.input !== null}>
                <span>
                  {t("runs.usage", {
                    input: task().usage.input ?? 0,
                    output: task().usage.output ?? 0,
                  })}
                </span>
              </Show>
              <Show when={task().steps > 0}>
                <span>{t("runs.steps", { count: task().steps })}</span>
              </Show>
              <Show when={task().keptGoing > 0}>
                <span>{t("runs.kept", { count: task().keptGoing })}</span>
              </Show>
            </p>
          </>
        )}
      </Show>
    </li>
  )
}

const RunView = (props: { run: RunDetail; onBack: () => void; onStop: () => void }) => {
  const { t, locale } = useApp()
  const reason = () => reasonText(t, props.run.reasonCode, props.run.reasonText)
  return (
    <div class={styles.view} data-testid="run-view">
      <div class={styles.viewHead}>
        <Button onClick={props.onBack} data-testid="run-back">
          {t("runs.back")}
        </Button>
        <Badge state={props.run.state} testId="run-state" />
        <span class={styles.muted}>
          {t("runs.started", { time: formatDateTime(locale(), props.run.startedAt) })} ·{" "}
          {t(`runs.source.${props.run.source}` as MessageKey)}
        </span>
        <span class={styles.spacer} />
        <Show when={props.run.finishedAt === null}>
          <Button variant="danger" onClick={props.onStop} data-testid="run-stop">
            {t("runs.stop")}
          </Button>
        </Show>
      </div>
      <Show when={props.run.triggerText !== ""}>
        <p class={styles.muted}>{props.run.triggerText}</p>
      </Show>
      <Show when={reason()}>
        {(text) => (
          <p class={styles.reason} data-testid="run-reason">
            {t("runs.reason")}: {text()}
          </p>
        )}
      </Show>
      <Show when={props.run.stoppedAt !== null}>
        <p class={styles.reason}>{t("runs.stoppedAt", { number: props.run.stoppedAt ?? 0 })}</p>
      </Show>
      <ol class={styles.nodes}>
        <For each={props.run.nodes}>{(node) => <NodeCard node={node} />}</For>
      </ol>
      <Show when={props.run.feedback.length > 0}>
        <section class={styles.feedback} data-testid="run-feedback">
          <strong>{t("runs.feedback.title")}</strong>
          <ul>
            <For each={props.run.feedback}>
              {(f) => (
                <li>
                  “{f.text}” ·{" "}
                  <time dateTime={new Date(f.createdAt).toISOString()}>
                    {formatDateTime(locale(), f.createdAt)}
                  </time>{" "}
                  ·{" "}
                  {f.nodes.length > 0
                    ? t("runs.feedback.nodes", { nodes: f.nodes.join(", ") })
                    : t("runs.feedback.none")}
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.run.usage.input !== null || props.run.usage.output !== null}>
        <p class={styles.meta}>
          {t("runs.usage", {
            input: props.run.usage.input ?? 0,
            output: props.run.usage.output ?? 0,
          })}
        </p>
      </Show>
    </div>
  )
}

/** The tab "Runs": the list of runs of the workflow and the view of one run (spec 010, 005). */
export const RunsPanel = (props: {
  workflowId: string
  runs: readonly RunSummary[]
  selected: string | undefined
  onSelect: (id: string | undefined) => void
  trigger: string
  onTrigger: (text: string) => void
}) => {
  const { t, locale } = useApp()
  const [detail, { refetch }] = createResource(
    () => props.selected,
    (id): Promise<RunDetail | undefined> =>
      id ? call("runs.get", { runId: id }).catch(() => undefined) : Promise.resolve(undefined),
  )
  onCleanup(
    window.robot.on("runs.changed", (payload) => {
      if (payload.workflowId === props.workflowId) void refetch()
    }),
  )
  const stop = (id: string) =>
    void call("runs.stop", { runId: id }).catch((e: unknown) => {
      const text = describeError(e)
      showToast("error", text.key, text.params)
    })
  return (
    <div class={styles.panel} data-testid="runs-panel">
      <Show
        when={props.selected ? detail() : undefined}
        fallback={
          <>
            <label class={styles.trigger}>
              <span class={styles.label}>{t("runs.trigger")}</span>
              <input
                type="text"
                class={styles.triggerInput}
                value={props.trigger}
                onInput={(e) => props.onTrigger(e.currentTarget.value)}
                data-testid="runs-trigger"
              />
            </label>
            <h3 class={styles.title}>{t("runs.title")}</h3>
            <Show
              when={props.runs.length > 0}
              fallback={
                <p class={styles.muted} data-testid="runs-none">
                  {t("runs.none")}
                </p>
              }
            >
              <ul class={styles.list} data-testid="runs-list">
                <For each={props.runs}>
                  {(run) => (
                    <li>
                      <button
                        type="button"
                        class={styles.row}
                        onClick={() => props.onSelect(run.id)}
                        data-testid={`run-row-${run.id}`}
                      >
                        <Badge state={run.state} testId={`run-row-state-${run.id}`} />
                        <span>{formatDateTime(locale(), run.startedAt)}</span>
                        <span class={styles.muted}>
                          {t(`runs.source.${run.source}` as MessageKey)}
                        </span>
                        <span class={styles.muted}>
                          {t("runs.row.progress", { n: run.ended, m: run.total })}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        }
      >
        {(run) => (
          <RunView
            run={run()}
            onBack={() => props.onSelect(undefined)}
            onStop={() => stop(run().id)}
          />
        )}
      </Show>
    </div>
  )
}
