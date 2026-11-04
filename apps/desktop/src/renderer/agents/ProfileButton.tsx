import type { Agent } from "@robot/shared"
import { createSignal, type JSX } from "solid-js"
import { useApp } from "../state/app.tsx"
import { Presence } from "../ui/Presence.tsx"
import { AgentProfileDialog } from "./AgentDialogs.tsx"
import styles from "./agents.module.css"

/**
 * A face or a name that opens the profile of an agent when the user presses it. It is for a place
 * outside the chat header: the cards of the "Now" panel and the face by a message (spec 002, 004).
 * A client without the switch "Can create and change agents" gets the profile as read-only text
 * (spec 012), as from the header.
 */
export const ProfileButton = (props: {
  agent: Agent
  children: JSX.Element
  /** The class of the button, when its place needs a layout of its own. */
  class?: string | undefined
  testId?: string | undefined
}) => {
  const { t } = useApp()
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <button
        type="button"
        class={`${styles.profileButton} ${props.class ?? ""}`.trim()}
        aria-label={t("agents.openProfile", { name: props.agent.name })}
        title={props.agent.name}
        onClick={() => setOpen(true)}
        data-testid={props.testId ?? "open-profile"}
      >
        {props.children}
      </button>
      <Presence when={open()}>
        {() => <AgentProfileDialog agent={props.agent} onClose={() => setOpen(false)} />}
      </Presence>
    </>
  )
}
