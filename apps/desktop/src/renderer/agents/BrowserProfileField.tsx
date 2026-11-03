import type { Agent, BrowserProfile } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import styles from "./agents.module.css"

/**
 * The browser profile of an agent (spec 007): "Only this agent", or one of the profiles that the
 * user made in Settings. The choice applies at once and does not wait for "Save". Only the
 * computer that runs the agent shows it.
 */
export const BrowserProfileField = (props: { agent: Agent }) => {
  const { t } = useApp()
  const [profiles, { refetch }] = createResource(() => call("browserProfiles.list"), {
    initialValue: [] as readonly BrowserProfile[],
  })
  onCleanup(window.robot.on("browserProfiles.changed", () => void refetch()))
  const [error, setError] = createSignal<ErrorText>()
  /** The profiles an agent may get. The sign-in profile of the Teams link is not one (spec 028). */
  const choices = () => profiles().filter((p) => !p.teamsLink)
  /** The profile that the agent uses now, or "" for its own data. */
  const current = () => profiles().find((p) => p.agentIds.includes(props.agent.id))?.id ?? ""

  const choose = async (select: HTMLSelectElement) => {
    setError(undefined)
    try {
      await call("browserProfiles.assign", {
        agentId: props.agent.id,
        profileId: select.value || null,
      })
    } catch (e) {
      // The choice did not apply: the field shows what is true.
      select.value = current()
      setError(describeError(e))
    }
  }

  return (
    <div class={styles.field}>
      <span class={styles.label}>{t("browserProfiles.field")}</span>
      <select
        class={styles.input}
        aria-label={t("browserProfiles.field")}
        onChange={(e) => void choose(e.currentTarget)}
        data-testid="agent-browser-profile"
      >
        <option value="" selected={current() === ""}>
          {t("browserProfiles.own")}
        </option>
        <For each={choices()}>
          {(profile) => (
            <option value={profile.id} selected={current() === profile.id} data-user-data>
              {profile.name}
            </option>
          )}
        </For>
      </select>
      <span class={styles.hint}>{t("browserProfiles.field.hint")}</span>
      <Show when={error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="agent-browser-profile-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
    </div>
  )
}
