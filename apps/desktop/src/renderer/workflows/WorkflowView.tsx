import type { WorkflowDetail } from "@robot/shared"
import { ArrowLeft, Trash2 } from "lucide-solid"
import { createResource, createSignal, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { IconButton } from "../ui/controls.tsx"
import { DocumentEditor } from "./DocumentEditor.tsx"
import styles from "./workflows.module.css"

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
            onClick={() => setAsking(true)}
            data-testid="workflow-delete"
          >
            <Trash2 size={18} />
          </IconButton>
        </Show>
      </header>
      <div class={styles.page} data-testid="workflow-view">
        <Show when={asking() && detail()}>
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
        <Show when={detail()}>{(flow) => <DocumentEditor workflow={flow()} />}</Show>
      </div>
    </>
  )
}
