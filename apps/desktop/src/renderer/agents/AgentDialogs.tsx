import type { Agent } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { KnowledgePage } from "../knowledge/KnowledgePage.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { AgentForm } from "./AgentForm.tsx"
import styles from "./agents.module.css"
import { markBorn } from "./reactions.ts"

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
          markBorn(agent.id)
          props.onClose()
          ui.selectPlace({ kind: "agent", id: agent.id })
        }}
      />
    </Dialog>
  )
}

/** Edit an agent, or duplicate or archive it. A second page shows its knowledge. */
export const AgentProfileDialog = (props: { agent: Agent; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [error, setError] = createSignal<ErrorText>()
  const [tab, setTab] = createSignal<"profile" | "knowledge">("profile")

  const act = async (run: () => Promise<void>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <Dialog
      label={t("agents.profile")}
      onClose={props.onClose}
      testId="agent-profile"
      wide={tab() === "knowledge"}
    >
      <Segmented
        label={t("agents.profile")}
        value={tab()}
        options={[
          { value: "profile", label: t("agents.tab.profile") },
          { value: "knowledge", label: t("agents.tab.knowledge") },
        ]}
        onChange={setTab}
        testId="profile-tabs"
      />
      {/* The form stays in place on the other page, so that nothing typed is lost. */}
      <div class={styles.pane} hidden={tab() !== "profile"}>
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
          <span class={styles.hint} title={props.agent.workspace} data-user-data>
            {t("agents.workspace")}: {props.agent.workspace}
          </span>
        </div>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert">
              {t(err().key, err().params)}
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
      </div>
      <Show when={tab() === "knowledge"}>
        <KnowledgePage agent={props.agent} onClose={props.onClose} />
      </Show>
    </Dialog>
  )
}
