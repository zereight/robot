import {
  CLAIMS_MAX,
  type MessageKey,
  NOTE_NAME_CHARS,
  type NodeHold,
  plainLine,
  type RunDetail,
  type RunNode,
  type RunSummary,
  type RunTask,
  type RunWorktree,
  type TaskConnectionStep,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { outsideText, reasonText, sensitiveText } from "../lib/runText.ts"
import { useApp } from "../state/app.tsx"
import { openImprovement } from "../state/improve.ts"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { Spinner } from "../ui/Spinner.tsx"
import { showToast } from "../ui/toast.ts"
import { BackupHold } from "./BackupHold.tsx"
import { createHolds } from "./holds.ts"
import improve from "./improve.module.css"
import { showsProposals } from "./improveView.ts"
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
      <Show when={props.state === "running"}>
        <Spinner />
      </Show>
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

/**
 * The file claims of a task in a shared folder, and the steps that a claim of another workflow
 * refused (spec 025, "Seeing the state"). The lines are muted. A task that waits keeps its claims.
 */
const TaskClaims = (props: { task: RunTask; number: number }) => {
  const { t } = useApp()
  // A build on a linked computer (012) may be older and send a task with no claims or refusals.
  const claims = () => props.task.claims ?? { count: 0, paths: [] }
  const refusals = () => props.task.refusals ?? []
  const more = () => claims().count - claims().paths.length
  return (
    <>
      <Show when={claims().count > 0}>
        <details class={styles.io} data-testid={`run-node-claims-${props.number}`}>
          <summary>
            {claims().count === 1
              ? t("runs.claims.one")
              : t("runs.claims.other", { count: claims().count })}
          </summary>
          <ul class={styles.marks}>
            <For each={claims().paths}>{(path) => <li>{plainLine(path)}</li>}</For>
            <Show when={more() > 0}>
              <li>{t("runs.claims.more", { count: more() })}</li>
            </Show>
          </ul>
        </details>
      </Show>
      <Show when={refusals().length > 0}>
        <ul class={styles.marks} data-testid={`run-node-refused-${props.number}`}>
          <For each={refusals()}>
            {(r) => (
              <li data-testid="run-refused-line">
                {r.holder === ""
                  ? t("runs.refused.limit", { count: CLAIMS_MAX, path: plainLine(r.path) })
                  : t("runs.refused", {
                      holder: plainLine(r.holder, NOTE_NAME_CHARS),
                      path: plainLine(r.path),
                    })}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  )
}

/**
 * The notice lines and the tool lines of the connections that a task used (spec 018, "States",
 * "Rules"): a connection that was down, a connection with tools that wait for review, and one
 * muted line for each call of a tool or search of tools. The names are plain lines.
 */
const TaskConnections = (props: { task: RunTask; number: number }) => {
  const { t } = useApp()
  // A build on a linked computer (012) may be older and send a task with no such lines.
  const notes = () => props.task.connections ?? { down: [], held: [], steps: [] }
  const any = () => notes().down.length + notes().held.length + notes().steps.length > 0
  const callLine = (step: Extract<TaskConnectionStep, { kind: "call" }>) => {
    const result = t(`runs.tool.result.${step.result}` as MessageKey)
    const label =
      step.how === "unknown" || step.connection === ""
        ? t("runs.tool.unknown", { tool: plainLine(step.tool, NOTE_NAME_CHARS), result })
        : t("runs.tool.call", {
            connection: plainLine(step.connection, NOTE_NAME_CHARS),
            tool: plainLine(step.tool, NOTE_NAME_CHARS),
            result,
          })
    if (step.how === "level" || step.how === "none") return label
    const how = t(`runs.tool.how.${step.how}` as MessageKey)
    return t("runs.tool.call.how", { line: label, how })
  }
  return (
    <Show when={any()}>
      <ul class={styles.marks} data-testid={`run-node-connections-${props.number}`}>
        <For each={notes().down}>
          {(name) => (
            <li data-testid="run-connection-down">
              {t("runs.connection.down", { name: plainLine(name, NOTE_NAME_CHARS) })}
            </li>
          )}
        </For>
        <For each={notes().held}>
          {(name) => (
            <li data-testid="run-connection-held">
              {t("runs.connection.held", { name: plainLine(name, NOTE_NAME_CHARS) })}
            </li>
          )}
        </For>
        <For each={notes().steps}>
          {(step) => (
            <li
              data-testid="run-tool-line"
              data-kind={step.kind}
              data-how={step.kind === "call" ? step.how : undefined}
            >
              {step.kind === "search"
                ? t("runs.tool.search", {
                    words: plainLine(step.words, 100),
                    count: step.found,
                  })
                : callLine(step)}
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/**
 * The memory work of a task (spec 008, "Flows" 1): "Saved to memory" with an undo control, and
 * "Suggested for memory" with the link "Review". The lines are muted.
 */
const TaskMemory = (props: { task: RunTask; workflowId: string; number: number }) => {
  const { t } = useApp()
  const ui = useUi()
  // A linked device shows no proposals and cannot undo memory (spec 002, "Surfaces").
  const local = () => showsProposals(ui.server()?.kind)
  const undo = (historyId: string) =>
    call("memory.undo", { historyId }).catch((e: unknown) => {
      const text = describeError(e)
      showToast("error", text.key, text.params)
    })
  return (
    <Show when={props.task.memory.length > 0}>
      <ul class={styles.marks} data-testid={`run-node-memory-${props.number}`}>
        <Keyed
          each={props.task.memory}
          by={(m) => `${m.kind}:${m.historyId ?? m.proposalId ?? m.text}`}
        >
          {(m) => (
            <li data-testid="run-memory-line" data-kind={m().kind}>
              {m().kind === "saved"
                ? t("runs.memory.saved", { text: m().text })
                : t("runs.memory.suggested", { text: m().text })}{" "}
              <Show when={local() && m().kind === "saved" && m().canUndo && m().historyId}>
                {(id) => (
                  <Button onClick={() => void undo(id())} data-testid="run-memory-undo">
                    {t("runs.memory.undo")}
                  </Button>
                )}
              </Show>
              <Show when={local() && m().kind === "suggested"}>
                <button
                  type="button"
                  class={improve.link}
                  onClick={() => openImprovement(props.workflowId, m().proposalId)}
                  data-testid="run-memory-review"
                >
                  {t("runs.memory.review")}
                </button>
              </Show>
            </li>
          )}
        </Keyed>
      </ul>
    </Show>
  )
}

const NodeCard = (props: { node: RunNode; workflowId: string; hold?: NodeHold | undefined }) => {
  const { t, locale } = useApp()
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
            <Show when={task().backupNote}>
              {(note) => (
                <p class={styles.muted} data-testid={`run-node-backup-line-${props.node.number}`}>
                  {note().resetsAt === null
                    ? t("runs.backup", { main: note().main, backup: note().backup })
                    : t("runs.backup.until", {
                        main: note().main,
                        backup: note().backup,
                        time: formatDateTime(locale(), note().resetsAt as number),
                      })}
                </p>
              )}
            </Show>
            <Show when={props.hold}>
              {(hold) => (
                <BackupHold hold={hold()} testId={`run-node-backup-${props.node.number}`} />
              )}
            </Show>
            <TaskMemory task={task()} workflowId={props.workflowId} number={props.node.number} />
            <TaskClaims task={task()} number={props.node.number} />
            <TaskConnections task={task()} number={props.node.number} />
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
            <Show when={task().approval}>
              {(approval) => (
                <div class={styles.decision} data-testid={`run-node-approval-${props.node.number}`}>
                  <span>
                    {t("runs.approval.answer", {
                      answer: t(
                        approval().verdict === "approve"
                          ? "runs.approval.approve"
                          : "runs.approval.reject",
                      ),
                    })}
                  </span>
                  <Show when={approval().comment}>
                    {(comment) => <span>{t("runs.approval.comment", { comment: comment() })}</span>}
                  </Show>
                  <span class={styles.muted}>
                    {formatDateTime(locale(), approval().answeredAt)}
                  </span>
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

/**
 * The worktree line of a run (spec 007, "New worktree"): its path and branch, with "Open" and
 * "Remove". A removed worktree names its branch and offers no buttons. "Remove" asks first when
 * the worktree may hold changes that are not committed or files that Git ignores.
 */
const WorktreeLine = (props: { runId: string; worktree: RunWorktree; onChanged: () => void }) => {
  const { t } = useApp()
  const [asking, setAsking] = createSignal(false)
  const fail = (e: unknown) => {
    const text = describeError(e)
    showToast("error", text.key, text.params)
  }
  const open = () => call("runs.worktree.open", { runId: props.runId }).catch(fail)
  const remove = (confirmed: boolean) =>
    call("runs.worktree.remove", { runId: props.runId, confirmed })
      .then((result) => {
        if (result === "needs_confirm") setAsking(true)
        else {
          setAsking(false)
          props.onChanged()
        }
      })
      .catch(fail)
  return (
    <Show
      when={!props.worktree.removed}
      fallback={
        <p class={styles.muted} data-testid="run-worktree-removed">
          {t("runs.worktree.removed", { branch: plainLine(props.worktree.branch) })}
        </p>
      }
    >
      <div data-testid="run-worktree">
        <span>
          {t("runs.worktree", {
            path: plainLine(props.worktree.path),
            branch: plainLine(props.worktree.branch),
          })}
        </span>{" "}
        <Button onClick={() => void open()} data-testid="run-worktree-open">
          {t("runs.worktree.open")}
        </Button>{" "}
        <Button
          variant="danger"
          onClick={() => void remove(false)}
          data-testid="run-worktree-remove"
        >
          {t("runs.worktree.remove")}
        </Button>
        <Show when={asking()}>
          <Confirm
            ask={t("runs.worktree.remove.ask", { path: plainLine(props.worktree.path) })}
            confirm={t("runs.worktree.remove")}
            keep={t("common.keep")}
            testId="run-worktree-remove-ask"
            confirmTestId="run-worktree-remove-confirm"
            keepTestId="run-worktree-remove-keep"
            onKeep={() => setAsking(false)}
            onConfirm={() => void remove(true)}
          />
        </Show>
      </div>
    </Show>
  )
}

const RunView = (props: {
  run: RunDetail
  onBack: () => void
  onStop: () => void
  onChanged: () => void
}) => {
  const { t, locale } = useApp()
  // The holds of the main models of the nodes: "Backup until <time>" shows on the node (spec 006).
  const holds = createHolds(() => props.run.workflowId)
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
      <Show when={props.run.worktree}>
        {(worktree) => (
          <WorktreeLine runId={props.run.id} worktree={worktree()} onChanged={props.onChanged} />
        )}
      </Show>
      <ol class={styles.nodes}>
        <Keyed each={props.run.nodes} by={(node) => node.number}>
          {(node) => (
            <NodeCard
              node={node()}
              workflowId={props.run.workflowId}
              hold={holds().find((h) => h.number === node().number)}
            />
          )}
        </Keyed>
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
  // A memory line of a task changes when the user answers its proposal or undoes the item.
  for (const event of ["memory.changed", "proposals.changed"] as const)
    onCleanup(
      window.robot.on(event, (payload) => {
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
                <Keyed each={props.runs} by={(r) => r.id}>
                  {(runOf) => (
                    <li>
                      <button
                        type="button"
                        class={styles.row}
                        onClick={() => props.onSelect(runOf().id)}
                        data-testid={`run-row-${runOf().id}`}
                      >
                        <Badge state={runOf().state} testId={`run-row-state-${runOf().id}`} />
                        <span>{formatDateTime(locale(), runOf().startedAt)}</span>
                        <span class={styles.muted}>
                          {t(`runs.source.${runOf().source}` as MessageKey)}
                        </span>
                        <span class={styles.muted}>
                          {t("runs.row.progress", { n: runOf().ended, m: runOf().total })}
                        </span>
                      </button>
                    </li>
                  )}
                </Keyed>
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
            onChanged={() => void refetch()}
          />
        )}
      </Show>
    </div>
  )
}
