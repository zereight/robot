import type { Agent } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import type { PlaceView } from "../shell/Shell.tsx"
import { useApp } from "../state/app.tsx"
import { AgentProfileDialog } from "./AgentDialogs.tsx"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"

const Header = (props: { agent: Agent }) => {
  const { t } = useApp()
  const [open, setOpen] = createSignal(false)
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
      <span class={styles.headerModel} data-testid="chat-header-model">
        {props.agent.model?.model ?? t("agents.noModel")}
      </span>
      <Show when={open()}>
        <AgentProfileDialog agent={props.agent} onClose={() => setOpen(false)} />
      </Show>
    </>
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
