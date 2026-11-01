import type { Agent } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { errorKey } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"

/** Settings section: archived agents, with restore and delete. */
export const ArchiveSection = () => {
  const { t } = useApp()
  const ui = useUi()
  const [archived, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("agents.list", { serverId, archived: true }),
    { initialValue: [] as readonly Agent[] },
  )
  onCleanup(window.robot.on("agents.changed", () => void refetch()))
  const [confirm, setConfirm] = createSignal<Agent>()
  const [error, setError] = createSignal<ReturnType<typeof errorKey>>()

  const remove = async (agent: Agent) => {
    setError(undefined)
    try {
      await call("agents.delete", { id: agent.id })
      setConfirm(undefined)
    } catch (e) {
      setError(errorKey(e))
    }
  }

  return (
    <div data-testid="archive-section">
      <h2 class={styles.label} style={{ "margin-bottom": "8px" }}>
        {t("agents.archive.agents")}
      </h2>
      <Show
        when={archived().length > 0}
        fallback={<p class={styles.hint}>{t("agents.archive.empty")}</p>}
      >
        <ul class={styles.archiveList}>
          <For each={archived()}>
            {(agent) => (
              <li class={styles.archiveItem} data-testid={`archived-${agent.id}`}>
                <Face face={agent.face} image={agent.faceImage} size={32} />
                <span class={styles.archiveName}>{agent.name}</span>
                <Button
                  onClick={() => call("agents.restore", { id: agent.id })}
                  data-testid="archive-restore"
                >
                  {t("agents.restore")}
                </Button>
                <Button onClick={() => setConfirm(agent)} data-testid="archive-delete">
                  {t("agents.delete")}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={confirm()}>
        {(agent) => (
          <Dialog
            label={t("agents.delete.title", { name: agent().name })}
            onClose={() => setConfirm(undefined)}
            testId="delete-confirm"
          >
            <h2 class={styles.title}>{t("agents.delete.title", { name: agent().name })}</h2>
            <p>{t("agents.delete.body")}</p>
            <Show when={error()}>
              {(key) => (
                <div class={styles.error} role="alert">
                  {t(key())}
                </div>
              )}
            </Show>
            <div class={styles.actions}>
              <Button onClick={() => setConfirm(undefined)}>{t("agents.cancel")}</Button>
              <Button
                variant="primary"
                onClick={() => remove(agent())}
                data-testid="delete-confirm-button"
              >
                {t("agents.delete")}
              </Button>
            </div>
          </Dialog>
        )}
      </Show>
    </div>
  )
}
