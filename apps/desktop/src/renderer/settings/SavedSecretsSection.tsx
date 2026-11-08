import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { useWorkflowList } from "../workflows/names.ts"
import styles from "./settings.module.css"

/**
 * Settings, Permissions: the switch for this computer and the local network, and the overview of
 * the saved secrets (spec 020, 013). The overview lists each workflow that holds a secret or a
 * login: the name of the workflow, the count of secrets, the count of logins, and a link
 * "Open vault" that opens the vault of that workflow. It shows no value, and the user cannot add,
 * replace or delete there: the vault is the only place.
 */
export const SavedSecretsSection = () => {
  const app = useApp()
  const ui = useUi()
  const { t } = app
  const workflows = useWorkflowList()
  const [secrets, { refetch: refetchSecrets }] = createResource(() => call("secrets.list", {}))
  const [logins, { refetch: refetchLogins }] = createResource(() => call("logins.list", {}))
  onCleanup(
    window.robot.on("secrets.changed", () => {
      void refetchSecrets()
      void refetchLogins()
    }),
  )

  const openVault = (workflowId: string) => ui.openVault(workflowId)

  /** Each workflow that holds a secret or a login, with the counts of each. */
  const owners = createMemo(() => {
    const secretCounts = new Map<string, number>()
    for (const s of secrets.latest ?? [])
      secretCounts.set(s.workflowId, (secretCounts.get(s.workflowId) ?? 0) + 1)
    const loginCounts = new Map<string, number>()
    for (const login of logins.latest ?? [])
      loginCounts.set(login.workflowId, (loginCounts.get(login.workflowId) ?? 0) + 1)
    return workflows
      .list()
      .filter((w) => secretCounts.has(w.id) || loginCounts.has(w.id))
      .map((w) => ({
        id: w.id,
        name: w.name,
        secrets: secretCounts.get(w.id) ?? 0,
        logins: loginCounts.get(w.id) ?? 0,
      }))
  })

  return (
    <div data-testid="saved-secrets">
      <div class={styles.row}>
        <div>
          <div class={styles.label}>{t("secrets.local")}</div>
          <div class={`${styles.hint} ${styles.words}`}>{t("secrets.local.hint")}</div>
        </div>
        <Switch
          label={t("secrets.local")}
          testId="setting-secrets-local"
          checked={app.settings.secretsLocal}
          onChange={(secretsLocal) => app.update({ secretsLocal })}
        />
      </div>
      <div class={styles.row}>
        <div>
          <div class={styles.label}>{t("secrets.title")}</div>
          <div class={`${styles.hint} ${styles.words}`}>{t("vault.overview.hint")}</div>
        </div>
      </div>
      <Show
        when={owners().length > 0}
        fallback={
          <p class={styles.muted} data-testid="saved-secrets-empty">
            {t("vault.overview.empty")}
          </p>
        }
      >
        <ul class={styles.log} data-testid="saved-secrets-list">
          <For each={owners()}>
            {(owner) => (
              <li class={styles.logRow} data-testid="saved-secrets-owner" data-name={owner.name}>
                <div class={styles.logHead}>
                  <span class={styles.label}>{owner.name}</span>
                </div>
                <div class={styles.hint} data-testid="saved-secrets-counts">
                  {t("vault.overview.counts", { secrets: owner.secrets, logins: owner.logins })}
                </div>
                <div class={styles.actions}>
                  <Button onClick={() => openVault(owner.id)} data-testid="saved-secrets-open">
                    {t("vault.open")}
                  </Button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
