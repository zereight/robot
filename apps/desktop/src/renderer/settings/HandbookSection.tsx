import { charLength, HANDBOOK_MAX, type HandbookVersion, type MessageKey } from "@robot/shared"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./handbook.module.css"
import settings from "./settings.module.css"

/**
 * Settings, Handbook (spec 002, "Handbook"): one text that every agent of the server reads before
 * its own instructions, with the history of the last 20 versions and "Restore". On a linked
 * server the page shows the handbook of that server. A device reads it with no switch, and
 * changes it only with "Can create and change agents" (spec 012).
 */
export const HandbookSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const serverId = () => (ui.serverOffline() ? undefined : ui.server()?.id)
  const [handbook, { refetch }] = createResource(serverId, (id) =>
    call("handbook.get", { serverId: id }),
  )
  const [versions, { refetch: refetchVersions }] = createResource(serverId, (id) =>
    call("handbook.history", { serverId: id }),
  )
  const reload = () => {
    void refetch()
    void refetchVersions()
  }
  onCleanup(
    window.robot.on("handbook.changed", (e) => {
      if (e.serverId === serverId()) reload()
    }),
  )

  const [text, setText] = createSignal("")
  /** The text that the page last loaded. The editor follows a new text only while it is unchanged. */
  const [base, setBase] = createSignal<string>()
  createEffect(() => {
    const loaded = handbook()?.text
    if (loaded === undefined) return
    if (base() === undefined || text() === base()) setText(loaded)
    setBase(loaded)
  })

  const [error, setError] = createSignal<ErrorText>()
  const [saved, setSaved] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [openId, setOpenId] = createSignal<string>()

  const readOnly = () => !ui.canChange()
  const length = () => charLength(text())
  const tooLong = () => length() > HANDBOOK_MAX
  const dirty = () => base() !== undefined && text() !== base()

  const run = async (action: () => Promise<{ text: string }>) => {
    const id = serverId()
    if (!id || busy()) return
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const next = await action()
      setBase(next.text)
      setText(next.text)
      setSaved(true)
      reload()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    const id = serverId()
    if (id) void run(() => call("handbook.save", { serverId: id, text: text() }))
  }
  const restore = (version: HandbookVersion) => {
    const id = serverId()
    if (id) void run(() => call("handbook.restore", { serverId: id, versionId: version.id }))
  }

  return (
    <div data-testid="handbook-section">
      <p class={settings.note}>{t("handbook.hint")}</p>
      <p class={settings.note} data-testid="handbook-order">
        {t("handbook.order")}
      </p>
      <Show when={ui.linked()}>
        <p class={settings.note} data-testid="handbook-remote">
          {t("handbook.remote", { name: ui.server()?.name ?? "" })}
        </p>
      </Show>
      <Show
        when={!ui.serverOffline()}
        fallback={
          <p class={settings.note} data-testid="handbook-offline">
            {t("handbook.offline", { name: ui.server()?.name ?? "" })}
          </p>
        }
      >
        <Show when={ui.linked() && readOnly()}>
          <p class={settings.note} data-testid="handbook-readonly">
            {t("handbook.readonly", { name: ui.server()?.name ?? "" })}
          </p>
        </Show>
        <textarea
          class={styles.editor}
          value={text()}
          readOnly={readOnly()}
          placeholder={t("handbook.placeholder")}
          aria-label={t("handbook.label")}
          aria-invalid={tooLong()}
          onInput={(e) => {
            setText(e.currentTarget.value)
            setSaved(false)
          }}
          data-testid="handbook-text"
          data-user-data
        />
        <div class={styles.bar}>
          <span class={styles.counter} data-over={tooLong()} data-testid="handbook-count">
            {t("agents.counter", { used: length(), max: HANDBOOK_MAX })}
          </span>
          <Show when={saved() && !dirty()}>
            <span class={styles.saved} role="status" data-testid="handbook-saved">
              {t("handbook.saved")}
            </span>
          </Show>
          <Show when={!readOnly()}>
            <Button
              variant="primary"
              onClick={save}
              disabled={!dirty() || tooLong() || busy()}
              data-testid="handbook-save"
            >
              {t("handbook.save")}
            </Button>
          </Show>
        </div>
        <Show when={error()}>
          {(err) => (
            <p class={settings.error} role="alert" data-testid="handbook-error">
              {t(err().key, err().params)}
            </p>
          )}
        </Show>
        <Show when={handbook() && handbook()?.text === ""}>
          <p class={settings.note} data-testid="handbook-empty">
            {t("handbook.empty")}
          </p>
        </Show>
        <p class={settings.note} data-testid="handbook-sent">
          {t("handbook.sent")}
        </p>

        <h2 class={styles.historyTitle} data-testid="handbook-history-title">
          {t("handbook.history.title", { count: (versions() ?? []).length })}
        </h2>
        <p class={settings.note}>{t("handbook.history.hint")}</p>
        <Show when={(versions() ?? []).length === 0}>
          <p class={settings.note} data-testid="handbook-history-empty">
            {t("handbook.history.empty")}
          </p>
        </Show>
        <ul class={styles.history} data-testid="handbook-history">
          <For each={versions() ?? []}>
            {(version, index) => (
              <li
                class={styles.version}
                data-testid="handbook-version"
                data-source={version.source}
              >
                <div class={styles.versionRow}>
                  <span class={styles.versionMeta}>
                    {formatDateTime(app.locale(), version.createdAt)}
                    {" · "}
                    <span data-testid="handbook-version-source">
                      {t(`handbook.history.source.${version.source}` as MessageKey)}
                    </span>
                    <Show when={index() === 0}>
                      {" · "}
                      {t("handbook.history.current")}
                    </Show>
                  </span>
                  <div class={styles.versionActions}>
                    <Button
                      onClick={() => setOpenId(openId() === version.id ? undefined : version.id)}
                      data-testid="handbook-version-open"
                    >
                      {openId() === version.id
                        ? t("handbook.history.hide")
                        : t("handbook.history.open")}
                    </Button>
                    <Show when={index() > 0 && !readOnly()}>
                      <Button
                        onClick={() => restore(version)}
                        disabled={busy()}
                        data-testid="handbook-version-restore"
                      >
                        {t("handbook.history.restore")}
                      </Button>
                    </Show>
                  </div>
                </div>
                <Show when={openId() === version.id}>
                  <pre
                    class={styles.versionText}
                    data-testid="handbook-version-text"
                    data-user-data
                  >
                    {version.text === "" ? t("handbook.history.blank") : version.text}
                  </pre>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
