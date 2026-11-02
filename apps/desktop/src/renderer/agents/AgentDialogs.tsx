import type { Agent, AgentPatch, MessageKey } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { KnowledgePage } from "../knowledge/KnowledgePage.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { AgentForm, type AgentFormValues } from "./AgentForm.tsx"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"
import { markBorn } from "./reactions.ts"

/** "Last changed by <device name>, <time>", when a linked device made the last change (012). */
const ChangedBy = (props: { agent: Agent }) => {
  const app = useApp()
  return (
    <Show when={props.agent.changedBy}>
      {(change) => (
        <span class={styles.hint} data-testid="agent-changed-by">
          {app.t("agents.changedBy", {
            name: change().by,
            time: formatDateTime(app.locale(), change().at),
          })}
        </span>
      )}
    </Show>
  )
}

/**
 * A client sends only what the user changed. A field that did not change is left out, so a
 * stale value cannot make the level looser, and a model whose account was disconnected on the
 * server does not stop an edit of the instructions.
 */
const changesOf = (agent: Agent, values: AgentFormValues): AgentPatch => ({
  ...(values.name !== agent.name ? { name: values.name } : {}),
  ...(values.role !== agent.role ? { role: values.role } : {}),
  ...(values.instructions !== agent.instructions ? { instructions: values.instructions } : {}),
  ...(values.face.shape !== agent.face.shape || values.face.hue !== agent.face.hue
    ? { face: values.face }
    : {}),
  ...(values.model?.accountId !== agent.model?.accountId ||
  values.model?.model !== agent.model?.model ||
  values.model?.effort !== agent.model?.effort
    ? { model: values.model }
    : {}),
  ...(values.permission && values.permission !== agent.permission
    ? { permission: values.permission }
    : {}),
})

/** The profile of an agent as text only. A device without the switch sees this (012). */
const AgentProfileView = (props: { agent: Agent; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const line = (label: MessageKey, text: string, testId: string) => (
    <div class={styles.field}>
      <span class={styles.label}>{t(label)}</span>
      <span class={styles.readonly} data-testid={testId} data-user-data>
        {text || "—"}
      </span>
    </div>
  )
  return (
    <div class={styles.form} data-testid="agent-profile-view">
      <h2 class={styles.title}>{t("agents.profile")}</h2>
      <div class={styles.faceRow}>
        <Face face={props.agent.face} image={props.agent.faceImage} size={64} />
      </div>
      {line("agents.field.name", props.agent.name, "agent-view-name")}
      {line("agents.field.role", props.agent.role, "agent-view-role")}
      {line("agents.field.instructions", props.agent.instructions, "agent-view-instructions")}
      {line(
        "agents.field.model",
        props.agent.model?.model ?? t("agents.noModel"),
        "agent-view-model",
      )}
      {line(
        "agents.field.permission",
        t(`agents.permission.${props.agent.permission}` as MessageKey),
        "agent-view-permission",
      )}
      <span class={styles.hint} data-testid="agent-readonly-hint">
        {t("agents.readonly.hint", { name: ui.server()?.name ?? "" })}
      </span>
      <div class={styles.actions}>
        <Button onClick={props.onClose} data-testid="agent-view-close">
          {t("agents.close")}
        </Button>
      </div>
    </div>
  )
}

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

/**
 * Edit an agent, or duplicate or archive it. On a linked server, as far as the server allows. A
 * second page shows its knowledge; a linked server shows a line on it instead (012).
 */
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
      wide={tab() === "knowledge" && !ui.linked()}
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
        <Show
          when={ui.canChange()}
          fallback={<AgentProfileView agent={props.agent} onClose={props.onClose} />}
        >
          <AgentForm
            agent={props.agent}
            onCancel={props.onClose}
            onSubmit={async (values) => {
              if (!ui.linked()) {
                await call("agents.update", { id: props.agent.id, patch: values })
                props.onClose()
                return
              }
              // The error stays on the dialog, also when the form goes read-only because the
              // server turned the switch off.
              await act(async () => {
                await call("agents.update", {
                  id: props.agent.id,
                  patch: changesOf(props.agent, values),
                })
                props.onClose()
              })
            }}
            {...(ui.linked()
              ? {}
              : {
                  onPicture: async (dataUrl: string | null) => {
                    await call("agents.setFaceImage", { id: props.agent.id, dataUrl })
                  },
                })}
          />
        </Show>
        <div class={styles.spread}>
          <Show
            when={ui.linked()}
            fallback={
              <span class={styles.hint} title={props.agent.workspace} data-user-data>
                {t("agents.workspace")}: {props.agent.workspace}
              </span>
            }
          >
            <span class={styles.hint} data-testid="agent-workspace-on">
              {t("agents.workspace.on", { name: ui.server()?.name ?? "" })}
            </span>
          </Show>
          <ChangedBy agent={props.agent} />
        </div>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="agent-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <Show when={ui.canChange()}>
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
        </Show>
      </div>
      <Show when={tab() === "knowledge"}>
        {/* Knowledge belongs to the computer that runs the agent: a client does not open it. */}
        <Show
          when={!ui.linked()}
          fallback={
            <div class={styles.form}>
              <span class={styles.hint} data-testid="knowledge-open-on-server">
                {t("link.openOnServer", { name: ui.server()?.name ?? "" })}
              </span>
              <div class={styles.actions}>
                <Button onClick={props.onClose} data-testid="knowledge-view-close">
                  {t("agents.close")}
                </Button>
              </div>
            </div>
          }
        >
          <KnowledgePage agent={props.agent} onClose={props.onClose} />
        </Show>
      </Show>
    </Dialog>
  )
}
