import { isRuntimeKind, type ModelInfo, type ProviderAccount, TOKEN_FIELD_MAX } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import styles from "./providers.module.css"

/**
 * The part "Models" of the page of an account (spec 006, "Model list"): one switch for each model,
 * "Hide all" and "Reset", and the fields "Context size" and "Output limit" for a custom model.
 * The choices belong to this computer. They do not sync.
 */
export const ModelsPart = (props: { account: ProviderAccount }) => {
  const { t } = useApp()
  const [open, setOpen] = createSignal(false)
  const [error, setError] = createSignal<{ id: string; text: ErrorText }>()
  const [newId, setNewId] = createSignal("")
  const id = () => props.account.id
  const canAdd = () => !isRuntimeKind(props.account.kind)

  // The rows keep their place and their fields when the list is read again: the store merges by id.
  const [models, setModels] = createStore<ModelInfo[]>([])
  const [, { refetch }] = createResource(
    () => (props.account.connected ? id() : undefined),
    async (accountId) => {
      const list = await call("providers.models", { accountId }).catch(() => [])
      setModels(reconcile([...list], { key: "id" }))
      return list
    },
  )
  // A check of the account fetches the list again: the part shows what is new.
  onCleanup(window.robot.on("providers.changed", () => void refetch()))

  const act = async (task: () => Promise<unknown>, at = "") => {
    setError(undefined)
    try {
      await task()
      await refetch()
    } catch (e) {
      setError({ id: at, text: describeError(e) })
      await refetch()
    }
  }
  const shownCount = () => models.filter((m) => !m.hidden).length

  /** A field takes a whole number from 1 to 10,000,000, or nothing. */
  const saveLimit = (
    model: string,
    field: "contextSize" | "outputLimit",
    input: HTMLInputElement,
  ) => {
    const text = input.value.trim()
    const value = text === "" ? null : Number(text)
    void act(
      () => call("providers.setModel", { accountId: id(), model, [field]: value }),
      `${model}:${field}`,
    ).then(() => {
      // A refused value does not stay in the field.
      if (error()) input.value = ""
    })
  }

  return (
    <Show when={props.account.connected}>
      <div class={styles.models} data-testid={`models-part-${id()}`}>
        <button
          type="button"
          class={styles.fold}
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
          data-testid="models-toggle"
        >
          {t("providers.models.open", { shown: shownCount(), count: models.length })}
        </button>
        <Show when={open()}>
          <div class={styles.modelsBody} data-testid="models-part">
            <h3 class={styles.modelsTitle}>{t("providers.models")}</h3>
            <p class={styles.hint}>{t("providers.models.hint")}</p>
            <Show when={models.some((m) => m.custom)}>
              <p class={styles.hint}>{t("providers.models.limitHint")}</p>
            </Show>
            <div class={styles.actions} style={{ "justify-content": "flex-start" }}>
              <Button
                onClick={() =>
                  act(() => call("providers.setAllModels", { accountId: id(), hidden: true }))
                }
                disabled={models.length === 0}
                data-testid="models-hide-all"
              >
                {t("providers.models.hideAll")}
              </Button>
              <Button
                onClick={() =>
                  act(() => call("providers.setAllModels", { accountId: id(), hidden: false }))
                }
                disabled={models.length === 0}
                data-testid="models-reset"
              >
                {t("providers.models.reset")}
              </Button>
            </div>
            <Show
              when={models.length > 0}
              fallback={<p class={styles.muted}>{t("providers.models.empty")}</p>}
            >
              <ul class={styles.modelList}>
                <For each={models}>
                  {(m) => (
                    <li class={styles.modelRow} data-testid={`model-row-${m.id}`}>
                      <div class={styles.modelHead}>
                        <Switch
                          label={t("providers.models.show", { name: m.label })}
                          checked={!m.hidden}
                          onChange={(on) =>
                            act(() =>
                              call("providers.setModel", {
                                accountId: id(),
                                model: m.id,
                                hidden: !on,
                              }),
                            )
                          }
                          testId={`model-switch-${m.id}`}
                        />
                        <div class={styles.modelName}>
                          <span>{m.labelKey ? t(m.labelKey) : m.label}</span>
                          <Show when={m.label !== m.id && !m.labelKey}>
                            <span class={styles.itemMeta}>{m.id}</span>
                          </Show>
                        </div>
                        <Show when={m.isNew}>
                          <span class={styles.stateTag} data-testid={`model-new-${m.id}`}>
                            {t("model.new")}
                          </span>
                        </Show>
                        <Show when={m.older}>
                          <span class={styles.stateTag}>{t("model.older")}</span>
                        </Show>
                        <Show when={m.added}>
                          <span class={styles.stateTag}>{t("providers.models.custom")}</span>
                          <Button
                            variant="danger"
                            onClick={() =>
                              act(() =>
                                call("providers.removeModel", { accountId: id(), model: m.id }),
                              )
                            }
                            aria-label={t("providers.models.removeOne", { name: m.label })}
                            data-testid={`model-remove-${m.id}`}
                          >
                            {t("providers.remove")}
                          </Button>
                        </Show>
                      </div>
                      {/* The fields belong to a custom model: every model of an account with its own
                          address, and a model ID that the user typed. */}
                      <Show when={m.custom}>
                        <div class={styles.modelFields}>
                          <label class={styles.field}>
                            <span class={styles.label}>{t("providers.models.contextSize")}</span>
                            <input
                              class={styles.input}
                              type="number"
                              inputmode="numeric"
                              min="1"
                              max={TOKEN_FIELD_MAX}
                              step="1"
                              value={m.contextWindow ?? ""}
                              onChange={(e) => saveLimit(m.id, "contextSize", e.currentTarget)}
                              data-testid={`model-context-${m.id}`}
                            />
                          </label>
                          <label class={styles.field}>
                            <span class={styles.label}>{t("providers.models.outputLimit")}</span>
                            <input
                              class={styles.input}
                              type="number"
                              inputmode="numeric"
                              min="1"
                              max={TOKEN_FIELD_MAX}
                              step="1"
                              value={m.outputLimit ?? ""}
                              onChange={(e) => saveLimit(m.id, "outputLimit", e.currentTarget)}
                              data-testid={`model-output-${m.id}`}
                            />
                          </label>
                          <Show when={error()?.id.startsWith(`${m.id}:`) ? error() : undefined}>
                            {(err) => (
                              <span
                                class={styles.error}
                                role="alert"
                                data-testid="model-limit-error"
                              >
                                {t(err().text.key, err().text.params)}
                              </span>
                            )}
                          </Show>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={canAdd()}>
              <form
                class={styles.modelAdd}
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = newId().trim()
                  if (!name) return
                  void act(
                    () => call("providers.addModel", { accountId: id(), model: name }),
                    "add",
                  ).then(() => {
                    if (!error()) setNewId("")
                  })
                }}
              >
                <label class={styles.field}>
                  <span class={styles.label}>{t("providers.models.addId")}</span>
                  <input
                    class={styles.input}
                    value={newId()}
                    onInput={(e) => setNewId(e.currentTarget.value)}
                    spellcheck={false}
                    data-testid="model-add-id"
                  />
                </label>
                <Button type="submit" disabled={newId().trim() === ""} data-testid="model-add">
                  {t("providers.models.add")}
                </Button>
                <Show when={error()?.id === "add" ? error() : undefined}>
                  {(err) => (
                    <span class={styles.error} role="alert">
                      {t(err().text.key, err().text.params)}
                    </span>
                  )}
                </Show>
              </form>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
