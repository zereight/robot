import type { MessageKey, Workflow } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { RoutinesView } from "../routines/RoutinesPage.tsx"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented } from "../ui/controls.tsx"
import { WorkflowEditor } from "./WorkflowEditor.tsx"
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
  return (
    <div class={styles.list} data-testid="wf-list">
      <div class={styles.bar}>
        <Button variant="primary" onClick={() => props.onOpen(null)} data-testid="wf-new">
          {t("workflows.new")}
        </Button>
      </div>
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
            <div class={styles.card} data-testid="wf-card" data-running={w.running}>
              <div class={styles.cardMain}>
                <strong>{w.name}</strong>
                <span class={styles.hint}>
                  {t(`workflows.trigger.${w.trigger.kind}` as MessageKey)} ·{" "}
                  {t("workflows.stepCount", { n: w.steps.length })}
                  {w.running ? ` · ${t("workflows.runState.running")}` : ""}
                </span>
              </div>
              <Button
                onClick={() => call("workflows.run", { id: w.id })}
                disabled={w.running}
                data-testid="wf-card-run"
              >
                {t("workflows.run")}
              </Button>
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
