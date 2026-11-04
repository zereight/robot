import {
  type AgentModel,
  carriedEffort,
  catalogues,
  type MessageKey,
  type ModelInfo,
  modelMatches,
  settledEffort,
} from "@robot/shared"
import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import styles from "./providers.module.css"

/** The search box shows when the list has this many models or more (spec 006, "Model list"). */
export const MODEL_SEARCH_MIN = 5

/**
 * Picks account, model and effort. Reports `null` while nothing complete is picked.
 *
 * `startEffort` is for the form of a new agent (spec 002, flow 1). While the user has not picked a
 * level, or "Default", by hand, the effort field shows this level when the model offers it, and
 * "Default" when it does not. Without it, the field starts as `value` says, and a model that
 * lacks the level gives the nearest level that it lists (spec 006, "Effort levels").
 */
export const ModelPicker = (props: {
  value: AgentModel | null
  onChange: (value: AgentModel | null) => void
  startEffort?: string | undefined
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
  /** True once the user picked a level, or "Default", in the field. The start is over then. */
  const [pickedByHand, setPickedByHand] = createSignal(false)

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
  const labelOf = (m: ModelInfo) => (m.labelKey ? t(m.labelKey) : m.label)
  /** The name of a model in the picker, with its tags as words: colour alone is not enough. */
  const optionText = (m: ModelInfo) =>
    [labelOf(m), m.isNew ? t("model.new") : null, m.hidden ? t("model.hidden") : null]
      .filter(Boolean)
      .join(" · ")
  const effortText = (level: string) => {
    const key = `model.effort.${level}`
    return key in catalogues.en ? t(key as MessageKey) : level
  }

  // The search box, and the folded group "Older models" (spec 006, "Model list").
  const [query, setQuery] = createSignal("")
  const [olderOpen, setOlderOpen] = createSignal(false)
  /**
   * A model that is off is missing from the picker and from its search. The model that the agent
   * uses stays, so that the field shows it, marked "Hidden". It also stays when the search does
   * not match it.
   */
  const shown = createMemo(() =>
    (models()?.list ?? []).filter(
      (m) => m.id === model() || (!m.hidden && modelMatches(m, labelOf(m), query())),
    ),
  )
  const recent = () => shown().filter((m) => !m.older)
  const older = () => shown().filter((m) => m.older)
  /** The group opens when the user types in the search box and when the model of the agent is in it. */
  const olderShown = () =>
    olderOpen() || query().trim() !== "" || older().some((m) => m.id === model())
  const matches = () =>
    (models()?.list ?? []).some((m) => !m.hidden && modelMatches(m, labelOf(m), query()))

  // The account list can arrive after the picker opens, for example right after a connect.
  createEffect(() => {
    const first = accounts()[0]
    if (first && !accountId()) setAccountId(first.id)
  })
  // Pick the first model when the account changes and the old model is not in its list. A model
  // that is off is not picked: when every model is off, nothing is picked.
  createEffect(
    on(models, (result) => {
      if (!result || result.list.length === 0) return
      if (!result.list.some((m) => m.id === model()))
        setModel(result.list.find((m) => !m.hidden)?.id ?? "")
    }),
  )
  // The effort follows the model. In the form of a new agent: the start while it counts, else the
  // pick of the user as far as the model offers it, and "Default" when it does not (spec 002). In
  // any other picker: the level stays when the model lists it, and else the nearest level that it
  // lists (spec 006). It waits for the list, so that a field that is filled in keeps its level
  // while the list loads.
  createEffect(() => {
    if (!models()?.list.length) return
    const next =
      props.startEffort !== undefined
        ? settledEffort(effort(), efforts(), pickedByHand() ? null : props.startEffort)
        : carriedEffort(effort(), efforts())
    if (next !== effort()) setEffort(next)
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
        {/* The search box has a row of its own, so that the model box and the effort box line up. */}
        <Show when={(models()?.list.length ?? 0) >= MODEL_SEARCH_MIN}>
          <div class={`${styles.field} ${styles.pickerWide}`}>
            <input
              class={styles.input}
              type="search"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={t("model.search")}
              aria-label={t("model.search")}
              spellcheck={false}
              data-testid="model-search"
            />
          </div>
        </Show>
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
          <div class={styles.field}>
            <span class={styles.label}>{t("model.model")}</span>
            <select
              class={styles.select}
              value={model()}
              onChange={(e) => setModel(e.currentTarget.value)}
              aria-label={t("model.model")}
              data-testid="model-model"
            >
              <For each={recent()}>
                {(m) => (
                  <option value={m.id} selected={m.id === model()}>
                    {optionText(m)}
                  </option>
                )}
              </For>
              {/* A folded group stays in the list, hidden: the dropdown leaves it out, and the
                  options can still be set by a program. */}
              <Show when={older().length > 0}>
                <optgroup
                  label={t("model.older")}
                  hidden={!olderShown()}
                  data-testid="model-older-group"
                >
                  <For each={older()}>
                    {(m) => (
                      <option value={m.id} selected={m.id === model()} hidden={!olderShown()}>
                        {optionText(m)}
                      </option>
                    )}
                  </For>
                </optgroup>
              </Show>
            </select>
            <Show when={(models()?.list ?? []).every((m) => m.hidden)}>
              <span class={styles.hint} data-testid="model-all-hidden">
                {t("model.allHidden")}
              </span>
            </Show>
            <Show when={query().trim() !== "" && !matches()}>
              <span class={styles.hint} data-testid="model-search-none">
                {t("model.search.none")}
              </span>
            </Show>
            {/* The group is folded until the user opens it, types in the search box, or has a model
                in it. The button folds it again when the user opened it. */}
            <Show when={older().length > 0 && (olderOpen() || !olderShown())}>
              <button
                type="button"
                class={styles.fold}
                aria-expanded={olderOpen()}
                onClick={() => setOlderOpen(!olderOpen())}
                data-testid="model-older-toggle"
              >
                {t("model.older.show", { count: older().length })}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={efforts().length > 0}>
          <label class={styles.field}>
            <span class={styles.label}>{t("model.effort")}</span>
            <select
              class={styles.select}
              value={effort() ?? ""}
              onChange={(e) => {
                setPickedByHand(true)
                setEffort(e.currentTarget.value || null)
              }}
              data-testid="model-effort"
            >
              <option value="" selected={effort() === null}>
                {t("model.effort.default")}
              </option>
              <For each={efforts()}>
                {(level) => (
                  <option value={level} selected={level === effort()}>
                    {effortText(level)}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
      </div>
    </Show>
  )
}
