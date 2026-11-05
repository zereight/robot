import type { Agent } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { AgentName } from "../orgs/AgentName.tsx"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { createOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"

/** Settings section: archived agents, with restore and delete. */
export const ArchiveSection = () => {
  const { t } = useApp()
  const ui = useUi()
  const devices = useDevices()
  // The archive is the list of this computer, so its prefixes come from the organizations of the
  // local server, also while a linked server is on screen (spec 035).
  const orgs = createOrgs(() => ui.localServer()?.id)
  const [archived, { refetch }] = createResource(
    () => ui.localServer()?.id,
    (serverId) => call("agents.list", { serverId, archived: true }),
    { initialValue: [] as readonly Agent[] },
  )
  onCleanup(window.robot.on("agents.changed", () => void refetch()))
  const [confirm, setConfirm] = createSignal<Agent>()
  // How many skills a delete of the confirmed agent deletes too: those that are only for it (017).
  const [skills, setSkills] = createSignal(0)
  const [error, setError] = createSignal<ErrorText>()

  const countSkills = async (agent: Agent) =>
    setSkills((await call("skills.onlyFor", { agentId: agent.id })).count)
  // The number is read before the dialog opens, so the text never shows a wrong count. It is read
  // again when the skills change while the dialog is open, but not during the delete itself: the
  // delete changes the skills, and the dialog closes with the text that the user confirmed.
  let deleting = false
  const ask = async (agent: Agent) => {
    setError(undefined)
    try {
      await countSkills(agent)
      setConfirm(agent)
    } catch (e) {
      setError(describeError(e))
    }
  }
  onCleanup(
    window.robot.on("skills.changed", () => {
      const open = confirm()
      if (open && !deleting) void countSkills(open).catch(() => undefined)
    }),
  )

  const remove = async (agent: Agent) => {
    setError(undefined)
    deleting = true
    try {
      await call("agents.delete", { id: agent.id })
      setConfirm(undefined)
    } catch (e) {
      setError(describeError(e))
    } finally {
      deleting = false
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
                <span class={styles.archiveName}>
                  <AgentName id={agent.id} name={agent.name} orgs={orgs} />
                </span>
                <Button
                  onClick={() => call("agents.restore", { id: agent.id })}
                  data-testid="archive-restore"
                >
                  {t("agents.restore")}
                </Button>
                <Button onClick={() => void ask(agent)} data-testid="archive-delete">
                  {t("agents.delete")}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={confirm() ? undefined : error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="archive-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
      <Presence when={confirm()}>
        {(agent) => (
          <Dialog
            label={t("agents.delete.title", { name: agent.name })}
            onClose={() => setConfirm(undefined)}
            testId="delete-confirm"
          >
            <h2 class={styles.title}>{t("agents.delete.title", { name: agent.name })}</h2>
            <p>{t("agents.delete.body")}</p>
            <Show when={devices.sync.pairName()}>
              {(name) => (
                <p data-testid="delete-sync-line">{t("agents.delete.sync", { name: name() })}</p>
              )}
            </Show>
            <Show when={skills() > 0}>
              <p data-testid="delete-skills-line">
                {t(skills() === 1 ? "agents.delete.skills.one" : "agents.delete.skills.many", {
                  name: agent.name,
                  count: skills(),
                })}
              </p>
            </Show>
            <Show when={error()}>
              {(err) => (
                <div class={styles.error} role="alert">
                  {t(err().key, err().params)}
                </div>
              )}
            </Show>
            <div class={styles.actions}>
              <Button onClick={() => setConfirm(undefined)}>{t("agents.cancel")}</Button>
              <Button
                variant="primary"
                onClick={() => remove(agent)}
                data-testid="delete-confirm-button"
              >
                {t("agents.delete")}
              </Button>
            </div>
          </Dialog>
        )}
      </Presence>
    </div>
  )
}
