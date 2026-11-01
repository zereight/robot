import type { Agent, AgentModel } from "@robot/shared"
import { createResource, createSignal, onCleanup, Show } from "solid-js"
import { ChatView } from "../chat/ChatView.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import type { PlaceView } from "../shell/Shell.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { AgentProfileDialog } from "./AgentDialogs.tsx"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"

/** Shows while the agent has a browser window open: take the controls, give them back, close. */
const BrowserControls = (props: { agentId: string }) => {
  const { t } = useApp()
  const [state, { refetch }] = createResource(
    () => props.agentId,
    (agentId) => call("browser.state", { agentId }),
  )
  onCleanup(
    window.robot.on("browser.changed", ({ agentId }) => {
      if (agentId === props.agentId) void refetch()
    }),
  )
  return (
    <Show when={state()?.open}>
      <span class={styles.browserBar} data-testid="browser-bar" data-control={state()?.control}>
        <span>{state()?.control ? t("browser.yours") : t("browser.agents")}</span>
        <Button
          onClick={() =>
            call("browser.control", { agentId: props.agentId, control: !state()?.control })
          }
          data-testid="browser-control"
        >
          {state()?.control ? t("browser.giveBack") : t("browser.takeOver")}
        </Button>
        <Button
          onClick={() => call("browser.close", { agentId: props.agentId })}
          data-testid="browser-close"
        >
          {t("browser.close")}
        </Button>
      </span>
    </Show>
  )
}

const Header = (props: { agent: Agent; picking: boolean; setPicking: (on: boolean) => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <Show
        when={!ui.linked()}
        fallback={
          // A client does not edit the agents of a server (spec 012): the name is only shown.
          <span class={styles.headerName} data-testid="chat-header-agent" data-readonly="true">
            <Face face={props.agent.face} image={props.agent.faceImage} size={24} />
            <span>{props.agent.name}</span>
          </span>
        }
      >
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
      </Show>
      <Show
        when={!ui.linked()}
        fallback={
          <span class={styles.headerModel} data-testid="chat-header-model" data-readonly="true">
            {props.agent.model?.model ?? t("agents.noModel")}
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
          {props.agent.model?.model ?? t("agents.noModel")}
        </button>
      </Show>
      <Show when={!ui.linked()}>
        <BrowserControls agentId={props.agent.id} />
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
    body: (
      <Show when={agent()}>
        {(a) => (
          <ChatView
            agent={a()}
            start={<Start agent={a()} />}
            onConnect={() => ui.openSettings("providers")}
            onChooseModel={() => setPicking(true)}
          />
        )}
      </Show>
    ),
  }
}
