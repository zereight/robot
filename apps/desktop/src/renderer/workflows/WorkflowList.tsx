import type { Workflow } from "@robot/shared"
import { Plus, Trash2 } from "lucide-solid"
import { createResource, createSignal, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { Presence } from "../ui/Presence.tsx"
import { Spinner } from "../ui/Spinner.tsx"
import { showsProposals } from "./improveView.ts"
import { checkStateKey, runStateKey } from "./labels.ts"
import { NewWorkflowDialog } from "./NewWorkflowDialog.tsx"
import styles from "./workflows.module.css"

/** One card of the list (spec 001): the name, the state of the last run, the state of the check. */
const Card = (props: { flow: Workflow }) => {
  const { t } = useApp()
  const ui = useUi()
  const [asking, setAsking] = createSignal(false)
  const lastRun = () => {
    const run = props.flow.lastRun
    if (!run) return t("workflows.run.none")
    const key = runStateKey(run.state)
    return key ? t("workflows.run.last", { state: t(key) }) : t("workflows.run.unknown")
  }
  const selected = () => ui.place()?.id === props.flow.id
  return (
    <li class={styles.card} data-selected={selected()} data-testid="workflow-row">
      <div class={styles.cardTop}>
        <button
          type="button"
          class={styles.open}
          aria-label={t("workflows.card.open", { name: props.flow.name })}
          aria-current={selected() ? true : undefined}
          data-testid="workflow-open"
          onClick={() => ui.selectPlace({ kind: "workflow", id: props.flow.id })}
        >
          <span class={styles.name}>{props.flow.name}</span>
          <Show when={props.flow.working}>
            <Spinner testId="workflow-card-spinner" />
          </Show>
        </button>
        <IconButton
          label={t("workflows.delete")}
          disabled={props.flow.running}
          onClick={() => setAsking(true)}
          data-testid="workflow-card-delete"
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
      <Show when={props.flow.running}>
        <p class={styles.hint} role="status" data-testid="workflow-card-readonly">
          {t("workflows.readonly")}
        </p>
      </Show>
      <dl class={styles.facts}>
        <div>
          <dt class={styles.hidden}>{t("workflows.nodes", { n: props.flow.nodeCount })}</dt>
          <dd data-testid="workflow-nodes">
            {props.flow.nodeCount === 1
              ? t("workflows.nodes.one")
              : t("workflows.nodes", { n: props.flow.nodeCount })}
          </dd>
        </div>
        <div>
          <dd data-testid="workflow-last-run">{lastRun()}</dd>
        </div>
        <div>
          <dd data-testid="workflow-check" data-problem={props.flow.check === "problem"}>
            {t("workflows.check.line", { state: t(checkStateKey(props.flow)) })}
          </dd>
        </div>
        {/* The proposals stay on the computer that holds them: a linked server shows no line. */}
        <Show when={showsProposals(ui.server()?.kind) && props.flow.proposals > 0}>
          <div>
            <dd data-testid="workflow-proposals">
              {t(
                props.flow.proposals === 1
                  ? "workflows.card.proposals.one"
                  : "workflows.card.proposals.other",
                { n: props.flow.proposals },
              )}
            </dd>
          </div>
        </Show>
      </dl>
      <Show when={asking()}>
        <Confirm
          ask={t("workflows.delete.ask", { name: props.flow.name })}
          confirm={t("workflows.delete")}
          keep={t("common.keep")}
          testId="workflow-delete-ask"
          confirmTestId="workflow-delete-confirm"
          keepTestId="workflow-delete-keep"
          onKeep={() => setAsking(false)}
          onConfirm={() => {
            void call("workflows.delete", { id: props.flow.id }).finally(() => setAsking(false))
          }}
        />
      </Show>
    </li>
  )
}

/**
 * The list of the workflows of the open server (spec 001). With no workflow it shows one line that
 * says what a workflow is, and the button "New workflow".
 */
export const WorkflowList = () => {
  const { t } = useApp()
  const ui = useUi()
  const [creating, setCreating] = createSignal(false)
  const [list, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId): Promise<readonly Workflow[]> =>
      call("workflows.list", { serverId }).catch(() => []),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  // A proposal that waits shows on the card: "N proposals wait" (spec 002, "Flows" 1).
  onCleanup(window.robot.on("proposals.changed", () => void refetch()))
  return (
    <>
      <header class={shell.header}>
        <span class={shell.headerTitle}>{t("page.workflows")}</span>
        <span class={shell.headerSpacer} />
        <Show when={(list() ?? []).length > 0}>
          <IconButton
            label={t("workflows.new")}
            onClick={() => setCreating(true)}
            data-testid="new-workflow"
          >
            <Plus size={18} />
          </IconButton>
        </Show>
      </header>
      <div class={styles.page} data-testid="workflows-page">
        <Show
          when={(list() ?? []).length > 0}
          fallback={
            <Show when={list.state === "ready"}>
              <div class={styles.emptyState}>
                <p class={styles.empty} data-testid="workflows-empty">
                  {t("workflows.empty")}
                </p>
                <p class={styles.hint}>{t("workflows.empty.hint")}</p>
                <Button
                  variant="primary"
                  onClick={() => setCreating(true)}
                  data-testid="new-workflow-empty"
                >
                  {t("workflows.new")}
                </Button>
              </div>
            </Show>
          }
        >
          <ul class={styles.cards}>
            <Keyed each={list()} by={(flow) => flow.id}>
              {(flow) => <Card flow={flow()} />}
            </Keyed>
          </ul>
        </Show>
      </div>
      <Presence when={creating() ? ui.server() : undefined}>
        {(server) => <NewWorkflowDialog serverId={server.id} onClose={() => setCreating(false)} />}
      </Presence>
    </>
  )
}
