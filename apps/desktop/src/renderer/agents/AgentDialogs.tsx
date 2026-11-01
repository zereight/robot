import type { Agent } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { errorKey } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { AgentForm } from "./AgentForm.tsx"
import styles from "./agents.module.css"

export const NewAgentDialog = (props: { onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  return (
    <Dialog label={t("agents.create.title")} onClose={props.onClose} testId="new-agent-dialog">
      <AgentForm
        onCancel={props.onClose}
        onSubmit={async (values) => {
          const serverId = ui.server()?.id
          if (!serverId) return
          const agent = await call("agents.create", { serverId, ...values })
          props.onClose()
          ui.selectPlace({ kind: "agent", id: agent.id })
        }}
      />
    </Dialog>
  )
}

/** Edit an agent, or duplicate or archive it. */
export const AgentProfileDialog = (props: { agent: Agent; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [error, setError] = createSignal<ReturnType<typeof errorKey>>()

  const act = async (run: () => Promise<void>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(errorKey(e))
    }
  }

  return (
    <Dialog label={t("agents.profile")} onClose={props.onClose} testId="agent-profile">
      <AgentForm
        agent={props.agent}
        onCancel={props.onClose}
        onSubmit={async (values) => {
          await call("agents.update", { id: props.agent.id, patch: values })
          props.onClose()
        }}
        onPicture={async (dataUrl) => {
          await call("agents.setFaceImage", { id: props.agent.id, dataUrl })
        }}
      />
      <div class={styles.spread}>
        <span class={styles.hint} title={props.agent.workspace}>
          {t("agents.workspace")}: {props.agent.workspace}
        </span>
      </div>
      <Show when={error()}>
        {(key) => (
          <div class={styles.error} role="alert">
            {t(key())}
          </div>
        )}
      </Show>
      <div class={styles.actions}>
        <Button
          data-testid="agent-duplicate"
          onClick={() =>
            act(async () => {
              const copy = await call("agents.duplicate", {
                id: props.agent.id,
                suffix: t("agents.copySuffix"),
              })
              props.onClose()
              ui.selectPlace({ kind: "agent", id: copy.id })
            })
          }
        >
          {t("agents.duplicate")}
        </Button>
        <Button
          data-testid="agent-archive"
          onClick={() =>
            act(async () => {
              await call("agents.archive", { id: props.agent.id })
              props.onClose()
            })
          }
        >
          {t("agents.archive")}
        </Button>
      </div>
    </Dialog>
  )
}
