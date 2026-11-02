import type { MessageKey, Workflow, WorkflowFilePreview } from "@robot/shared"
import { Ellipsis } from "lucide-solid"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import type { ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { RoutinesView } from "../routines/RoutinesPage.tsx"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { flashRow, openTarget, takeTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented, Switch } from "../ui/controls.tsx"
import { Menu } from "../ui/Menu.tsx"
import { Presence } from "../ui/Presence.tsx"
import { WorkflowEditor } from "./WorkflowEditor.tsx"
import {
  describeFileError,
  ExportWorkflowsDialog,
  ImportWorkflowsDialog,
  WorkflowFileProblemDialog,
} from "./WorkflowFileDialogs.tsx"
import styles from "./workflows.module.css"

const WorkflowList = (props: { onOpen: (workflow: Workflow | null) => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [workflows, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("workflows.list", { serverId }),
    { initialValue: [] as readonly Workflow[] },
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  // The Today page asks for a workflow: its card lights up. A workflow that is gone is dropped.
  createEffect(() => {
    const target = openTarget()
    const list = workflows()
    if (target?.kind !== "workflow" || workflows.loading) return
    if (list.some((w) => w.id === target.id)) {
      queueMicrotask(() => {
        if (flashRow(`[data-workflow-id="${target.id}"]`)) takeTarget("workflow")
      })
    } else takeTarget("workflow")
  })
  const [exporting, setExporting] = createSignal(false)
  const [importPreview, setImportPreview] = createSignal<WorkflowFilePreview>()
  const [fileProblem, setFileProblem] = createSignal<ErrorText>()

  /** Asks for a workflow file. A readable file opens the dialog that lists its workflows. */
  const startImport = async () => {
    const serverId = ui.server()?.id
    if (!serverId) return
    try {
      const found = await call("workflowFile.open", { serverId })
      if (found) setImportPreview(found)
    } catch (e) {
      setFileProblem(describeFileError(e))
    }
  }

  return (
    <div class={styles.list} data-testid="wf-list">
      <div class={styles.bar}>
        <Button variant="primary" onClick={() => props.onOpen(null)} data-testid="wf-new">
          {t("workflows.new")}
        </Button>
        <Menu
          label={t("workflowFile.menu")}
          icon={<Ellipsis size={16} />}
          testId="wf-menu"
          items={[
            {
              label: t("workflowFile.menu.export"),
              onSelect: () => setExporting(true),
              testId: "wf-menu-export",
            },
            {
              label: t("workflowFile.menu.importFile"),
              onSelect: () => void startImport(),
              testId: "wf-menu-import-file",
            },
          ]}
        />
      </div>
      <Presence when={exporting()}>
        {() => (
          <ExportWorkflowsDialog workflows={workflows()} onClose={() => setExporting(false)} />
        )}
      </Presence>
      <Presence when={importPreview()}>
        {(preview) => (
          <ImportWorkflowsDialog preview={preview} onClose={() => setImportPreview(undefined)} />
        )}
      </Presence>
      <Presence when={fileProblem()}>
        {(problem) => (
          <WorkflowFileProblemDialog problem={problem} onClose={() => setFileProblem(undefined)} />
        )}
      </Presence>
      <Show
        when={workflows().length > 0}
        fallback={
          <p class={styles.hint} data-testid="wf-list-empty">
            {t("workflows.empty")}
          </p>
        }
      >
        <For each={workflows()}>
          {(w) => (
            <div
              class={styles.card}
              data-testid="wf-card"
              data-running={w.running}
              data-enabled={w.enabled}
              data-workflow-id={w.id}
            >
              <div class={styles.cardMain}>
                <strong>{w.name}</strong>
                <span class={styles.hint}>
                  {t(`workflows.trigger.${w.trigger.kind}` as MessageKey)} ·{" "}
                  {t("workflows.stepCount", { n: w.steps.length })}
                  {w.running ? ` · ${t("workflows.runState.running")}` : ""}
                  {w.enabled ? "" : ` · ${t("workflows.off")}`}
                </span>
                <Show when={w.runsOn !== null}>
                  <span class={styles.hint} data-testid="wf-runs-on">
                    {t("sync.runsOn", { name: w.runsOn || t("sync.anotherComputer") })}
                  </span>
                </Show>
              </div>
              <Switch
                label={t("workflows.enabled.label", { name: w.name })}
                checked={w.enabled}
                onChange={(enabled) => call("workflows.update", { id: w.id, patch: { enabled } })}
                testId="wf-enabled"
              />
              <Show
                when={w.runsOn === null}
                fallback={
                  <Button
                    onClick={() => call("workflows.runHere", { id: w.id })}
                    data-testid="wf-run-here"
                  >
                    {t("sync.runHere")}
                  </Button>
                }
              >
                <Button
                  onClick={() => call("workflows.run", { id: w.id })}
                  disabled={w.running}
                  data-testid="wf-card-run"
                >
                  {t("workflows.run")}
                </Button>
              </Show>
              <Button onClick={() => props.onOpen(w)} data-testid="wf-open">
                {t("workflows.open")}
              </Button>
              <Button
                disabled={w.running}
                onClick={() => call("workflows.delete", { id: w.id })}
                data-testid="wf-delete-card"
              >
                {t("agents.memory.delete")}
              </Button>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

/** The page of routines and workflows. */
export const WorkflowsPage = () => {
  const { t } = useApp()
  const [tab, setTab] = createSignal<"routines" | "workflows">("routines")
  const [open, setOpen] = createSignal<{ workflow: Workflow | null }>()
  // The Today page asks for a routine or a workflow: the page shows the tab that holds it.
  createEffect(() => {
    const target = openTarget()
    if (target?.kind === "routine") setTab("routines")
    else if (target?.kind === "workflow") setTab("workflows")
    if (target?.kind === "routine" || target?.kind === "workflow") setOpen(undefined)
  })
  return (
    <div class={`${shell.page} ${styles.page}`} data-testid="workflows-page">
      <Show
        when={open()}
        fallback={
          <>
            <Segmented
              label={t("workflows.tabs")}
              value={tab()}
              options={[
                { value: "routines", label: t("workflows.tab.routines") },
                { value: "workflows", label: t("workflows.tab.workflows") },
              ]}
              onChange={setTab}
              testId="wf-tabs"
            />
            <Show
              when={tab() === "routines"}
              fallback={<WorkflowList onOpen={(workflow) => setOpen({ workflow })} />}
            >
              <RoutinesView />
            </Show>
          </>
        }
      >
        {(o) => <WorkflowEditor workflow={o().workflow} onBack={() => setOpen(undefined)} />}
      </Show>
    </div>
  )
}
