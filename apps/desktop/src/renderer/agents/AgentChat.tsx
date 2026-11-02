import { type Agent, type AgentModel, runtimeModel } from "@robot/shared"
import { createEffect, createSignal, Show } from "solid-js"
import { ChatView } from "../chat/ChatView.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import type { PlaceView } from "../shell/Shell.tsx"
import { useApp } from "../state/app.tsx"
import { memoryTarget } from "../state/memoryLink.ts"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { AgentActivity } from "./AgentActivity.tsx"
import { AgentProfileDialog } from "./AgentDialogs.tsx"
import styles from "./agents.module.css"
import { BrowserPane } from "./BrowserPane.tsx"
import { Face } from "./Face.tsx"

const Header = (props: { agent: Agent; picking: boolean; setPicking: (on: boolean) => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const providers = useProviders()
  const [open, setOpen] = createSignal(false)
  // The line "Suggested for memory" in the chat opens the profile on the tab Proposals (spec 008).
  createEffect(() => {
    if (memoryTarget()?.agentId === props.agent.id) setOpen(true)
  })
  // A runtime model shows with its version. An API model shows its id, which has the version.
  const modelName = () => {
    const model = props.agent.model
    if (!model) return t("agents.noModel")
    const known = runtimeModel(providers.byId(model.accountId)?.kind, model.model)
    return known?.labelKey ? t(known.labelKey) : (known?.label ?? model.model)
  }
  return (
    <>
      {/* A client without the switch opens the profile too, as read-only text (spec 012). */}
      <button
        type="button"
        class={styles.headerName}
        aria-label={t("agents.openProfile", { name: props.agent.name })}
        title={props.agent.name}
        onClick={() => setOpen(true)}
        data-readonly={ui.canChange() ? undefined : "true"}
        data-testid="chat-header-agent"
      >
        <Face
          face={props.agent.face}
          image={props.agent.faceImage}
          size={24}
          agentId={props.agent.id}
        />
        <span>{props.agent.name}</span>
      </button>
      <Show
        when={ui.canChange()}
        fallback={
          <span class={styles.headerModel} data-testid="chat-header-model" data-readonly="true">
            {modelName()}
          </span>
        }
      >
        <button
          type="button"
          class={styles.headerModel}
          aria-label={t("model.choose")}
          onClick={() => props.setPicking(true)}
          data-testid="chat-header-model"
        >
          {modelName()}
        </button>
      </Show>
      <Presence when={open()}>
        {() => <AgentProfileDialog agent={props.agent} onClose={() => setOpen(false)} />}
      </Presence>
      <Presence when={props.picking}>
        {() => <ModelDialog agent={props.agent} onClose={() => props.setPicking(false)} />}
      </Presence>
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
  const ui = useUi()
  const [picking, setPicking] = createSignal(false)
  return {
    header: (
      <Show when={agent()}>
        {(a) => <Header agent={a()} picking={picking()} setPicking={setPicking} />}
      </Show>
    ),
    panel: <Show when={agent()}>{(a) => <AgentActivity agent={a()} />}</Show>,
    body: (
      <Show when={agent()}>
        {(a) => (
          <div class={styles.split}>
            {/* A linked server has no browser view in a client: the client has no control of it. */}
            <Show when={!ui.linked()}>
              <BrowserPane agentId={a().id} />
            </Show>
            <div class={styles.chatColumn}>
              <ChatView
                agent={a()}
                start={<Start agent={a()} />}
                onConnect={() => ui.openSettings("providers")}
                onChooseModel={() => setPicking(true)}
              />
            </div>
          </div>
        )}
      </Show>
    ),
  }
}
