import { type Agent, type AgentOrgTool, agentOrgNames } from "@robot/shared"
import { createResource, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import styles from "./agents.module.css"

/**
 * The block "Tools from organizations" of an agent profile (spec 002, 030): each skill and
 * connection that the agent has from an organization, with the line "From <organization>". A tool
 * that comes from more than one organization names each of them. The block is read only. It shows
 * nothing when the agent has no such tool. It reads the list again when a skill, a connection or
 * an organization changes.
 */
export const OrgToolsLines = (props: { agent: Agent }) => {
  const { t } = useApp()
  const ui = useUi()
  const [rows, { refetch }] = createResource(
    () => props.agent.id,
    (agentId) => call("orgTools.forAgent", { agentId }).catch((): readonly AgentOrgTool[] => []),
    { initialValue: [] as readonly AgentOrgTool[] },
  )
  onCleanup(window.robot.on("skills.changed", () => void refetch()))
  onCleanup(window.robot.on("connections.changed", () => void refetch()))
  onCleanup(
    window.robot.on("organizations.changed", ({ serverId }) => {
      if (serverId === ui.server()?.id) void refetch()
    }),
  )

  return (
    <Show when={rows().length > 0}>
      <section
        class={styles.recent}
        data-testid="org-tools-lines"
        aria-label={t("agents.orgTools")}
      >
        <h3 class={styles.recentTitle}>{t("agents.orgTools")}</h3>
        <ul class={styles.recentList}>
          <For each={rows()}>
            {(row) => (
              <li class={styles.recentRow} data-testid="org-tool-line" data-kind={row.kind}>
                <span class={styles.recentLabel} data-user-data>
                  {row.name}
                </span>
                <span class={styles.hint} data-testid="org-tool-from">
                  {t("agents.orgTools.from", { organization: agentOrgNames(row) })}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
