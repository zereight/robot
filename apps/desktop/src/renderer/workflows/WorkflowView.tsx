import type { WorkflowDetail } from "@robot/shared"
import { PanelLeft, PanelRight, Play, Square, Trash2 } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { improveRequest, openImprovement } from "../state/improve.ts"
import { clearRunRequest, runRequest } from "../state/runTarget.ts"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { tabKeyDown } from "../ui/tabKeys.ts"
import { showToast } from "../ui/toast.ts"
import { DocumentEditor } from "./DocumentEditor.tsx"
import { GraphEditor } from "./GraphEditor.tsx"
import graph from "./graph.module.css"
import { ImprovementPanel } from "./ImprovementPanel.tsx"
import { showsProposals, type WorkflowTab, workflowTabs } from "./improveView.ts"
import { checkStateKey } from "./labels.ts"
import { MemoryPanel } from "./MemoryPanel.tsx"
import { RunsPanel } from "./RunsPanel.tsx"
import type { createRunsState } from "./runsState.ts"
import { WorkflowSettings } from "./WorkflowSettings.tsx"
import styles from "./workflows.module.css"

type Tab = WorkflowTab

/** The centre column of the studio: the header and one part of the open workflow (spec 001). */
export const WorkflowView = (props: {
  id: string
  runs: ReturnType<typeof createRunsState>
  onShowList: () => void
  onShowChat: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [detail, { refetch }] = createResource(
    () => props.id,
    (id): Promise<WorkflowDetail | undefined> =>
      call("workflows.get", { id }).catch(() => undefined),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  const [asking, setAsking] = createSignal(false)
  const [tab, setTab] = createSignal<Tab>("graph")
  const local = () => showsProposals(ui.server()?.kind)
  const tabs = createMemo(() => workflowTabs(local()))
  const runs = () => props.runs
  const [selected, setSelected] = createSignal<string>()
  // The link "Review" (chat, run view) and the link "Proposals (N)" open the page Self-improvement.
  createEffect(
    on(
      improveRequest,
      (r) => {
        if (r && r.workflowId === props.id && local()) setTab("improvement")
      },
      { defer: true },
    ),
  )
  // The action "Open the run" of the Tasks page opens the runs of this workflow at that run.
  createEffect(() => {
    const r = runRequest()
    if (!r || r.workflowId !== props.id) return
    setTab("runs")
    setSelected(r.runId)
    clearRunRequest()
  })
  const [trigger, setTrigger] = createSignal("")
  const toastError = (e: unknown) => {
    const text = describeError(e)
    showToast("error", text.key, text.params)
  }
  /** Starts a run by hand and shows it (spec 010). */
  const start = () =>
    void call("runs.start", { workflowId: props.id, ...(trigger() ? { trigger: trigger() } : {}) })
      .then((run) => {
        setSelected(run.id)
        setTab("runs")
        void runs().refetch()
      })
      .catch(toastError)
  /** Stops the run that works now. A run that waits in the queue has its own Stop. */
  const stop = () => {
    const current = runs().active()[0]
    if (current) void call("runs.stop", { runId: current.id }).catch(toastError)
  }
  return (
    <>
      <header class={shell.header} data-testid="workflow-header">
        <Show when={!ui.listDocked()}>
          <IconButton
            label={t("studio.list.show")}
            onClick={props.onShowList}
            data-testid="studio-show-list"
          >
            <PanelLeft size={18} />
          </IconButton>
        </Show>
        <span class={shell.headerTitle}>{detail()?.name}</span>
        <Show when={detail()}>
          {(flow) => (
            <span
              class={shell.headerTopic}
              data-testid="workflow-header-check"
              data-problem={flow().check === "problem"}
            >
              {t("workflows.check.line", { state: t(checkStateKey(flow())) })}
            </span>
          )}
        </Show>
        <span class={shell.headerSpacer} />
        <Show when={detail()}>
          <Show when={runs().active().length > 0}>
            <Button variant="danger" onClick={stop} data-testid="workflow-stop">
              <Square size={14} /> {t("runs.stop")}
            </Button>
          </Show>
          <Button variant="primary" onClick={start} data-testid="workflow-run">
            <Play size={14} /> {t("runs.start")}
          </Button>
          <IconButton
            label={t("workflows.delete")}
            disabled={detail()?.running}
            onClick={() => setAsking(true)}
            data-testid="workflow-delete"
          >
            <Trash2 size={18} />
          </IconButton>
        </Show>
        <Show
          when={ui.narrow()}
          fallback={
            <IconButton
              label={ui.panelOpen() ? t("studio.chat.hide") : t("studio.chat.show")}
              onClick={() => ui.selectPanelOpen(!ui.panelOpen())}
              data-testid="studio-toggle-chat"
            >
              <PanelRight size={18} />
            </IconButton>
          }
        >
          <IconButton
            label={t("studio.chat.show")}
            onClick={props.onShowChat}
            data-testid="studio-show-chat"
          >
            <PanelRight size={18} />
          </IconButton>
        </Show>
      </header>
      <div class={styles.view} data-testid="workflow-view">
        <Show when={detail()?.running}>
          <p class={styles.hint} role="status" data-testid="workflow-running-readonly">
            {t("workflows.readonly")}
          </p>
        </Show>
        <Show when={asking() && !detail()?.running ? detail() : undefined}>
          {(flow) => (
            <Confirm
              ask={t("workflows.delete.ask", { name: flow().name })}
              confirm={t("workflows.delete")}
              keep={t("common.keep")}
              testId="workflow-delete-ask"
              confirmTestId="workflow-delete-confirm"
              keepTestId="workflow-delete-keep"
              onKeep={() => setAsking(false)}
              onConfirm={() => {
                void call("workflows.delete", { id: flow().id }).then(ui.closePlace)
              }}
            />
          )}
        </Show>
        <Show when={detail()}>
          {(flow) => (
            <>
              <div class={graph.tabs} role="tablist" aria-label={t("workflows.tabs")}>
                <For each={tabs()}>
                  {(name) => (
                    <button
                      type="button"
                      role="tab"
                      class={graph.tab}
                      aria-selected={tab() === name}
                      tabIndex={tab() === name ? 0 : -1}
                      data-testid={`tab-${name}`}
                      onClick={() => setTab(name)}
                      onKeyDown={(e) => tabKeyDown(e, tabs(), tab(), setTab)}
                    >
                      {t(`workflows.tab.${name}`)}
                    </button>
                  )}
                </For>
              </div>
              <Switch>
                <Match when={tab() === "graph"}>
                  <GraphEditor workflow={flow()} runningNodes={runs().runningNodes()} />
                </Match>
                <Match when={tab() === "runs"}>
                  <RunsPanel
                    workflowId={flow().id}
                    runs={runs().runs() ?? []}
                    selected={selected()}
                    onSelect={setSelected}
                    trigger={trigger()}
                    onTrigger={setTrigger}
                  />
                </Match>
                <Match when={tab() === "document"}>
                  <DocumentEditor workflow={flow()} />
                </Match>
                <Match when={tab() === "memory"}>
                  <MemoryPanel
                    workflow={flow()}
                    onOpenProposals={() => openImprovement(flow().id)}
                  />
                </Match>
                <Match when={tab() === "improvement" && local()}>
                  <ImprovementPanel
                    workflow={flow()}
                    onOpenRun={(id) => {
                      setSelected(id)
                      setTab("runs")
                    }}
                  />
                </Match>
                <Match when={tab() === "settings"}>
                  <WorkflowSettings workflow={flow()} />
                </Match>
              </Switch>
            </>
          )}
        </Show>
      </div>
    </>
  )
}
