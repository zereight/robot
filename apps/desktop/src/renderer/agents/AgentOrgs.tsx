import type { Agent } from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { OrgDialog } from "../orgs/OrgDialog.tsx"
import orgStyles from "../orgs/orgs.module.css"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import styles from "./agents.module.css"

/**
 * The row "Organizations" of the profile of an agent (spec 002, flow 12; spec 030, flow 5): the
 * organizations that the agent is a member of. A click on a name opens the form of that
 * organization. A device that cannot change organizations opens it read only (spec 012).
 */
export const AgentOrgs = (props: { agent: Agent }) => {
  const { t } = useApp()
  const orgs = useOrgs()
  const [open, setOpen] = createSignal<string>()
  const mine = () => orgs.ofAgent(props.agent.id)
  return (
    <fieldset class={`${styles.field} ${orgStyles.bare}`} data-testid="agent-orgs">
      <legend class={styles.label}>{t("agents.orgs")}</legend>
      <div class={orgStyles.profileRow}>
        <Show
          when={mine().length > 0}
          fallback={
            <span class={styles.hint} data-testid="agent-orgs-none">
              {t("agents.orgs.none")}
            </span>
          }
        >
          <For each={mine()}>
            {(org) => (
              <button
                type="button"
                class={orgStyles.chip}
                aria-label={t("agents.orgs.open", { name: org.name })}
                onClick={() => setOpen(org.id)}
                data-testid="agent-org"
                data-name={org.name}
                data-user-data
              >
                {org.name}
              </button>
            )}
          </For>
        </Show>
      </div>
      <Show when={open()}>
        {(id) => <OrgDialog id={id()} onClose={() => setOpen(undefined)} />}
      </Show>
    </fieldset>
  )
}
