import type { Skill } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import settings from "../settings/settings.module.css"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import { editSkill, openSkillForm } from "./SkillForm.tsx"
import styles from "./skills.module.css"

/**
 * Settings, Skills (spec 017): the skills of this server. The user makes one with "New skill",
 * edits or duplicates one, turns one off or on, and deletes one after a confirm. A skill is called
 * with a slash in a chat.
 */
export const SkillsSection = () => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const channels = useChannels()
  const [skills, { refetch }] = createResource(
    () => (ui.linked() ? undefined : ui.server()?.id),
    (serverId) => call("skills.list", { serverId }),
    { initialValue: [] as readonly Skill[] },
  )
  onCleanup(window.robot.on("skills.changed", () => void refetch()))
  const [error, setError] = createSignal<ErrorText>()
  const [deleting, setDeleting] = createSignal<string>()

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(describeError(e))
    }
  }

  /**
   * Who may use the skill: "All agents", or the names of the agents and channels that are still
   * there (spec 017, 030).
   */
  const forWhom = (skill: Skill) =>
    skill.agentIds === null
      ? t("skills.agents.all")
      : [
          ...skill.agentIds.map((id) => agents.byId(id)?.name),
          ...skill.channelIds.map((id) => channels.byId(id)?.name),
        ]
          .filter((name): name is string => name !== undefined)
          .join(", ")

  return (
    <div data-testid="skills-section">
      <Show
        when={!ui.linked()}
        fallback={
          // A client sees the words and has no control: skills are kept on the server (012).
          <p class={settings.note} data-testid="skills-linked">
            {t("skills.linked", { name: ui.server()?.name ?? "" })}
          </p>
        }
      >
        <div class={styles.top}>
          <p class={settings.note}>{t("skills.hint")}</p>
          <Button
            variant="primary"
            class={styles.newSkill}
            onClick={openSkillForm}
            data-testid="skills-new"
          >
            {t("skills.new")}
          </Button>
        </div>
        <Show when={error()}>
          {(err) => (
            <p
              class={settings.note}
              role="alert"
              data-testid="skills-error"
              // A long list scrolls: the reason must be in view when a row action fails.
              ref={(el) => queueMicrotask(() => el.scrollIntoView({ block: "nearest" }))}
            >
              {t(err().key, err().params)}
            </p>
          )}
        </Show>
        <Show
          when={skills().length > 0}
          fallback={
            <p class={settings.note} data-testid="skills-empty">
              {t("skills.empty")}
            </p>
          }
        >
          <ul class={styles.list} data-testid="skills-list">
            <For each={skills()}>
              {(skill) => (
                <li class={styles.item} data-testid="skill-row" data-skill={skill.name}>
                  <div class={styles.itemMain}>
                    <span class={styles.itemName} data-testid="skill-row-name">
                      {skill.name}
                    </span>
                    <Show when={skill.description}>
                      <span class={styles.itemMeta}>{skill.description}</span>
                    </Show>
                    <span class={styles.itemMeta} data-testid="skill-row-agents">
                      {forWhom(skill)}
                    </span>
                  </div>
                  <div class={styles.itemActions}>
                    <Show
                      when={deleting() === skill.id}
                      fallback={
                        <>
                          <Switch
                            label={t("skills.switch", { name: skill.name })}
                            checked={skill.enabled}
                            onChange={(enabled) =>
                              run(() => call("skills.setEnabled", { id: skill.id, enabled }))
                            }
                            testId="skill-switch"
                          />
                          <Button
                            onClick={() => editSkill(skill)}
                            aria-label={t("skills.edit.label", { name: skill.name })}
                            data-testid="skill-edit"
                          >
                            {t("skills.edit")}
                          </Button>
                          <Button
                            onClick={() =>
                              run(async () => {
                                const copy = await call("skills.duplicate", {
                                  id: skill.id,
                                  suffix: t("skills.copySuffix"),
                                })
                                showToast("success", "skills.duplicated", { name: copy.name })
                              })
                            }
                            aria-label={t("skills.duplicate.label", { name: skill.name })}
                            data-testid="skill-duplicate"
                          >
                            {t("skills.duplicate")}
                          </Button>
                          <Button onClick={() => setDeleting(skill.id)} data-testid="skill-delete">
                            {t("skills.delete")}
                          </Button>
                        </>
                      }
                    >
                      <span class={styles.confirm} role="alert" data-testid="skill-delete-ask">
                        {t("skills.delete.ask", { name: skill.name })}
                      </span>
                      <Button onClick={() => setDeleting(undefined)}>
                        {t("skills.delete.cancel")}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() =>
                          run(async () => {
                            await call("skills.delete", { id: skill.id })
                            setDeleting(undefined)
                          })
                        }
                        data-testid="skill-delete-confirm"
                      >
                        {t("skills.delete.confirm")}
                      </Button>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
