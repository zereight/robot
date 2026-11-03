import { type Agent, BROWSER_PROFILE_NAME_MAX, type BrowserProfile } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./settings.module.css"

/**
 * Settings, Browser: the browser profiles of this computer. The user makes, renames and deletes
 * them here, and gives one to an agent in the profile of the agent. A profile holds cookies and
 * sign-ins; the page never shows them.
 */
export const BrowserProfilesSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [profiles, { refetch }] = createResource(() => call("browserProfiles.list"), {
    initialValue: [] as readonly BrowserProfile[],
  })
  const [agents, { refetch: refetchAgents }] = createResource(
    () => ui.localServer()?.id,
    async (serverId) => [
      ...(await call("agents.list", { serverId, archived: false })),
      ...(await call("agents.list", { serverId, archived: true })),
    ],
    { initialValue: [] as readonly Agent[] },
  )
  onCleanup(window.robot.on("browserProfiles.changed", () => void refetch()))
  onCleanup(window.robot.on("agents.changed", () => void refetchAgents()))

  /** A dialog with a name field: a new profile (`undefined`), or a profile to rename. */
  const [editing, setEditing] = createSignal<{ profile?: BrowserProfile }>()
  const [deleting, setDeleting] = createSignal<BrowserProfile>()
  const [error, setError] = createSignal<ErrorText>()
  const [name, setName] = createSignal("")

  const usedBy = (profile: BrowserProfile) =>
    profile.agentIds
      .map((id) => agents().find((a) => a.id === id)?.name ?? t("browserProfiles.unknownAgent"))
      .join(", ")

  const openEditor = (profile?: BrowserProfile) => {
    setError(undefined)
    setName(profile?.name ?? "")
    setEditing(profile ? { profile } : {})
  }
  const save = async () => {
    setError(undefined)
    const current = editing()
    if (!current) return
    try {
      if (current.profile)
        await call("browserProfiles.rename", { id: current.profile.id, name: name() })
      else await call("browserProfiles.create", { name: name() })
      setEditing(undefined)
    } catch (e) {
      setError(describeError(e))
    }
  }
  const remove = async (profile: BrowserProfile) => {
    setError(undefined)
    try {
      await call("browserProfiles.delete", { id: profile.id })
      setDeleting(undefined)
    } catch (e) {
      setError(describeError(e))
    }
  }

  const errorLine = () => (
    <Show when={error()}>
      {(err) => (
        <div class={styles.error} role="alert" data-testid="browser-profile-error">
          {t(err().key, err().params)}
        </div>
      )}
    </Show>
  )

  return (
    <div data-testid="browser-profiles">
      <div class={styles.row}>
        <div>
          <div class={styles.label}>{t("browserProfiles.title")}</div>
          <div class={`${styles.hint} ${styles.words}`}>{t("browserProfiles.hint")}</div>
        </div>
        <Button
          class={styles.noWrap}
          onClick={() => openEditor()}
          data-testid="browser-profile-add"
        >
          {t("browserProfiles.add")}
        </Button>
      </div>
      <Show
        when={profiles().length > 0}
        fallback={
          <p class={styles.muted} data-testid="browser-profiles-empty">
            {t("browserProfiles.empty")}
          </p>
        }
      >
        <ul class={styles.log} data-testid="browser-profiles-list">
          <For each={profiles()}>
            {(profile) => (
              <li
                class={styles.logRow}
                data-testid="browser-profile"
                data-name={profile.teamsLink ? t("browserProfiles.teamsName") : profile.name}
                data-teams-link={profile.teamsLink ? "true" : undefined}
              >
                <div class={styles.logHead}>
                  <span class={styles.label} data-user-data={profile.teamsLink ? undefined : ""}>
                    {profile.teamsLink ? t("browserProfiles.teamsName") : profile.name}
                  </span>
                </div>
                {/* The sign-in profile of the Teams link has no rename and no delete (spec 028). */}
                <Show
                  when={!profile.teamsLink}
                  fallback={
                    <div class={styles.hint} data-testid="browser-profile-teams">
                      {t("browserProfiles.usedByTeams")}
                    </div>
                  }
                >
                  <div class={styles.hint} data-testid="browser-profile-users" data-user-data>
                    {profile.agentIds.length > 0
                      ? t("browserProfiles.usedBy", { names: usedBy(profile) })
                      : t("browserProfiles.unused")}
                  </div>
                  <div class={styles.actions}>
                    <Button
                      onClick={() => openEditor(profile)}
                      data-testid="browser-profile-rename"
                    >
                      {t("browserProfiles.rename")}
                    </Button>
                    <Button
                      onClick={() => {
                        setError(undefined)
                        setDeleting(profile)
                      }}
                      data-testid="browser-profile-delete"
                    >
                      {t("browserProfiles.delete")}
                    </Button>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Presence when={editing()}>
        {(current) => {
          const title = () =>
            current.profile
              ? t("browserProfiles.rename.title", { name: current.profile.name })
              : t("browserProfiles.add.title")
          return (
            <Dialog
              label={title()}
              onClose={() => setEditing(undefined)}
              testId="browser-profile-dialog"
            >
              <h2 class={styles.label}>{title()}</h2>
              <form
                class={styles.actions}
                onSubmit={(e) => {
                  e.preventDefault()
                  void save()
                }}
              >
                <input
                  class={styles.input}
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  aria-label={t("browserProfiles.name")}
                  placeholder={t("browserProfiles.name")}
                  maxLength={BROWSER_PROFILE_NAME_MAX * 2}
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  data-testid="browser-profile-name"
                  autofocus
                />
                <Button type="submit" variant="primary" data-testid="browser-profile-save">
                  {current.profile ? t("browserProfiles.save") : t("browserProfiles.create")}
                </Button>
                <Button onClick={() => setEditing(undefined)}>{t("browserProfiles.cancel")}</Button>
              </form>
              {errorLine()}
            </Dialog>
          )
        }}
      </Presence>
      <Presence when={deleting()}>
        {(profile) => (
          <Dialog
            label={t("browserProfiles.delete.title", { name: profile.name })}
            onClose={() => setDeleting(undefined)}
            testId="browser-profile-delete-dialog"
          >
            <h2 class={styles.label}>
              {t("browserProfiles.delete.title", { name: profile.name })}
            </h2>
            <p>{t("browserProfiles.delete.body")}</p>
            {errorLine()}
            <div class={styles.actions}>
              <Button onClick={() => setDeleting(undefined)}>{t("browserProfiles.cancel")}</Button>
              <Button
                variant="primary"
                onClick={() => void remove(profile)}
                data-testid="browser-profile-delete-confirm"
              >
                {t("browserProfiles.delete")}
              </Button>
            </div>
          </Dialog>
        )}
      </Presence>
    </div>
  )
}
