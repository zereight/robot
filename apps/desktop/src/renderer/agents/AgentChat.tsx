import type { Agent, AgentModel } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import type { PlaceView } from "../shell/Shell.tsx"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { AgentProfileDialog } from "./AgentDialogs.tsx"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"

const Header = (props: { agent: Agent }) => {
  const { t } = useApp()
  const [open, setOpen] = createSignal(false)
  const [picking, setPicking] = createSignal(false)
  return (
    <>
      <button
        type="button"
        class={styles.headerName}
        aria-label={t("agents.openProfile", { name: props.agent.name })}
        onClick={() => setOpen(true)}
        data-testid="chat-header-agent"
      >
        <Face face={props.agent.face} image={props.agent.faceImage} size={24} />
        <span>{props.agent.name}</span>
      </button>
      <button
        type="button"
        class={styles.headerModel}
        aria-label={t("model.choose")}
        onClick={() => setPicking(true)}
        data-testid="chat-header-model"
      >
        {props.agent.model?.model ?? t("agents.noModel")}
      </button>
      <Show when={open()}>
        <AgentProfileDialog agent={props.agent} onClose={() => setOpen(false)} />
      </Show>
      <Show when={picking()}>
        <ModelDialog agent={props.agent} onClose={() => setPicking(false)} />
      </Show>
    </>
  )
}

/** Changes the model of an agent. The next turn uses it; earlier turns stay. */
const ModelDialog = (props: { agent: Agent; onClose: () => void }) => {
  const { t } = useApp()
  const [model, setModel] = createSignal<AgentModel | null>(props.agent.model)
  const [error, setError] = createSignal<ErrorText>()
  const save = async () => {
    try {
      await call("agents.update", { id: props.agent.id, patch: { model: model() } })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <Dialog label={t("model.choose")} onClose={props.onClose} testId="model-dialog">
      <div class={styles.form}>
        <h2 class={styles.title}>{t("model.choose")}</h2>
        <ModelPicker value={model()} onChange={setModel} />
        <Show when={error()}>
          {(err) => <div class={styles.error}>{t(err().key, err().params)}</div>}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose}>{t("agents.cancel")}</Button>
          <Button variant="primary" onClick={save} disabled={!model()} data-testid="model-save">
            {t("model.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** The first screen of a chat: a large face, the name and the role. Nothing moves. */
const Start = (props: { agent: Agent }) => {
  const { t } = useApp()
  return (
    <div class={styles.start} data-testid="chat-start">
      <Face face={props.agent.face} image={props.agent.faceImage} size={80} />
      <h2>{props.agent.name}</h2>
      <p>{t("chat.start")}</p>
      <Show when={props.agent.role}>
        <p>{props.agent.role}</p>
      </Show>
    </div>
  )
}

export const agentPlaceView = (agent: () => Agent | undefined): PlaceView | undefined => {
  const current = agent()
  if (!current) return undefined
  return {
    header: <Show when={agent()}>{(a) => <Header agent={a()} />}</Show>,
    body: <Show when={agent()}>{(a) => <Start agent={a()} />}</Show>,
  }
}
