import type { Agent } from "@robot/shared"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { SetupEditorForm } from "../agents/SetupEditor.tsx"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./settings.module.css"

/**
 * Settings, Setup actions: the agents of this computer, the setup list of the picked agent, and
 * its allow (spec 035). A linked computer keeps its own lists; this window has no control for
 * them.
 */
export const SetupActionsSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [agents, { refetch: refetchAgents }] = createResource(
    () => ui.localServer()?.id,
    async (serverId) => [
      ...(await call("agents.list", { serverId, archived: false })),
      ...(await call("agents.list", { serverId, archived: true })),
    ],
    { initialValue: [] as readonly Agent[] },
  )
  onCleanup(window.robot.on("agents.changed", () => void refetchAgents()))
  const [agentId, setAgentId] = createSignal("")
  createEffect(() => {
    if (!agentId() && agents().length > 0) setAgentId(agents()[0]?.id ?? "")
  })
  const [list, { mutate }] = createResource(
    () => (agentId() ? agentId() : undefined),
    (id) => call("setup.list", { agentId: id }),
  )

  const allow = (on: boolean) => {
    const id = agentId()
    if (!id) return
    call("setup.allow", { agentId: id, on })
      .then((next) => mutate(next))
      .catch((cause: unknown) => {
        const described = describeError(cause)
        showToast("error", described.key, described.params)
      })
  }

  const automatic = () =>
    (list.latest?.actions ?? []).some((action) => action.onOwnCopy || action.onTurnStart)

  return (
    <div data-testid="setup-section">
      <Show
        when={!ui.linked()}
        fallback={
          <p class={styles.note} data-testid="setup-linked">
            {t("setup.linked", { name: ui.server()?.name ?? "" })}
          </p>
        }
      >
        <Show
          when={agents().length > 0}
          fallback={
            <p class={styles.muted} data-testid="setup-no-agents">
              {t("setup.noAgents")}
            </p>
          }
        >
          <div class={styles.row}>
            <div>
              <div class={styles.label}>{t("setup.agent")}</div>
            </div>
            <select
              class={styles.select}
              aria-label={t("setup.agent")}
              data-testid="setup-agent"
              value={agentId()}
              onChange={(e) => setAgentId(e.currentTarget.value)}
            >
              <For each={agents()}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
            </select>
          </div>
          <Show when={agentId()}>
            {(id) => (
              <>
                <SetupEditorForm
                  agentId={id()}
                  onSaved={(next) => mutate(next)}
                  onCancel={() => undefined}
                />
                <Show when={automatic()}>
                  <div class={styles.row}>
                    <div>
                      <div class={styles.label}>
                        {list.latest?.allowed ? t("setup.stop") : t("setup.allow")}
                      </div>
                      <div class={styles.hint}>
                        {(list.latest?.actions ?? [])
                          .filter((action) => action.onOwnCopy || action.onTurnStart)
                          .map((action) => action.command)
                          .join("\n")}
                      </div>
                    </div>
                    <Button
                      onClick={() => allow(!(list.latest?.allowed ?? false))}
                      data-testid={list.latest?.allowed ? "setup-stop" : "setup-allow"}
                    >
                      {list.latest?.allowed ? t("setup.stop") : t("setup.allow")}
                    </Button>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}
