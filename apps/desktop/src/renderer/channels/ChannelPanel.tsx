import type { Channel, ChannelActivity, TaskState } from "@robot/shared"
import { Check, Circle, Loader, X } from "lucide-solid"
import { createResource, For, type JSX, onCleanup, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { IconButton } from "../ui/controls.tsx"
import { stateLabel } from "./ChannelView.tsx"
import styles from "./channels.module.css"

const stepIcon = (state: TaskState): { icon: JSX.Element; key: string } => {
  if (state === "running")
    return {
      icon: (
        <span class={styles.spin}>
          <Loader size={14} />
        </span>
      ),
      key: "channels.step.running",
    }
  if (state === "done") return { icon: <Check size={14} />, key: "channels.step.done" }
  if (state === "failed") return { icon: <X size={14} />, key: "channels.step.failed" }
  return { icon: <Circle size={14} />, key: "channels.step.todo" }
}

/** The "Now" panel: one card per member, and the plan steps under the lead. */
export const ChannelPanel = (props: { channel: Channel }) => {
  const { t } = useApp()
  const agents = useAgents()
  const [activity, { refetch }] = createResource(
    () => props.channel.id,
    (channelId) => call("channels.activity", { channelId }),
  )
  const refresh = () => void refetch()
  onCleanup(
    window.robot.on("channels.changed", (e) => e.channelId === props.channel.id && refresh()),
  )
  onCleanup(window.robot.on("agents.changed", refresh))
  const data = (): ChannelActivity => activity() ?? { members: [] }
  return (
    <div class={styles.panel} data-testid="channel-panel">
      <div class={styles.panelTitle}>{t("channels.now")}</div>
      <Show
        when={data().members.length > 0}
        fallback={<p class={styles.hint}>{t("channels.noWork")}</p>}
      >
        <For each={data().members}>
          {(member) => {
            const agent = () => agents.byId(member.agentId)
            return (
              <Show when={agent()}>
                {(a) => (
                  <div class={styles.card} data-testid="member-card" data-state={member.state}>
                    <div class={styles.cardHead}>
                      <Face face={a().face} image={a().faceImage} size={24} agentId={a().id} />
                      <span class={styles.cardName}>{a().name}</span>
                      <span class={styles.cardState} data-testid="member-state">
                        {t(stateLabel(member.state))}
                      </span>
                    </div>
                    <Show when={member.steps.length > 0}>
                      <ol class={styles.steps} data-testid="plan-steps">
                        <For each={member.steps}>
                          {(step) => {
                            const view = () => stepIcon(step.state)
                            return (
                              <li
                                class={styles.step}
                                data-state={step.state}
                                data-testid="plan-step"
                              >
                                <span
                                  class={styles.stepIcon}
                                  role="img"
                                  aria-label={t(view().key as never)}
                                >
                                  {view().icon}
                                </span>
                                <span class={styles.stepLabel}>{step.label}</span>
                                <Show when={step.state === "running" || step.state === "queued"}>
                                  <IconButton
                                    label={t("channels.step.stop")}
                                    onClick={() => call("tasks.stop", { id: step.taskId })}
                                    data-testid="step-stop"
                                  >
                                    <X size={12} />
                                  </IconButton>
                                </Show>
                              </li>
                            )
                          }}
                        </For>
                      </ol>
                    </Show>
                  </div>
                )}
              </Show>
            )
          }}
        </For>
      </Show>
    </div>
  )
}
