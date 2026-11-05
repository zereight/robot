import type { Agent, SavedSecret, SecretAuth } from "@robot/shared"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { formatDateTime } from "../chat/format.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./settings.module.css"

/**
 * Settings, Permissions: the switch for this computer and the local network, and the saved
 * secrets of spec 020. The page never shows a value.
 */
export const SavedSecretsSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [agentFilter, setAgentFilter] = createSignal("")
  const [secrets, { refetch }] = createResource(agentFilter, (agentId) =>
    call("secrets.list", agentId ? { agentId } : {}),
  )
  const [all, { refetch: refetchAll }] = createResource(() => call("secrets.list", {}))
  const [agents, { refetch: refetchAgents }] = createResource(
    () => ui.localServer()?.id,
    async (serverId) => [
      ...(await call("agents.list", { serverId, archived: false })),
      ...(await call("agents.list", { serverId, archived: true })),
    ],
    { initialValue: [] as readonly Agent[] },
  )
  onCleanup(
    window.robot.on("secrets.changed", () => {
      void refetch()
      void refetchAll()
    }),
  )
  onCleanup(window.robot.on("agents.changed", () => void refetchAgents()))
  const agentOf = (id: string) => agents().find((a) => a.id === id)
  /** The agents that hold a secret, for the filter. */
  const owners = createMemo(() => {
    const ids = [...new Set((all.latest ?? []).map((s) => s.agentId))]
    return ids.map((id) => ({ id, name: agentOf(id)?.name ?? t("secrets.unknownAgent") }))
  })

  const [replacing, setReplacing] = createSignal<SavedSecret>()
  const [deleting, setDeleting] = createSignal<SavedSecret>()
  const [error, setError] = createSignal<ErrorText>()
  let field: HTMLInputElement | undefined

  const replace = async (secret: SavedSecret) => {
    const value = field?.value ?? ""
    if (field) field.value = ""
    if (!value) return
    setError(undefined)
    try {
      await call("secrets.replace", { id: secret.id, value })
      setReplacing(undefined)
    } catch (e) {
      setError(describeError(e))
    }
  }
  const remove = async (secret: SavedSecret) => {
    setError(undefined)
    try {
      await call("secrets.delete", { id: secret.id })
      setDeleting(undefined)
    } catch (e) {
      setError(describeError(e))
    }
  }
  const authText = (auth: SecretAuth) =>
    auth.kind === "bearer"
      ? t("secret.auth.bearer")
      : auth.kind === "header"
        ? t("secret.auth.header", { header: auth.header })
        : t("secret.auth.basic", { user: auth.user })

  const row = (s: SavedSecret) => {
    const agent = () => agentOf(s.agentId)
    return (
      <li
        class={styles.logRow}
        data-testid="saved-secret"
        data-name={s.name}
        data-missing={s.valueMissing}
      >
        <div class={styles.logHead}>
          <span class={styles.secretAgent}>
            <Show when={agent()}>
              {(a) => <Face face={a().face} image={a().faceImage} size={20} />}
            </Show>
            <span>{agent()?.name ?? t("secrets.unknownAgent")}</span>
          </span>
          <span class={styles.label}>{s.name}</span>
          <Show when={s.valueMissing}>
            <span class={styles.logTag} data-result="failed" data-testid="saved-secret-missing">
              {t("secrets.missing")}
            </span>
          </Show>
        </div>
        <div class={styles.logTarget} data-testid="saved-secret-origin">
          {s.origin}
        </div>
        <div class={styles.hint}>
          {[
            authText(s.auth),
            t("secrets.saved", { date: formatDateTime(app.locale(), s.savedAt) }),
            s.lastUsedAt === null
              ? t("secrets.neverUsed")
              : t("secrets.lastUsed", { date: formatDateTime(app.locale(), s.lastUsedAt) }),
          ].join(" · ")}
        </div>
        <div class={styles.actions}>
          <Button
            onClick={() => {
              setError(undefined)
              setReplacing(s)
            }}
            data-testid="saved-secret-replace"
          >
            {t("secrets.replace")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setError(undefined)
              setDeleting(s)
            }}
            data-testid="saved-secret-delete"
          >
            {t("secrets.delete")}
          </Button>
        </div>
      </li>
    )
  }

  const errorLine = () => (
    <Show when={error()}>
      {(err) => (
        <div class={styles.error} role="alert" data-testid="saved-secret-error">
          {t(err().key, err().params)}
        </div>
      )}
    </Show>
  )

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
          <div class={`${styles.hint} ${styles.words}`}>{t("secrets.hint")}</div>
        </div>
        <Show when={owners().length > 0}>
          <select
            class={styles.select}
            aria-label={t("secrets.filterAgent")}
            data-testid="saved-secrets-agent"
            value={agentFilter()}
            onChange={(e) => setAgentFilter(e.currentTarget.value)}
          >
            <option value="">{t("secrets.allAgents")}</option>
            <For each={owners()}>{(o) => <option value={o.id}>{o.name}</option>}</For>
          </select>
        </Show>
      </div>
      <Show
        when={(secrets.latest ?? []).length > 0}
        fallback={
          <p class={styles.muted} data-testid="saved-secrets-empty">
            {t("secrets.empty")}
          </p>
        }
      >
        <ul class={styles.log} data-testid="saved-secrets-list">
          <For each={secrets.latest ?? []}>{row}</For>
        </ul>
      </Show>
      <Presence when={replacing()}>
        {(s) => (
          <Dialog
            label={t("secrets.replace.title", { name: s.name })}
            onClose={() => setReplacing(undefined)}
            testId="saved-secret-replace-dialog"
          >
            <h2 class={styles.label}>{t("secrets.replace.title", { name: s.name })}</h2>
            <div class={styles.logTarget}>{s.origin}</div>
            <form
              class={styles.actions}
              onSubmit={(e) => {
                e.preventDefault()
                void replace(s)
              }}
            >
              <input
                ref={field}
                class={styles.input}
                type="password"
                autocomplete="off"
                spellcheck={false}
                maxLength={16384}
                aria-label={t("secret.card.field")}
                placeholder={t("secret.card.field")}
                data-testid="saved-secret-replace-input"
                autofocus
              />
              <Button type="submit" variant="primary" data-testid="saved-secret-replace-save">
                {t("secrets.replace.save")}
              </Button>
              <Button onClick={() => setReplacing(undefined)}>{t("secrets.cancel")}</Button>
            </form>
            {errorLine()}
          </Dialog>
        )}
      </Presence>
      <Presence when={deleting()}>
        {(s) => (
          <Dialog
            label={t("secrets.delete.title", { name: s.name })}
            onClose={() => setDeleting(undefined)}
            testId="saved-secret-delete-dialog"
          >
            <h2 class={styles.label}>{t("secrets.delete.title", { name: s.name })}</h2>
            <p>{t("secrets.delete.body")}</p>
            {errorLine()}
            <div class={styles.actions}>
              <Button onClick={() => setDeleting(undefined)}>{t("secrets.cancel")}</Button>
              <Button
                variant="danger"
                onClick={() => void remove(s)}
                data-testid="saved-secret-delete-confirm"
              >
                {t("secrets.delete")}
              </Button>
            </div>
          </Dialog>
        )}
      </Presence>
    </div>
  )
}
