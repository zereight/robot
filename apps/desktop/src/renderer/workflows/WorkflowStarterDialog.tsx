import {
  buildTlaStarter,
  defaultStarterAgent,
  starterWorkflowName,
  WORKFLOW_STARTERS,
  type Workflow,
  type WorkflowStarterId,
  workflowStarterText,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import styles from "../agents/agents.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import workflowStyles from "./workflows.module.css"

/**
 * "New from a starter" (spec 010, "Starters"): the list of starters, the field "Agent", and
 * Create. The window picks the text in the language of the interface at the moment of Create and
 * sends a finished workflow, so a linked computer with the switch "Can create and change agents"
 * makes it the same way, and the app that holds the workflows reads no text catalogue.
 */
export const WorkflowStarterDialog = (props: {
  onClose: () => void
  onCreated: (workflow: Workflow) => void
}) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const agents = useAgents()
  const [starter, setStarter] = createSignal<WorkflowStarterId>(WORKFLOW_STARTERS[0])
  const [picked, setPicked] = createSignal(defaultStarterAgent(agents.agents()))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const agentFieldId = "wf-starter-agent-field"

  /** The agent that Create uses. An agent that left the list while the box was open does not count. */
  const agentId = () =>
    agents.agents().some((a) => a.id === picked()) ? picked() : defaultStarterAgent(agents.agents())

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const serverId = ui.server()?.id
    const agent = agentId()
    if (!serverId || agent === "" || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      // The language of the interface at this moment decides the text of the workflow.
      const text = workflowStarterText(app.locale(), starter())
      // The names are read again now, so a workflow made a moment ago counts.
      const taken = (await call("workflows.list", { serverId })).map((w) => w.name)
      const made = await call(
        "workflows.create",
        buildTlaStarter({
          serverId,
          name: starterWorkflowName(text.name, taken),
          agentId: agent,
          text,
        }),
      )
      props.onCreated(made)
    } catch (e) {
      setError(describeError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog label={t("workflowStarter.title")} onClose={props.onClose} testId="wf-starter-dialog">
      <form class={styles.form} onSubmit={submit}>
        <h2 class={styles.title}>{t("workflowStarter.title")}</h2>
        <p class={styles.hint}>{t("workflowStarter.hint")}</p>
        <fieldset class={`${styles.field} ${styles.group}`}>
          <legend class={styles.label}>{t("workflowStarter.list")}</legend>
          <div class={workflowStyles.starterRows}>
            <For each={WORKFLOW_STARTERS}>
              {(id) => {
                const text = () => workflowStarterText(app.locale(), id)
                return (
                  <button
                    type="button"
                    class={styles.starter}
                    aria-pressed={starter() === id}
                    data-testid={`wf-starter-${id}`}
                    onClick={() => setStarter(id)}
                  >
                    <span class={styles.starterName}>{text().name}</span>
                    <span class={styles.starterJob}>{text().job}</span>
                    <span class={styles.starterExtras} data-testid={`wf-starter-${id}-needs`}>
                      {text().needs}
                    </span>
                  </button>
                )
              }}
            </For>
          </div>
        </fieldset>
        <div class={styles.field}>
          <label class={styles.label} for={agentFieldId}>
            {t("workflowStarter.agent")}
          </label>
          <select
            id={agentFieldId}
            class={styles.input}
            value={agentId()}
            onChange={(e) => setPicked(e.currentTarget.value)}
            data-testid="wf-starter-agent"
          >
            <For each={agents.agents()}>
              {(a) => (
                <option value={a.id} selected={a.id === agentId()}>
                  {a.name}
                </option>
              )}
            </For>
          </select>
          <span class={styles.hint}>{t("workflowStarter.agent.hint")}</span>
        </div>
        <Show when={error()}>
          {(problem) => (
            <div class={styles.error} role="alert" data-testid="wf-starter-error">
              {t(problem().key, problem().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="wf-starter-cancel">
            {t("agents.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy() || agentId() === ""}
            data-testid="wf-starter-create"
          >
            {t("workflowStarter.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
