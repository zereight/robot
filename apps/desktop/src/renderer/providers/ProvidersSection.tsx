import {
  defaultBaseUrls,
  type MessageKey,
  type ProviderAccount,
  type ProviderKind,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./providers.module.css"

const kinds: readonly ProviderKind[] = ["openai", "anthropic", "custom"]

/** Add a new account, or give a new key to an existing one. */
const ConnectForm = (props: { account?: ProviderAccount; onDone: () => void }) => {
  const { t } = useApp()
  const [kind, setKind] = createSignal<ProviderKind>(props.account?.kind ?? "openai")
  const [name, setName] = createSignal(props.account?.name ?? "")
  const [baseUrl, setBaseUrl] = createSignal(props.account?.baseUrl ?? defaultBaseUrls.openai)
  const [apiKey, setApiKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()

  const changeKind = (next: ProviderKind) => {
    // Keep an address the user typed; replace one that was only a default.
    if (Object.values(defaultBaseUrls).includes(baseUrl())) setBaseUrl(defaultBaseUrls[next])
    setKind(next)
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await call("providers.connect", {
        ...(props.account ? { accountId: props.account.id } : {}),
        kind: kind(),
        name: name().trim() || t(`providers.kind.${kind()}` as MessageKey),
        baseUrl: baseUrl().trim(),
        apiKey: apiKey().trim(),
      })
      setApiKey("")
      props.onDone()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class={styles.form} onSubmit={submit} data-testid="provider-form">
      <label class={styles.field}>
        <span class={styles.label}>{t("providers.kind")}</span>
        <select
          class={styles.select}
          value={kind()}
          onChange={(e) => changeKind(e.currentTarget.value as ProviderKind)}
          data-testid="provider-kind"
        >
          <For each={kinds}>
            {(k) => <option value={k}>{t(`providers.kind.${k}` as MessageKey)}</option>}
          </For>
        </select>
      </label>
      <label class={styles.field}>
        <span class={styles.label}>{t("providers.name")}</span>
        <input
          class={styles.input}
          value={name()}
          placeholder={t("providers.name.placeholder")}
          onInput={(e) => setName(e.currentTarget.value)}
          data-testid="provider-name"
        />
      </label>
      <label class={styles.field}>
        <span class={styles.label}>{t("providers.baseUrl")}</span>
        <input
          class={styles.input}
          value={baseUrl()}
          onInput={(e) => setBaseUrl(e.currentTarget.value)}
          data-testid="provider-base-url"
          spellcheck={false}
        />
      </label>
      <label class={styles.field}>
        <span class={styles.label}>{t("providers.apiKey")}</span>
        <input
          class={styles.input}
          type="password"
          autocomplete="off"
          value={apiKey()}
          onInput={(e) => setApiKey(e.currentTarget.value)}
          data-testid="provider-api-key"
        />
        <span class={styles.hint}>{t("providers.apiKey.hint")}</span>
      </label>
      <Show when={error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="provider-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
      <div class={styles.actions}>
        <Button onClick={props.onDone}>{t("providers.cancel")}</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={busy() || !apiKey().trim() || !baseUrl().trim()}
          data-testid="provider-submit"
        >
          {busy() ? t("providers.checking") : t("providers.connect")}
        </Button>
      </div>
    </form>
  )
}

const AccountItem = (props: { account: ProviderAccount }) => {
  const { t } = useApp()
  const [reconnect, setReconnect] = createSignal(false)
  const [note, setNote] = createSignal<ErrorText>()
  const run = async (task: () => Promise<unknown>, ok?: MessageKey) => {
    setNote(undefined)
    try {
      await task()
      if (ok) setNote({ key: ok })
    } catch (e) {
      setNote(describeError(e))
    }
  }
  return (
    <li class={styles.item} data-testid={`provider-${props.account.id}`}>
      <div class={styles.itemMain}>
        <div class={styles.itemName}>{props.account.name}</div>
        <div class={styles.itemMeta}>
          {t(`providers.kind.${props.account.kind}` as MessageKey)} · {props.account.baseUrl}
        </div>
        <Show when={note()}>
          {(n) => (
            <div
              class={n().key.startsWith("error.") ? styles.error : styles.muted}
              data-testid="provider-note"
            >
              {t(n().key, n().params)}
            </div>
          )}
        </Show>
      </div>
      <span
        class={styles.status}
        data-connected={props.account.connected}
        data-testid="provider-status"
      >
        {props.account.connected ? t("providers.connected") : t("providers.notConnected")}
      </span>
      <Show
        when={props.account.connected}
        fallback={
          <Button onClick={() => setReconnect(true)} data-testid="provider-reconnect">
            {t("providers.reconnect")}
          </Button>
        }
      >
        <Button
          onClick={() =>
            run(
              () => call("providers.check", { accountId: props.account.id }),
              "providers.connected",
            )
          }
          data-testid="provider-check"
        >
          {t("providers.check")}
        </Button>
        <Button
          onClick={() => run(() => call("providers.disconnect", { accountId: props.account.id }))}
          data-testid="provider-disconnect"
        >
          {t("providers.disconnect")}
        </Button>
      </Show>
      <Button
        onClick={() => run(() => call("providers.remove", { accountId: props.account.id }))}
        data-testid="provider-remove"
      >
        {t("providers.remove")}
      </Button>
      <Show when={reconnect()}>
        <div style={{ width: "100%" }}>
          <ConnectForm account={props.account} onDone={() => setReconnect(false)} />
        </div>
      </Show>
    </li>
  )
}

/** Settings section: model accounts. */
export const ProvidersSection = () => {
  const { t } = useApp()
  const providers = useProviders()
  const [adding, setAdding] = createSignal(false)
  return (
    <div data-testid="providers-section">
      <Show
        when={providers.accounts().length > 0}
        fallback={<p class={styles.muted}>{t("providers.empty")}</p>}
      >
        <ul class={styles.list}>
          <For each={providers.accounts()}>{(account) => <AccountItem account={account} />}</For>
        </ul>
      </Show>
      <Show
        when={adding()}
        fallback={
          <Button variant="primary" onClick={() => setAdding(true)} data-testid="provider-add">
            {t("providers.add")}
          </Button>
        }
      >
        <ConnectForm onDone={() => setAdding(false)} />
      </Show>
      <p class={styles.muted} style={{ "margin-top": "16px" }}>
        {t("providers.runtimes")}
      </p>
    </div>
  )
}
