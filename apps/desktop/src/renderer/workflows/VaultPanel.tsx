import {
  type Locale,
  type MessageKey,
  type MessageParams,
  type SavedLogin,
  type SavedSecret,
  SECRET_REQUEST_TIMEOUT_MS,
  type SecretTestReason,
  type SecretTestResult,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./improve.module.css"

/** The catalogue key of the reason of Test, except the timeout with its seconds. */
const reasonKey: Record<Exclude<SecretTestReason, "timeout">, MessageKey> = {
  value_missing: "secrets.missing",
  keychain: "error.secret_keychain_read",
  invalid: "vault.test.reason.invalid",
  scheme: "vault.test.reason.scheme",
  http_public: "vault.test.reason.http_public",
  parts: "vault.test.reason.parts",
  blocked: "vault.test.reason.blocked",
  local_off: "error.secret_origin_local",
  other_origin: "vault.test.reason.other_origin",
  network: "vault.test.reason.network",
}

const rowDates = (
  t: (key: MessageKey, params?: MessageParams) => string,
  locale: Locale,
  row: { savedAt: number; lastUsedAt: number | null },
) =>
  [
    t("secrets.saved", { date: formatDateTime(locale, row.savedAt) }),
    row.lastUsedAt === null
      ? t("secrets.neverUsed")
      : t("secrets.lastUsed", { date: formatDateTime(locale, row.lastUsedAt) }),
  ].join(" · ")

/** The form that renames a secret or a login (spec 020, "Rename"). */
const RenameForm = (props: {
  name: string
  testId: string
  onClose: () => void
  onError: (e: unknown) => void
  onSave: (name: string) => Promise<unknown>
}) => {
  const { t } = useApp()
  let field: HTMLInputElement | undefined
  const save = () => {
    const name = field?.value.trim() ?? ""
    if (!name) return
    void props
      .onSave(name)
      .then(() => props.onClose())
      .catch(props.onError)
  }
  return (
    <form
      class={styles.actions}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <input
        ref={field}
        class={styles.input}
        value={props.name}
        maxLength={40}
        aria-label={t("vault.form.name")}
        data-testid={`${props.testId}-input`}
        autofocus
      />
      <Button onClick={props.onClose}>{t("secrets.cancel")}</Button>
      <Button type="submit" variant="primary" data-testid={`${props.testId}-save`}>
        {t("secrets.replace.save")}
      </Button>
    </form>
  )
}

/** The hidden field that replaces the value of a secret. Cleared when the save starts. */
const ValueForm = (props: {
  testId: string
  saveLabel: string
  onClose: () => void
  onError: (e: unknown) => void
  onSave: (value: string) => Promise<unknown>
}) => {
  const { t } = useApp()
  let field: HTMLInputElement | undefined
  const save = () => {
    const value = field?.value ?? ""
    // The field is cleared when the save starts (spec 020, "Replace").
    if (field) field.value = ""
    if (!value) return
    void props
      .onSave(value)
      .then(() => props.onClose())
      .catch(props.onError)
  }
  return (
    <form
      class={styles.actions}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <input
        ref={field}
        class={styles.input}
        type="password"
        autocomplete="off"
        spellcheck={false}
        aria-label={t("secret.card.field")}
        placeholder={t("secret.card.field")}
        data-testid={`${props.testId}-input`}
        autofocus
      />
      <Button onClick={props.onClose}>{t("secrets.cancel")}</Button>
      <Button type="submit" variant="primary" data-testid={`${props.testId}-save`}>
        {props.saveLabel}
      </Button>
    </form>
  )
}

/** The fields that replace the user name and the password of a login together. */
const LoginValuesForm = (props: {
  testId: string
  onClose: () => void
  onError: (e: unknown) => void
  onSave: (user: string, password: string) => Promise<unknown>
}) => {
  const { t } = useApp()
  let userField: HTMLInputElement | undefined
  let passwordField: HTMLInputElement | undefined
  const save = () => {
    const user = userField?.value.trim() ?? ""
    const password = passwordField?.value ?? ""
    if (passwordField) passwordField.value = ""
    if (!user || !password) return
    void props
      .onSave(user, password)
      .then(() => props.onClose())
      .catch(props.onError)
  }
  return (
    <form
      class={styles.actions}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <input
        ref={userField}
        class={styles.input}
        maxLength={200}
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.user")}
        placeholder={t("vault.form.user")}
        data-testid={`${props.testId}-user`}
        autofocus
      />
      <input
        ref={passwordField}
        class={styles.input}
        type="password"
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.password")}
        placeholder={t("vault.form.password")}
        data-testid={`${props.testId}-password`}
      />
      <Button onClick={props.onClose}>{t("secrets.cancel")}</Button>
      <Button type="submit" variant="primary" data-testid={`${props.testId}-save`}>
        {t("secrets.replace.save")}
      </Button>
    </form>
  )
}

/** The form that adds a secret by hand (spec 020, flow 4, "Add"). */
type SecretKind = "bearer" | "header" | "basic"
const SecretForm = (props: {
  workflowId: string
  kind: SecretKind
  onKind: (kind: SecretKind) => void
  testId: string
  onClose: () => void
  onError: (e: unknown) => void
}) => {
  const { t } = useApp()
  let nameField: HTMLInputElement | undefined
  let originField: HTMLInputElement | undefined
  let headerField: HTMLInputElement | undefined
  let userField: HTMLInputElement | undefined
  let valueField: HTMLInputElement | undefined
  const save = () => {
    const name = nameField?.value.trim() ?? ""
    const origin = originField?.value.trim() ?? ""
    const value = valueField?.value ?? ""
    if (valueField) valueField.value = ""
    if (!name || !origin || !value) return
    const kind = props.kind
    const base = { workflowId: props.workflowId, name, origin, value }
    const done = () => props.onClose()
    if (kind === "header")
      void call("secrets.add", { ...base, kind, header: headerField?.value.trim() ?? "" })
        .then(done)
        .catch(props.onError)
    else if (kind === "basic")
      void call("secrets.add", { ...base, kind, user: userField?.value.trim() ?? "" })
        .then(done)
        .catch(props.onError)
    else
      void call("secrets.add", { ...base, kind })
        .then(done)
        .catch(props.onError)
  }
  return (
    <form
      class={styles.actions}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <input
        ref={nameField}
        class={styles.input}
        maxLength={40}
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.name")}
        placeholder={t("vault.form.name")}
        data-testid={`${props.testId}-name`}
        autofocus
      />
      <input
        ref={originField}
        class={styles.input}
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.origin")}
        placeholder={t("vault.form.origin")}
        data-testid={`${props.testId}-origin`}
      />
      <select
        class={styles.input}
        aria-label={t("vault.form.kind")}
        value={props.kind}
        onChange={(e) => props.onKind(e.currentTarget.value as SecretKind)}
        data-testid={`${props.testId}-kind`}
      >
        <option value="bearer">{t("vault.form.kind.bearer")}</option>
        <option value="header">{t("vault.form.kind.header")}</option>
        <option value="basic">{t("vault.form.kind.basic")}</option>
      </select>
      <Show when={props.kind === "header"}>
        <input
          ref={headerField}
          class={styles.input}
          maxLength={200}
          autocomplete="off"
          spellcheck={false}
          aria-label={t("vault.form.header")}
          placeholder={t("vault.form.header")}
          data-testid={`${props.testId}-header`}
        />
      </Show>
      <Show when={props.kind === "basic"}>
        <input
          ref={userField}
          class={styles.input}
          maxLength={200}
          autocomplete="off"
          spellcheck={false}
          aria-label={t("vault.form.user")}
          placeholder={t("vault.form.user")}
          data-testid={`${props.testId}-user`}
        />
      </Show>
      <input
        ref={valueField}
        class={styles.input}
        type="password"
        autocomplete="off"
        spellcheck={false}
        aria-label={t("secret.card.field")}
        placeholder={t("secret.card.field")}
        data-testid={`${props.testId}-value`}
      />
      <Button onClick={props.onClose}>{t("secrets.cancel")}</Button>
      <Button type="submit" variant="primary" data-testid={`${props.testId}-save`}>
        {t("secrets.replace.save")}
      </Button>
    </form>
  )
}

/** The form that adds a login by hand (spec 020, "Manage"). A login has no way to send. */
const LoginForm = (props: {
  workflowId: string
  testId: string
  onClose: () => void
  onError: (e: unknown) => void
}) => {
  const { t } = useApp()
  let nameField: HTMLInputElement | undefined
  let originField: HTMLInputElement | undefined
  let userField: HTMLInputElement | undefined
  let passwordField: HTMLInputElement | undefined
  const save = () => {
    const name = nameField?.value.trim() ?? ""
    const origin = originField?.value.trim() ?? ""
    const user = userField?.value.trim() ?? ""
    const password = passwordField?.value ?? ""
    if (passwordField) passwordField.value = ""
    if (!name || !origin || !user || !password) return
    void call("logins.add", { workflowId: props.workflowId, name, origin, user, password })
      .then(() => props.onClose())
      .catch(props.onError)
  }
  return (
    <form
      class={styles.actions}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <input
        ref={nameField}
        class={styles.input}
        maxLength={40}
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.name")}
        placeholder={t("vault.form.name")}
        data-testid={`${props.testId}-name`}
        autofocus
      />
      <input
        ref={originField}
        class={styles.input}
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.origin")}
        placeholder={t("vault.form.origin")}
        data-testid={`${props.testId}-origin`}
      />
      <input
        ref={userField}
        class={styles.input}
        maxLength={200}
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.user")}
        placeholder={t("vault.form.user")}
        data-testid={`${props.testId}-user`}
      />
      <input
        ref={passwordField}
        class={styles.input}
        type="password"
        autocomplete="off"
        spellcheck={false}
        aria-label={t("vault.form.password")}
        placeholder={t("vault.form.password")}
        data-testid={`${props.testId}-password`}
      />
      <Button onClick={props.onClose}>{t("secrets.cancel")}</Button>
      <Button type="submit" variant="primary" data-testid={`${props.testId}-save`}>
        {t("secrets.replace.save")}
      </Button>
    </form>
  )
}

/**
 * The vault of the open workflow (spec 020, flow 4): its saved secrets and its saved logins.
 * Each row shows the name, the origin, the way to send it or the user name, the date it was
 * saved, and the date it was last used. No row shows a value. A linked device shows one muted
 * line (spec 020, V1).
 */
export const VaultPanel = (props: { workflowId: string }) => {
  const { t, locale } = useApp()
  const ui = useUi()
  const id = () => props.workflowId
  const [secrets, { refetch: refetchSecrets }] = createResource(id, (wid) =>
    call("secrets.list", { workflowId: wid }),
  )
  const [logins, { refetch: refetchLogins }] = createResource(id, (wid) =>
    call("logins.list", { workflowId: wid }),
  )
  onCleanup(
    window.robot.on("secrets.changed", () => {
      void refetchSecrets()
      void refetchLogins()
    }),
  )
  const refetch = () => {
    void refetchSecrets()
    void refetchLogins()
  }

  const [error, setError] = createSignal<ErrorText>()
  const shownError = () => {
    const e = error()
    return e && e.key !== "error.secret_keychain_read" ? e : undefined
  }
  const unreadable = () => {
    const failed = secrets.error ?? logins.error
    if (failed) return describeError(failed)
    const e = error()
    return e && e.key === "error.secret_keychain_read" ? e : undefined
  }
  const [results, setResults] = createSignal<Record<string, SecretTestResult | undefined>>({})
  const [testing, setTesting] = createSignal<string>()
  const [addingSecret, setAddingSecret] = createSignal(false)
  const [addingLogin, setAddingLogin] = createSignal(false)
  const [renamingSecret, setRenamingSecret] = createSignal<SavedSecret>()
  const [replacingSecret, setReplacingSecret] = createSignal<SavedSecret>()
  const [deletingSecret, setDeletingSecret] = createSignal<SavedSecret>()
  const [renamingLogin, setRenamingLogin] = createSignal<SavedLogin>()
  const [replacingLogin, setReplacingLogin] = createSignal<SavedLogin>()
  const [deletingLogin, setDeletingLogin] = createSignal<SavedLogin>()
  const [addKind, setAddKind] = createSignal<SecretKind>("bearer")

  const fail = (e: unknown) => setError(describeError(e))
  const authText = (auth: SavedSecret["auth"]) =>
    auth.kind === "bearer"
      ? t("secret.auth.bearer")
      : auth.kind === "header"
        ? t("secret.auth.header", { header: auth.header })
        : t("secret.auth.basic", { user: auth.user })

  const test = async (secret: SavedSecret) => {
    setTesting(secret.id)
    setError(undefined)
    try {
      const result = await call("secrets.test", { id: secret.id })
      setResults((all) => ({ ...all, [secret.id]: result }))
    } catch (e) {
      fail(e)
    } finally {
      setTesting(undefined)
    }
  }

  const testLine = (secret: SavedSecret) => {
    const result = results()[secret.id]
    if (!result) return null
    if (result.ok) return t("vault.test.status", { status: result.status })
    if (result.reason === "timeout")
      return t("vault.test.reason.timeout", { seconds: SECRET_REQUEST_TIMEOUT_MS / 1000 })
    return t(reasonKey[result.reason])
  }

  const errorLine = (testId: string) => (
    <Show when={shownError()}>
      {(err) => (
        <div class={styles.error} role="alert" data-testid={testId}>
          {t(err().key, err().params)}
        </div>
      )}
    </Show>
  )

  if (ui.server()?.kind !== "local")
    return (
      <p class={styles.muted} data-testid="vault-remote">
        {t("vault.remote", { name: ui.server()?.name ?? "" })}
      </p>
    )

  return (
    <div class={styles.page} data-testid="vault">
      <Show
        when={!unreadable()}
        fallback={
          <div data-testid="vault-unreadable">
            <p class={styles.error} role="alert">
              {t("vault.unreadable")}
            </p>
            <div class={styles.actions}>
              <Button onClick={refetch} data-testid="vault-retry">
                {t("vault.retry")}
              </Button>
            </div>
          </div>
        }
      >
        <h2 class={styles.subTitle}>{t("vault.secrets")}</h2>
        <Show
          when={!secrets.loading}
          fallback={
            <p class={styles.muted} data-testid="vault-loading">
              {t("vault.loading")}
            </p>
          }
        >
          <Show
            when={(secrets.latest ?? []).length > 0}
            fallback={
              <p class={styles.muted} data-testid="vault-secrets-empty">
                {t("vault.empty.secrets")}
              </p>
            }
          >
            <ul class={styles.list} data-testid="vault-secrets">
              <For each={secrets.latest ?? []}>
                {(s) => (
                  <li class={styles.item} data-testid="vault-secret" data-name={s.name}>
                    <span class={styles.itemText}>{s.name}</span>
                    <span class={styles.meta} data-testid="vault-secret-origin">
                      {s.origin}
                    </span>
                    <span class={styles.meta}>
                      {[authText(s.auth), rowDates(t, locale(), s)].join(" · ")}
                    </span>
                    <Show when={s.valueMissing}>
                      <span class={styles.meta} data-testid="vault-secret-missing">
                        {t("secrets.missing")}
                      </span>
                    </Show>
                    <Show when={testLine(s)}>
                      {(line) => (
                        <span class={styles.meta} data-testid="vault-secret-test-result">
                          {line()}
                        </span>
                      )}
                    </Show>
                    <div class={styles.actions}>
                      <Button
                        onClick={() => void test(s)}
                        disabled={testing() === s.id}
                        data-testid="vault-secret-test"
                      >
                        {t("vault.test")}
                      </Button>
                      <Button
                        onClick={() => {
                          setError(undefined)
                          setRenamingSecret(s)
                        }}
                        data-testid="vault-secret-rename"
                      >
                        {t("vault.rename")}
                      </Button>
                      <Button
                        onClick={() => {
                          setError(undefined)
                          setReplacingSecret(s)
                        }}
                        data-testid="vault-secret-replace"
                      >
                        {t("secrets.replace")}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          setError(undefined)
                          setDeletingSecret(s)
                        }}
                        data-testid="vault-secret-delete"
                      >
                        {t("secrets.delete")}
                      </Button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <div class={styles.actions}>
          <Button
            variant="primary"
            onClick={() => {
              setError(undefined)
              setAddKind("bearer")
              setAddingSecret(true)
            }}
            data-testid="vault-secret-add"
          >
            {t("vault.add.secret")}
          </Button>
        </div>

        <h2 class={styles.subTitle}>{t("vault.logins")}</h2>
        <Show
          when={!logins.loading}
          fallback={
            <p class={styles.muted} data-testid="vault-loading">
              {t("vault.loading")}
            </p>
          }
        >
          <Show
            when={(logins.latest ?? []).length > 0}
            fallback={
              <p class={styles.muted} data-testid="vault-logins-empty">
                {t("vault.empty.logins")}
              </p>
            }
          >
            <ul class={styles.list} data-testid="vault-logins">
              <For each={logins.latest ?? []}>
                {(login) => (
                  <li class={styles.item} data-testid="vault-login" data-name={login.name}>
                    <span class={styles.itemText}>{login.name}</span>
                    <span class={styles.meta} data-testid="vault-login-origin">
                      {login.origin}
                    </span>
                    <span class={styles.meta}>
                      {[login.user, rowDates(t, locale(), login)].join(" · ")}
                    </span>
                    <Show when={login.valueMissing}>
                      <span class={styles.meta} data-testid="vault-login-missing">
                        {t("secrets.missing")}
                      </span>
                    </Show>
                    <div class={styles.actions}>
                      <Button
                        onClick={() => {
                          setError(undefined)
                          setRenamingLogin(login)
                        }}
                        data-testid="vault-login-rename"
                      >
                        {t("vault.rename")}
                      </Button>
                      <Button
                        onClick={() => {
                          setError(undefined)
                          setReplacingLogin(login)
                        }}
                        data-testid="vault-login-replace"
                      >
                        {t("vault.login.replace")}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          setError(undefined)
                          setDeletingLogin(login)
                        }}
                        data-testid="vault-login-delete"
                      >
                        {t("secrets.delete")}
                      </Button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <div class={styles.actions}>
          <Button
            variant="primary"
            onClick={() => {
              setError(undefined)
              setAddingLogin(true)
            }}
            data-testid="vault-login-add"
          >
            {t("vault.add.login")}
          </Button>
        </div>
        {errorLine("vault-error")}
      </Show>

      <Presence when={addingSecret()}>
        {() => (
          <Dialog
            label={t("vault.add.secret.title")}
            onClose={() => setAddingSecret(false)}
            testId="vault-secret-add-dialog"
          >
            <h2 class={styles.title}>{t("vault.add.secret.title")}</h2>
            <SecretForm
              workflowId={id()}
              kind={addKind()}
              onKind={setAddKind}
              testId="vault-secret-add"
              onClose={() => setAddingSecret(false)}
              onError={fail}
            />
            {errorLine("vault-secret-add-error")}
          </Dialog>
        )}
      </Presence>

      <Presence when={addingLogin()}>
        {() => (
          <Dialog
            label={t("vault.add.login.title")}
            onClose={() => setAddingLogin(false)}
            testId="vault-login-add-dialog"
          >
            <h2 class={styles.title}>{t("vault.add.login.title")}</h2>
            <LoginForm
              workflowId={id()}
              testId="vault-login-add"
              onClose={() => setAddingLogin(false)}
              onError={fail}
            />
            {errorLine("vault-login-add-error")}
          </Dialog>
        )}
      </Presence>

      <Presence when={renamingSecret()}>
        {(s) => (
          <Dialog
            label={t("vault.rename.title", { name: s.name })}
            onClose={() => setRenamingSecret(undefined)}
            testId="vault-secret-rename-dialog"
          >
            <h2 class={styles.title}>{t("vault.rename.title", { name: s.name })}</h2>
            <RenameForm
              name={s.name}
              testId="vault-secret-rename"
              onClose={() => setRenamingSecret(undefined)}
              onError={fail}
              onSave={(name) => call("secrets.rename", { id: s.id, name })}
            />
            {errorLine("vault-secret-rename-error")}
          </Dialog>
        )}
      </Presence>

      <Presence when={renamingLogin()}>
        {(login) => (
          <Dialog
            label={t("vault.rename.title", { name: login.name })}
            onClose={() => setRenamingLogin(undefined)}
            testId="vault-login-rename-dialog"
          >
            <h2 class={styles.title}>{t("vault.rename.title", { name: login.name })}</h2>
            <RenameForm
              name={login.name}
              testId="vault-login-rename"
              onClose={() => setRenamingLogin(undefined)}
              onError={fail}
              onSave={(name) => call("logins.rename", { id: login.id, name })}
            />
            {errorLine("vault-login-rename-error")}
          </Dialog>
        )}
      </Presence>

      <Presence when={replacingSecret()}>
        {(s) => (
          <Dialog
            label={t("secrets.replace.title", { name: s.name })}
            onClose={() => setReplacingSecret(undefined)}
            testId="vault-secret-replace-dialog"
          >
            <h2 class={styles.title}>{t("secrets.replace.title", { name: s.name })}</h2>
            <ValueForm
              testId="vault-secret-replace"
              saveLabel={t("secrets.replace.save")}
              onClose={() => setReplacingSecret(undefined)}
              onError={fail}
              onSave={(value) => call("secrets.replace", { id: s.id, value })}
            />
            {errorLine("vault-secret-replace-error")}
          </Dialog>
        )}
      </Presence>

      <Presence when={replacingLogin()}>
        {(login) => (
          <Dialog
            label={t("vault.login.replace.title", { name: login.name })}
            onClose={() => setReplacingLogin(undefined)}
            testId="vault-login-replace-dialog"
          >
            <h2 class={styles.title}>{t("vault.login.replace.title", { name: login.name })}</h2>
            <LoginValuesForm
              testId="vault-login-replace"
              onClose={() => setReplacingLogin(undefined)}
              onError={fail}
              onSave={(user, password) => call("logins.replace", { id: login.id, user, password })}
            />
            {errorLine("vault-login-replace-error")}
          </Dialog>
        )}
      </Presence>

      <Presence when={deletingSecret()}>
        {(s) => (
          <Dialog
            label={t("secrets.delete.title", { name: s.name })}
            onClose={() => setDeletingSecret(undefined)}
            testId="vault-secret-delete-dialog"
          >
            <h2 class={styles.title}>{t("secrets.delete.title", { name: s.name })}</h2>
            <p class={styles.muted}>{t("vault.delete.body.secret")}</p>
            {errorLine("vault-secret-delete-error")}
            <div class={styles.actions}>
              <Button onClick={() => setDeletingSecret(undefined)}>{t("secrets.cancel")}</Button>
              <Button
                variant="danger"
                onClick={() =>
                  call("secrets.delete", { id: s.id })
                    .then(() => setDeletingSecret(undefined))
                    .catch(fail)
                }
                data-testid="vault-secret-delete-confirm"
              >
                {t("secrets.delete")}
              </Button>
            </div>
          </Dialog>
        )}
      </Presence>

      <Presence when={deletingLogin()}>
        {(login) => (
          <Dialog
            label={t("vault.login.delete.title", { name: login.name })}
            onClose={() => setDeletingLogin(undefined)}
            testId="vault-login-delete-dialog"
          >
            <h2 class={styles.title}>{t("vault.login.delete.title", { name: login.name })}</h2>
            <p class={styles.muted}>{t("vault.delete.body.login")}</p>
            {errorLine("vault-login-delete-error")}
            <div class={styles.actions}>
              <Button onClick={() => setDeletingLogin(undefined)}>{t("secrets.cancel")}</Button>
              <Button
                variant="danger"
                onClick={() =>
                  call("logins.delete", { id: login.id })
                    .then(() => setDeletingLogin(undefined))
                    .catch(fail)
                }
                data-testid="vault-login-delete-confirm"
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
