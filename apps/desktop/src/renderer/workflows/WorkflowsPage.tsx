import type { Workflow, WorkflowDetail } from "@robot/shared"
import { ArrowLeft, Plus, Trash2 } from "lucide-solid"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./workflows.module.css"

/** The dialog "New workflow": the name only. The screen that builds the rest comes later. */
const NewWorkflowDialog = (props: { serverId: string; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [name, setName] = createSignal("")
  const [problem, setProblem] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const create = async () => {
    setBusy(true)
    try {
      const made = await call("workflows.create", { serverId: props.serverId, name: name() })
      props.onClose()
      ui.selectPlace({ kind: "workflow", id: made.id })
    } catch (e) {
      setProblem(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog label={t("workflows.new")} onClose={props.onClose} testId="new-workflow-dialog">
      <h2>{t("workflows.new")}</h2>
      <input
        class={styles.input}
        value={name()}
        placeholder={t("workflows.name")}
        aria-label={t("workflows.name")}
        data-testid="new-workflow-name"
        onInput={(e) => {
          setName(e.currentTarget.value)
          setProblem(undefined)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name().trim() !== "") void create()
        }}
      />
      <Show when={problem()}>
        {(p) => (
          <p class={styles.error} role="alert" data-testid="new-workflow-error">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
      <div class={shell.dialogActions}>
        <Button onClick={props.onClose}>{t("workflows.cancel")}</Button>
        <Button
          variant="primary"
          disabled={busy() || name().trim() === ""}
          onClick={() => void create()}
          data-testid="new-workflow-create"
        >
          {t("workflows.create")}
        </Button>
      </div>
    </Dialog>
  )
}

/** The workflow that is open: its name and its responsible document. */
const WorkflowView = (props: { id: string }) => {
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
              onKeep={() => setAsking(false)}
              onConfirm={() => {
                void call("workflows.delete", { id: flow().id }).then(ui.closePlace)
              }}
            />
          )}
        </Show>
        <p class={styles.label}>{t("workflows.document")}</p>
        <Show
          when={detail()?.document}
          fallback={<p class={styles.empty}>{t("workflows.document.empty")}</p>}
        >
          {(text) => (
            <pre class={styles.document} data-testid="workflow-document">
              {text()}
            </pre>
          )}
        </Show>
      </div>
    </>
  )
}

/** The page "Workflows": the list of the workflows of the open server, and the open workflow. */
export const WorkflowsPage = () => {
  const { t } = useApp()
  const ui = useUi()
  const [creating, setCreating] = createSignal(false)
  const [list, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId): Promise<readonly Workflow[]> =>
      call("workflows.list", { serverId }).catch(() => []),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  const open = () => {
    const ref = ui.place()
    return ref && list()?.some((w) => w.id === ref.id) ? ref.id : undefined
  }
  return (
    <Show
      when={open()}
      keyed
      fallback={
        <>
          <header class={shell.header}>
            <span class={shell.headerTitle}>{t("page.workflows")}</span>
            <span class={shell.headerSpacer} />
            <IconButton
              label={t("workflows.new")}
              onClick={() => setCreating(true)}
              data-testid="new-workflow"
            >
              <Plus size={18} />
            </IconButton>
          </header>
          <div class={styles.page} data-testid="workflows-page">
            <Show
              when={(list() ?? []).length > 0}
              fallback={
                <p class={styles.empty} data-testid="workflows-empty">
                  {t("workflows.empty")}
                </p>
              }
            >
              <ul class={styles.list}>
                <For each={list()}>
                  {(flow) => (
                    <li class={styles.row} data-testid="workflow-row">
                      <button
                        type="button"
                        class={styles.open}
                        onClick={() => ui.selectPlace({ kind: "workflow", id: flow.id })}
                      >
                        <span class={styles.name}>{flow.name}</span>
                        <span class={styles.meta}>
                          {t("workflows.nodes", { n: flow.nodeCount })}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
          <Presence when={creating() ? ui.server() : undefined}>
            {(server) => (
              <NewWorkflowDialog serverId={server.id} onClose={() => setCreating(false)} />
            )}
          </Presence>
        </>
      }
    >
      {(id) => <WorkflowView id={id} />}
    </Show>
  )
}
