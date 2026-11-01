import type { AgentModel, MessageKey, ModelInfo } from "@robot/shared"
import { createEffect, createResource, createSignal, For, on, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import styles from "./providers.module.css"

/** Picks account, model and effort. Reports `null` while nothing complete is picked. */
export const ModelPicker = (props: {
  value: AgentModel | null
  onChange: (value: AgentModel | null) => void
}) => {
  const { t } = useApp()
  const providers = useProviders()
  const [accountId, setAccountId] = createSignal(
    props.value?.accountId ?? providers.accounts()[0]?.id ?? "",
  )
  const [model, setModel] = createSignal(props.value?.model ?? "")
  const [effort, setEffort] = createSignal<string | null>(props.value?.effort ?? null)

  const [models] = createResource(
    accountId,
    async (id): Promise<{ list: readonly ModelInfo[]; error?: MessageKey }> => {
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
    const first = providers.accounts()[0]
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
      when={providers.accounts().length > 0}
      fallback={<p class={styles.muted}>{t("model.noAccounts")}</p>}
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
            <For each={providers.accounts()}>
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
                    {m.label}
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
