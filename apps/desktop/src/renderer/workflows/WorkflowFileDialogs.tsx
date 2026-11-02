import {
  type GraphFault,
  WORKFLOW_FILE_MAX_WORKFLOWS,
  type Workflow,
  type WorkflowFileFailure,
  type WorkflowFilePreview,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import styles from "../agents/agents.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
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

/** List what the file will make and which agents it cannot find, and ask to confirm. */
export const ImportWorkflowsDialog = (props: {
  preview: WorkflowFilePreview
  onClose: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  /** Set when the import stopped: the workflows made so far stay, so it cannot run again. */
  const [stopped, setStopped] = createSignal(false)

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy() || stopped()) return
    setBusy(true)
    setError(undefined)
    try {
      await call("workflowFile.import", { serverId })
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
        <p class={styles.hint}>{t("workflowFile.import.intro")}</p>
        <ul class={styles.fileList} data-testid="workflow-import-list">
          <For each={props.preview.workflows}>
            {(item) => (
              <li class={styles.fileRow} data-testid="workflow-import-item">
                <span class={styles.fileText}>
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
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.preview.missingAgents.length > 0}>
          <div data-testid="workflow-import-missing">
            <p class={styles.hint}>{t("workflowFile.import.missing")}</p>
            <ul>
              <For each={props.preview.missingAgents}>
                {(name) => <li data-testid="workflow-import-missing-name">{name}</li>}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={props.preview.postSteps > 0}>
          <p class={styles.hint} data-testid="workflow-import-places">
            {t("workflowFile.import.places", { count: props.preview.postSteps })}
          </p>
        </Show>
        <p class={styles.hint}>{t("workflowFile.import.off")}</p>
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
              disabled={busy()}
              onClick={submit}
              data-testid="workflow-import-submit"
            >
              {t("workflowFile.import.submit", { count: props.preview.workflows.length })}
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
