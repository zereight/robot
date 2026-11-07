import type { WorkflowDetail } from "@robot/shared"
import { ArrowLeft, Trash2 } from "lucide-solid"
import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { ChatPanel } from "../chat/ChatPanel.tsx"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { IconButton } from "../ui/controls.tsx"
import { DocumentEditor } from "./DocumentEditor.tsx"
import { GraphEditor } from "./GraphEditor.tsx"
import graph from "./graph.module.css"
import { WorkflowSettings } from "./WorkflowSettings.tsx"
import styles from "./workflows.module.css"

const TABS = ["graph", "document", "settings"] as const
type Tab = (typeof TABS)[number]

/** The workflow that is open: its name, and the editor of its responsible document. */
export const WorkflowView = (props: { id: string }) => {
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
  return (
    <>
      <header class={shell.header} data-testid="workflow-header">
        <IconButton label={t("workflows.back")} onClick={ui.closePlace} data-testid="workflow-back">
          <ArrowLeft size={18} />
        </IconButton>
        <span class={shell.headerTitle}>{detail()?.name}</span>
        <span class={shell.headerSpacer} />
        <Show when={detail()}>
          <IconButton
            label={t("workflows.delete")}
            disabled={detail()?.running}
            onClick={() => setAsking(true)}
            data-testid="workflow-delete"
          >
            <Trash2 size={18} />
          </IconButton>
        </Show>
      </header>
      <div class={styles.split} data-narrow={ui.narrow()} data-testid="workflow-view">
        <div class={styles.splitMain}>
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
                  <For each={TABS}>
                    {(name) => (
                      <button
                        type="button"
                        role="tab"
                        class={graph.tab}
                        aria-selected={tab() === name}
                        data-testid={`tab-${name}`}
                        onClick={() => setTab(name)}
                      >
                        {t(`workflows.tab.${name}`)}
                      </button>
                    )}
                  </For>
                </div>
                <Switch>
                  <Match when={tab() === "graph"}>
                    <GraphEditor workflow={flow()} />
                  </Match>
                  <Match when={tab() === "document"}>
                    <DocumentEditor workflow={flow()} />
                  </Match>
                  <Match when={tab() === "settings"}>
                    <WorkflowSettings workflow={flow()} />
                  </Match>
                </Switch>
              </>
            )}
          </Show>
        </div>
        <Show when={detail()}>
          {(flow) => (
            <aside class={styles.chatColumn}>
              <ChatPanel workflowId={flow().id} />
            </aside>
          )}
        </Show>
      </div>
    </>
  )
}
