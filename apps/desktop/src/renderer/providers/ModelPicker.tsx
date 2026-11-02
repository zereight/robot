import type { AgentModel, MessageKey, ModelInfo } from "@robot/shared"
import { createEffect, createResource, createSignal, For, on, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import styles from "./providers.module.css"

/** Picks account, model and effort. Reports `null` while nothing complete is picked. */
export const ModelPicker = (props: {
  value: AgentModel | null
  onChange: (value: AgentModel | null) => void
}) => {
  const { t } = useApp()
  const providers = useProviders()
  const ui = useUi()
  // On a linked server the choices are the accounts that are connected on that server, with their
  // models. The window never sees a key, and cannot add or change an account there (spec 012).
  const remote = () => ui.linked()
  const [offered] = createResource(
    () => (remote() ? (ui.server()?.id ?? "") : ""),
    (id) => (id ? call("models.available").catch(() => []) : []),
  )
  const accounts = (): readonly { id: string; name: string; connected: boolean }[] =>
    remote()
      ? (offered() ?? []).map((c) => ({ id: c.accountId, name: c.accountName, connected: true }))
      : providers.accounts()
  const [accountId, setAccountId] = createSignal(props.value?.accountId ?? accounts()[0]?.id ?? "")
  const [model, setModel] = createSignal(props.value?.model ?? "")
  const [effort, setEffort] = createSignal<string | null>(props.value?.effort ?? null)

  const [models] = createResource(
    accountId,
    async (id): Promise<{ list: readonly ModelInfo[]; error?: MessageKey }> => {
      if (remote()) {
        return {
          list:
            (await call("models.available").catch(() => [])).find((c) => c.accountId === id)
              ?.models ?? [],
        }
      }
      if (!id || !providers.byId(id)?.connected) return { list: [] }
      try {
        return { list: await call("providers.models", { accountId: id }) }
      } catch (e) {
        return { list: [], error: describeError(e).key }
      }
    },
  )
  const current = () => models()?.list.find((m) => m.id === model())
  const efforts = () => current()?.efforts ?? []

  // The account list can arrive after the picker opens, for example right after a connect.
  createEffect(() => {
    const first = accounts()[0]
    if (first && !accountId()) setAccountId(first.id)
  })
  // Pick the first model when the account changes and the old model is not in its list.
  createEffect(
    on(models, (result) => {
      if (!result || result.list.length === 0) return
      if (!result.list.some((m) => m.id === model())) setModel(result.list[0]?.id ?? "")
    }),
  )
  createEffect(() => {
    if (effort() !== null && !efforts().includes(effort() as string) && models()?.list.length)
      setEffort(null)
  })
  createEffect(() => {
    const id = accountId()
    const m = model().trim()
    props.onChange(
      id && m ? { accountId: id, model: m, effort: efforts().length ? effort() : null } : null,
    )
  })

  return (
    <Show
      when={accounts().length > 0}
      fallback={
        <p class={styles.muted} data-testid="model-no-accounts">
          {remote()
            ? t("model.noAccounts.remote", { name: ui.server()?.name ?? "" })
            : t("model.noAccounts")}
        </p>
      }
    >
      <div class={styles.picker} data-testid="model-picker">
        <label class={`${styles.field} ${styles.pickerWide}`}>
          <span class={styles.label}>{t("model.account")}</span>
          <select
            class={styles.select}
            value={accountId()}
            onChange={(e) => setAccountId(e.currentTarget.value)}
            data-testid="model-account"
          >
            <For each={accounts()}>
              {(a) => (
                <option value={a.id} selected={a.id === accountId()}>
                  {a.name}
                  {a.connected ? "" : ` (${t("providers.notConnected")})`}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show
          when={(models()?.list.length ?? 0) > 0}
          fallback={
            <label class={styles.field}>
              <span class={styles.label}>{t("model.manual")}</span>
              <input
                class={styles.input}
                value={model()}
                onInput={(e) => setModel(e.currentTarget.value)}
                placeholder={models.loading ? t("model.loading") : ""}
                data-testid="model-manual"
              />
              <Show when={models()?.error}>
                {(key) => <span class={styles.error}>{t(key())}</span>}
              </Show>
            </label>
          }
        >
          <label class={styles.field}>
            <span class={styles.label}>{t("model.model")}</span>
            <select
              class={styles.select}
              value={model()}
              onChange={(e) => setModel(e.currentTarget.value)}
              data-testid="model-model"
            >
              <For each={models()?.list}>
                {(m) => (
                  <option value={m.id} selected={m.id === model()}>
                    {m.labelKey ? t(m.labelKey) : m.label}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
        <Show when={efforts().length > 0}>
          <label class={styles.field}>
            <span class={styles.label}>{t("model.effort")}</span>
            <select
              class={styles.select}
              value={effort() ?? ""}
              onChange={(e) => setEffort(e.currentTarget.value || null)}
              data-testid="model-effort"
            >
              <option value="" selected={effort() === null}>
                {t("model.effort.none")}
              </option>
              <For each={efforts()}>
                {(level) => (
                  <option value={level}>{t(`model.effort.${level}` as MessageKey)}</option>
                )}
              </For>
            </select>
          </label>
        </Show>
      </div>
    </Show>
  )
}
