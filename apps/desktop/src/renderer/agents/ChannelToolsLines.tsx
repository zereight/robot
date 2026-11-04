import type { Agent, AgentChannelTool } from "@robot/shared"
import { createResource, For, onCleanup, Show } from "solid-js"
import { fromChannels } from "../channels/toolsView.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import styles from "./agents.module.css"

/**
 * The block "Tools from channels" of an agent profile (spec 002, 030): each skill and connection
 * that the agent has from a channel, with the line "From <channel>". A tool that comes from more
 * than one channel names each of them. The block is read only. It shows nothing when the agent has
 * no such tool. It reads the list again when a skill, a connection or a channel changes.
 */
export const ChannelToolsLines = (props: { agent: Agent }) => {
  const { t } = useApp()
  const [rows, { refetch }] = createResource(
    () => props.agent.id,
    (agentId) =>
      call("channelTools.forAgent", { agentId }).catch((): readonly AgentChannelTool[] => []),
    { initialValue: [] as readonly AgentChannelTool[] },
  )
  onCleanup(window.robot.on("skills.changed", () => void refetch()))
  onCleanup(window.robot.on("connections.changed", () => void refetch()))
  onCleanup(window.robot.on("channels.changed", () => void refetch()))

  return (
    <Show when={rows().length > 0}>
      <section
        class={styles.recent}
        data-testid="channel-tools-lines"
        aria-label={t("agents.channelTools")}
      >
        <h3 class={styles.recentTitle}>{t("agents.channelTools")}</h3>
        <ul class={styles.recentList}>
          <For each={rows()}>
            {(row) => (
              <li class={styles.recentRow} data-testid="channel-tool-line" data-kind={row.kind}>
                <span class={styles.recentLabel} data-user-data>
                  {row.name}
                </span>
                <span class={styles.hint} data-testid="channel-tool-from">
                  {t("agents.channelTools.from", { channel: fromChannels(row) })}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
