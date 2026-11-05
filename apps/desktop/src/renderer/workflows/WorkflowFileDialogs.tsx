import {
  type CcNotExported,
  type GraphFault,
  startWorkflowTicks,
  WORKFLOW_FILE_MAX_WORKFLOWS,
  type Workflow,
  type WorkflowFileFailure,
  type WorkflowFilePreview,
  workflowPicks,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { NotImportedList, SecretMark } from "../agents/AgentFileDialogs.tsx"
import styles from "../agents/agents.module.css"
import review from "../imports/imports.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"

/**
 * The text for an error of a workflow file. A graph fault names the workflow and the place, so it
 * has a text of its own for each kind of fault.
 */
export const describeFileError = (error: unknown): ErrorText => {
  if (error instanceof RpcFailure && error.error.code === "workflow_file_graph") {
    try {
      const fault = JSON.parse(error.error.message) as GraphFault
      return {
        key: `workflowFile.graph.${fault.fault}` as const,
        params: { workflow: fault.workflow, n: fault.place.n },
      }
    } catch {
      // The text below is the fallback.
    }
  }
  return describeError(error)
}

/** Choose workflows, then save them in one file. */
export const ExportWorkflowsDialog = (props: {
  workflows: readonly Workflow[]
  onClose: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(
    new Set(props.workflows.map((w) => w.id)),
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const [saved, setSaved] = createSignal<{ path: string; count: number }>()

  const allPicked = () => props.workflows.length > 0 && picked().size === props.workflows.length
  const tooMany = () => picked().size > WORKFLOW_FILE_MAX_WORKFLOWS
  const toggle = (id: string) => {
    const next = new Set(picked())
    if (!next.delete(id)) next.add(id)
    setPicked(next)
  }

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await call("workflowFile.export", { serverId, workflowIds: [...picked()] })
      if (result.path) setSaved({ path: result.path, count: result.count })
    } catch (e) {
      setError(describeFileError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={t("workflowFile.export.title")}
      onClose={props.onClose}
      testId="workflow-export-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("workflowFile.export.title")}</h2>
        <p class={styles.hint}>{t("workflowFile.export.hint")}</p>
        <Show
          when={props.workflows.length > 0}
          fallback={<p class={styles.hint}>{t("workflowFile.export.empty")}</p>}
        >
          <label class={styles.fileRow}>
            <input
              type="checkbox"
              checked={allPicked()}
              onChange={() =>
                setPicked(allPicked() ? new Set() : new Set(props.workflows.map((w) => w.id)))
              }
              data-testid="workflow-export-all"
            />
            <span class={styles.label}>{t("workflowFile.export.all")}</span>
          </label>
          <ul class={styles.fileList}>
            <For each={props.workflows}>
              {(workflow) => (
                <li>
                  <label class={styles.fileRow}>
                    <input
                      type="checkbox"
                      checked={picked().has(workflow.id)}
                      onChange={() => toggle(workflow.id)}
                      data-testid="workflow-export-item"
                    />
                    <span class={styles.fileText}>
                      <span class={styles.label}>{workflow.name}</span>
                      <span class={styles.hint}>
                        {t("workflowFile.import.counts", {
                          steps: workflow.steps.length,
                          notes: workflow.notes.length,
                        })}
                      </span>
                    </span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={tooMany()}>
          <div class={styles.error} role="alert">
            {t("workflowFile.export.limit")}
          </div>
        </Show>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="workflow-export-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <Show when={saved()}>
          {(done) => (
            <p role="status" data-testid="workflow-export-saved">
              {t("workflowFile.exported", done())}
            </p>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="workflow-export-close">
            {saved() ? t("workflowFile.close") : t("agents.cancel")}
          </Button>
          <Show when={!saved()}>
            <Button
              variant="primary"
              disabled={picked().size === 0 || tooMany() || busy()}
              onClick={submit}
              data-testid="workflow-export-submit"
            >
              {t("workflowFile.export.submit")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

/** One line of the part "Not exported": what the file of CC Workflow Studio does not hold. */
const NotExportedList = (props: { items: readonly CcNotExported[] }) => {
  const { t } = useApp()
  const what = (item: CcNotExported): string => {
    switch (item.kind) {
      case "step":
        return t("workflowFile.notExported.step", { step: item.step, name: item.name })
      case "trigger":
        return t("workflowFile.notExported.trigger", {
          trigger: t(`workflows.trigger.${item.trigger}` as const),
        })
      case "notes":
        return t("workflowFile.notExported.notes", { count: item.count })
      case "stepSettings":
        return t("workflowFile.notExported.stepSettings", { count: item.count })
      case "cut":
        return t("workflowFile.notExported.cut", { step: item.step, name: item.name })
    }
  }
  return (
    <div data-testid="workflow-not-exported">
      <h3 class={review.sectionTitle}>{t("workflowFile.notExported.title")}</h3>
      <ul class={review.notImported}>
        <For each={props.items}>
          {(item) => (
            <li data-testid="not-exported-item">
              <span>{what(item)}</span>{" "}
              <span class={review.hint}>
                {t(`workflowFile.notExported.reason.${item.kind}` as const)}
              </span>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

/** Choose one workflow, then save it as a file of CC Workflow Studio (spec 010). */
export const ExportCcDialog = (props: { workflows: readonly Workflow[]; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [picked, setPicked] = createSignal(props.workflows[0]?.id ?? "")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const [saved, setSaved] = createSignal<{
    path: string
    notExported: readonly CcNotExported[]
  }>()

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy() || picked() === "") return
    setBusy(true)
    setError(undefined)
    try {
      const result = await call("workflowFile.exportCc", { serverId, workflowId: picked() })
      if (result.path) setSaved({ path: result.path, notExported: result.notExported })
    } catch (e) {
      setError(describeFileError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={t("workflowFile.cc.title")}
      onClose={props.onClose}
      testId="workflow-export-cc-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("workflowFile.cc.title")}</h2>
        <p class={styles.hint}>{t("workflowFile.cc.hint")}</p>
        <Show
          when={props.workflows.length > 0}
          fallback={<p class={styles.hint}>{t("workflowFile.export.empty")}</p>}
        >
          <ul class={styles.fileList}>
            <For each={props.workflows}>
              {(workflow) => (
                <li>
                  <label class={styles.fileRow}>
                    <input
                      type="radio"
                      name="workflow-export-cc"
                      checked={picked() === workflow.id}
                      disabled={saved() !== undefined}
                      onChange={() => setPicked(workflow.id)}
                      data-testid="workflow-export-cc-item"
                    />
                    <span class={styles.fileText}>
                      <span class={styles.label}>{workflow.name}</span>
                      <span class={styles.hint}>
                        {t("workflowFile.import.counts", {
                          steps: workflow.steps.length,
                          notes: workflow.notes.length,
                        })}
                      </span>
                    </span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="workflow-export-cc-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <Show when={saved()}>
          {(done) => (
            <>
              <p role="status" data-testid="workflow-export-cc-saved">
                {t("workflowFile.cc.saved", { path: done().path })}
              </p>
              <Show when={done().notExported.length > 0}>
                <NotExportedList items={done().notExported} />
              </Show>
            </>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="workflow-export-cc-close">
            {saved() ? t("workflowFile.close") : t("agents.cancel")}
          </Button>
          <Show when={!saved()}>
            <Button
              variant="primary"
              disabled={picked() === "" || busy()}
              onClick={submit}
              data-testid="workflow-export-cc-submit"
            >
              {t("workflowFile.export.submit")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

/** The failure of an import that made some workflows, read from its error detail. */
const readFailure = (error: unknown): WorkflowFileFailure | undefined => {
  if (!(error instanceof RpcFailure) || error.error.code !== "workflow_file_failed")
    return undefined
  try {
    return JSON.parse(error.error.message) as WorkflowFileFailure
  } catch {
    return undefined
  }
}

/** The mark of a workflow that lost a connection at a node of a CC Workflow Studio file. */
const LostMark = () => {
  const { t } = useApp()
  // It has the look of the mark of a hidden secret: both tell the user to look before the tick.
  return (
    <span class={review.secret} data-testid="workflow-import-lost">
      {t("importReview.lost")}
    </span>
  )
}

/**
 * The review before an import (spec 014): each workflow with a tick box, its trigger, its number
 * of steps and the agent names that the app cannot find, the part "Not imported", the counts and
 * the import button.
 */
export const ImportWorkflowsDialog = (props: {
  preview: WorkflowFilePreview
  onClose: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const [ticks, setTicks] = createSignal<boolean[]>(startWorkflowTicks(props.preview.workflows))
  /** For a file of CC Workflow Studio: the agent of every agent step. "" is "None". */
  const [agentId, setAgentId] = createSignal("")
  const agentFieldId = "wf-import-agent-field"
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  /** Set when the import stopped: the workflows made so far stay, so it cannot run again. */
  const [stopped, setStopped] = createSignal(false)
  const picks = () => workflowPicks(ticks())
  const tick = (index: number, on: boolean) =>
    setTicks(ticks().map((value, i) => (i === index ? on : value)))

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy() || stopped() || picks().length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      await call("workflowFile.apply", {
        serverId,
        pick: picks(),
        ...(props.preview.form === "cc" && agentId() !== "" ? { agentId: agentId() } : {}),
      })
      props.onClose()
    } catch (e) {
      const failure = readFailure(e)
      if (failure) {
        const reason = describeError(
          new RpcFailure({ code: failure.code, message: failure.detail ?? failure.code }),
        )
        setError({
          key: "workflowFile.import.stopped",
          params: { name: failure.name, made: failure.made, reason: t(reason.key, reason.params) },
        })
        setStopped(true)
      } else {
        setError(describeFileError(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={t("workflowFile.import.title")}
      onClose={props.onClose}
      testId="workflow-import-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("workflowFile.import.title")}</h2>
        <p class={styles.hint}>{t("importReview.workflows.intro")}</p>
        <ul class={review.review} data-testid="workflow-import-list">
          <For each={props.preview.workflows}>
            {(item, i) => (
              <li
                class={review.reviewItem}
                data-testid="workflow-import-item"
                data-ticked={ticks()[i()]}
              >
                <label class={review.row}>
                  <input
                    type="checkbox"
                    checked={ticks()[i()]}
                    onChange={(e) => tick(i(), e.currentTarget.checked)}
                    data-testid="workflow-import-tick"
                  />
                  <span class={review.rowText}>
                    <span class={styles.label}>{item.name}</span>
                    <Show when={item.fileName}>
                      {(original) => (
                        <span class={styles.hint}>
                          {t("workflowFile.import.renamed", { name: original() })}
                        </span>
                      )}
                    </Show>
                    <span class={styles.hint}>
                      {t(`workflows.trigger.${item.trigger}` as const)} ·{" "}
                      {t("workflowFile.import.counts", { steps: item.steps, notes: item.notes })}
                    </span>
                    <Show when={item.missingAgents.length > 0}>
                      <span class={styles.hint} data-testid="workflow-import-missing">
                        {t("importReview.missing", { names: item.missingAgents.join(", ") })}
                      </span>
                    </Show>
                    <Show when={item.needAgent > 0}>
                      <span class={styles.hint} data-testid="workflow-import-need-agent">
                        {t("importReview.needAgent", { count: item.needAgent })}
                      </span>
                    </Show>
                    <Show when={item.secretRemoved}>
                      <SecretMark />
                    </Show>
                    <Show when={item.lostConnections}>
                      <LostMark />
                    </Show>
                  </span>
                </label>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.preview.form === "cc"}>
          <div class={styles.field}>
            <label class={styles.label} for={agentFieldId}>
              {t("workflowFile.import.agent")}
            </label>
            <select
              id={agentFieldId}
              class={styles.input}
              value={agentId()}
              onChange={(e) => setAgentId(e.currentTarget.value)}
              data-testid="workflow-import-agent"
            >
              <option value="" selected={agentId() === ""}>
                {t("workflowFile.import.agent.none")}
              </option>
              <For each={agents.agents()}>
                {(a) => (
                  <option value={a.id} selected={a.id === agentId()}>
                    {a.name}
                  </option>
                )}
              </For>
            </select>
            <span class={styles.hint}>{t("workflowFile.import.agent.hint")}</span>
          </div>
        </Show>
        <NotImportedList items={props.preview.notImported} testId="workflow-import-not-imported" />
        <p class={styles.hint}>{t("workflowFile.import.off")}</p>
        <p class={review.counts} role="status" data-testid="workflow-import-counts">
          {picks().length === 0
            ? t("importReview.nothing")
            : t("importReview.counts.workflows", { workflows: picks().length })}
        </p>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="workflow-import-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="workflow-import-close">
            {stopped() ? t("workflowFile.close") : t("agents.cancel")}
          </Button>
          <Show when={!stopped()}>
            <Button
              variant="primary"
              disabled={busy() || picks().length === 0}
              onClick={submit}
              data-testid="workflow-import-submit"
            >
              {t("workflowFile.import.submit", { count: picks().length })}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

/** Tells why a file could not be read. */
export const WorkflowFileProblemDialog = (props: { problem: ErrorText; onClose: () => void }) => {
  const { t } = useApp()
  return (
    <Dialog
      label={t("workflowFile.import.title")}
      onClose={props.onClose}
      testId="workflow-file-problem"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("workflowFile.import.title")}</h2>
        <p role="alert" class={styles.error} data-testid="workflow-file-problem-text">
          {t(props.problem.key, props.problem.params)}
        </p>
        <div class={styles.actions}>
          <Button variant="primary" onClick={props.onClose}>
            {t("workflowFile.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
