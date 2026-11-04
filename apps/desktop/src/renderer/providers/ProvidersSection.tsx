import {
  defaultBaseUrls,
  isRuntimeKind,
  type MessageKey,
  type ProviderAccount,
  type ProviderKind,
  type RuntimeKind,
  runtimeHasSeparateSignIn,
} from "@robot/shared"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { flashRow, openTarget, takeTarget } from "../state/target.ts"
import { Button, Segmented } from "../ui/controls.tsx"
import { ModelsPart } from "./ModelsPart.tsx"
import styles from "./providers.module.css"
import { isReady, RuntimePanel, RuntimeReadiness, RuntimeSummary } from "./RuntimePanel.tsx"

/** The subscriptions come first: they are what most users have. */
const kinds: readonly ProviderKind[] = [
  "claude_code",
  "codex",
  "muse",
  "pi",
  "opencode",
  "openai",
  "anthropic",
  "custom",
]

/** Add a new account, or give a new key to an existing one. */
export const ConnectForm = (props: { account?: ProviderAccount; onDone: () => void }) => {
  const { t } = useApp()
  const providers = useProviders()
  const [kind, setKind] = createSignal<ProviderKind>(props.account?.kind ?? "claude_code")
  const [ready, setReady] = createSignal(false)
  const [name, setName] = createSignal(props.account?.name ?? "")
  const [baseUrl, setBaseUrl] = createSignal(props.account?.baseUrl ?? defaultBaseUrls.openai)
  const [apiKey, setApiKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()

  // A program that can have more than one sign-in. The account may use the sign-in that the
  // program has on this computer, but only one account does; any other account signs in on its own.
  const separate = () => runtimeHasSeparateSignIn(kind())
  const holder = () =>
    providers
      .accounts()
      .find((a) => a.kind === kind() && a.signIn === null && a.id !== props.account?.id)
  const [own, setOwn] = createSignal(!props.account && !!holder() && separate())
  const wantsOwn = () => !props.account && separate() && (own() || !!holder())
  // The id of the separate sign-in, made when the form needs one. It is given up again when the
  // form closes without an account that keeps it.
  const [draft, setDraft] = createSignal<string | null>(wantsOwn() ? crypto.randomUUID() : null)
  let kept = false
  const discard = (id: string | null) => {
    if (id)
      void call("providers.discardSignIn", { kind: "claude_code", signIn: id }).catch(() => {})
  }
  createEffect(() => {
    const want = wantsOwn()
    const current = untrack(draft)
    if (want && current === null) setDraft(crypto.randomUUID())
    if (!want && current !== null) {
      discard(current)
      setDraft(null)
    }
  })
  onCleanup(() => {
    if (!kept) discard(untrack(draft))
  })
  /** The sign-in that this account uses: its own, or null for the one of the computer. */
  const signIn = () => (props.account ? props.account.signIn : wantsOwn() ? draft() : null)

  const panelKey = createMemo(() => JSON.stringify([kind(), signIn()]))

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
      const account = props.account ? { accountId: props.account.id } : {}
      // Two accounts with the same name cannot be told apart in a list, so a name that the user
      // did not type gets a number.
      const taken = new Set(
        providers
          .accounts()
          .filter((a) => a.id !== props.account?.id)
          .map((a) => a.name),
      )
      const label = t(`providers.kind.${kind()}` as MessageKey)
      let fallback = label
      for (let n = 2; taken.has(fallback); n++) fallback = `${label} ${n}`
      const accountName = name().trim() || fallback
      await call(
        "providers.connect",
        isRuntimeKind(kind())
          ? {
              ...account,
              kind: kind(),
              name: accountName,
              ...(!props.account && signIn() ? { signIn: signIn() as string } : {}),
            }
          : {
              ...account,
              kind: kind(),
              name: accountName,
              baseUrl: baseUrl().trim(),
              apiKey: apiKey().trim(),
            },
      )
      setApiKey("")
      kept = true
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
      <Show
        when={isRuntimeKind(kind())}
        fallback={
          <>
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
          </>
        }
      >
        <Show when={separate() && !props.account}>
          <Show
            when={!holder()}
            fallback={
              <div class={styles.hint} data-testid="provider-signin-hint">
                {t("providers.signIn.taken", { name: holder()?.name ?? "" })}
              </div>
            }
          >
            <Segmented
              label={t("providers.signIn.choice")}
              value={own() ? "own" : "computer"}
              options={[
                { value: "computer", label: t("providers.signIn.computer") },
                { value: "own", label: t("providers.signIn.own") },
              ]}
              onChange={(value) => setOwn(value === "own")}
              testId="provider-signin-choice"
            />
            <div class={styles.hint} data-testid="provider-signin-hint">
              {t(own() ? "providers.signIn.ownHint" : "providers.signIn.computerHint")}
            </div>
          </Show>
        </Show>
        {/* The panel is made again when the program or the sign-in changes, and at no other time:
            the key is a plain text, so a new list of accounts does not make a new panel. */}
        <Show when={panelKey()} keyed>
          {(_key) => (
            <RuntimePanel
              kind={untrack(kind) as RuntimeKind}
              signIn={untrack(signIn)}
              onReady={setReady}
            />
          )}
        </Show>
      </Show>
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
          disabled={
            busy() || (isRuntimeKind(kind()) ? !ready() : !apiKey().trim() || !baseUrl().trim())
          }
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
          {t(`providers.kind.${props.account.kind}` as MessageKey)}
          {props.account.baseUrl ? ` · ${props.account.baseUrl}` : ""}
        </div>
        {/* The e-mail address tells accounts of one program apart. */}
        <Show
          when={props.account.connected && (props.account.runtime?.user || props.account.signIn)}
        >
          <div class={`${styles.itemMeta} ${styles.itemWho}`} data-testid="provider-who">
            {[
              props.account.runtime?.user,
              props.account.signIn ? t("providers.signIn.badge") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </Show>
        {/* The state of the program: a tag with text, the reason, and the time of the check. */}
        <Show when={props.account.runtime}>
          {(runtime) => (
            <>
              <RuntimeReadiness status={runtime()} prefix="provider-runtime" />
              <Show when={isReady(runtime())}>
                <RuntimeSummary status={runtime()} />
              </Show>
            </>
          )}
        </Show>
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
      {/* "Check again" changes nothing but the state and the time. "Repair" is the only action that
          changes the program (spec 006). */}
      <Show when={props.account.runtime}>
        {(runtime) => (
          <>
            <Button
              onClick={() =>
                run(() =>
                  call("runtimes.status", { kind: runtime().kind, signIn: runtime().signIn }),
                )
              }
              disabled={runtime().busy !== null}
              data-testid="provider-recheck"
            >
              {t("runtime.recheck")}
            </Button>
            <Show when={runtime().state === "needs_repair" || runtime().busy === "repairing"}>
              <Button
                variant="primary"
                onClick={() =>
                  run(() =>
                    call("runtimes.repair", { kind: runtime().kind, signIn: runtime().signIn }),
                  )
                }
                disabled={runtime().busy !== null}
                data-testid="provider-repair"
              >
                {runtime().busy === "repairing" ? t("runtime.repairing") : t("runtime.repair")}
              </Button>
            </Show>
          </>
        )}
      </Show>
      <Show
        when={props.account.connected}
        fallback={
          <Button onClick={() => setReconnect(true)} data-testid="provider-reconnect">
            {t("providers.reconnect")}
          </Button>
        }
      >
        <Show when={!props.account.runtime}>
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
        </Show>
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
      <ModelsPart account={props.account} />
    </li>
  )
}

/** Settings section: model accounts. */
export const ProvidersSection = () => {
  const { t } = useApp()
  const providers = useProviders()
  const [adding, setAdding] = createSignal(false)
  // The Today page asks for an account: its row lights up. An account that is gone is dropped.
  createEffect(() => {
    const target = openTarget()
    if (target?.kind !== "account") return
    if (providers.accounts().some((a) => a.id === target.id)) {
      queueMicrotask(() => {
        if (flashRow(`[data-testid="provider-${target.id}"]`)) takeTarget("account")
      })
    } else takeTarget("account")
  })
  const accountIds = createMemo(() => providers.accounts().map((a) => a.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  })
  return (
    <div data-testid="providers-section">
      <Show
        when={providers.accounts().length > 0}
        fallback={<p class={styles.muted}>{t("providers.empty")}</p>}
      >
        <ul class={styles.list}>
          {/* The list is of ids. A row is made once for an account: when the state of a program
              changes, the rows keep their open forms. */}
          <For each={accountIds()}>
            {(id) => (
              <Show when={providers.byId(id)}>
                {(account) => <AccountItem account={account()} />}
              </Show>
            )}
          </For>
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
