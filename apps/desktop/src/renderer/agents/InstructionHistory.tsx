import type { InstructionVersion, MessageKey } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./agents.module.css"

/**
 * The instruction history of an agent (spec 002): the versions, newest first, with where each
 * change came from. The user opens a version and restores it; a restore is a new version.
 * `onRestored` gives the restored text to the form, so a save keeps it.
 */
export const InstructionHistory = (props: {
  agentId: string
  onRestored: (text: string) => void
}) => {
  const app = useApp()
  const { t } = app
  const [openId, setOpenId] = createSignal<string>()
  const [error, setError] = createSignal<ErrorText>()
  const [versions, { refetch }] = createResource(
    () => props.agentId,
    (agentId) => call("agents.history.list", { agentId }),
  )
  onCleanup(window.robot.on("agents.changed", () => void refetch()))

  const restore = async (version: InstructionVersion) => {
    setError(undefined)
    try {
      const agent = await call("agents.history.restore", {
        agentId: props.agentId,
        versionId: version.id,
      })
      props.onRestored(agent.instructions)
      setOpenId(undefined)
      await refetch()
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <details class={styles.field} data-testid="instruction-history">
      <summary class={styles.label}>
        {t("agents.history.title", { count: (versions() ?? []).length })}
      </summary>
      <span class={styles.hint}>{t("agents.history.hint")}</span>
      <Show when={(versions() ?? []).length === 0}>
        <span class={styles.hint} data-testid="instruction-history-empty">
          {t("agents.history.empty")}
        </span>
      </Show>
      <For each={versions() ?? []}>
        {(version, index) => (
          <div data-testid="instruction-version" data-source={version.source}>
            <div class={styles.memoryRow}>
              <span class={styles.memoryText}>
                {formatDateTime(app.locale(), version.createdAt)}
                {" · "}
                <span data-testid="instruction-version-source">
                  {t(`agents.history.source.${version.source}` as MessageKey)}
                </span>
                <Show when={index() === 0}>
                  {" · "}
                  {t("agents.history.current")}
                </Show>
              </span>
              <Button
                onClick={() => setOpenId(openId() === version.id ? undefined : version.id)}
                data-testid="instruction-version-open"
              >
                {openId() === version.id ? t("agents.history.hide") : t("agents.history.open")}
              </Button>
            </div>
            <Show when={openId() === version.id}>
              <pre class={styles.memoryText} data-testid="instruction-version-text" data-user-data>
                {version.text}
              </pre>
              <Button onClick={() => restore(version)} data-testid="instruction-version-restore">
                {t("agents.history.restore")}
              </Button>
            </Show>
          </div>
        )}
      </For>
      <Show when={error()}>
        {(err) => (
          <span class={styles.error} role="alert">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
    </details>
  )
}
