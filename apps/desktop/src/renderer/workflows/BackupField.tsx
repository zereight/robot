import {
  type MessageKey,
  type ModelChoice,
  type ModelPick,
  type NodePatch,
  sameModelChoice,
  type WorkflowNode,
} from "@robot/shared"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { BackupHold } from "./BackupHold.tsx"
import styles from "./graph.module.css"
import { createHolds } from "./holds.ts"

const effortKey = (effort: string) => `node.effort.${effort}` as MessageKey
const EFFORT_KEYS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * The choice "Backup model" under "Model" in the editor of a text node (spec 006, 010). It starts as
 * "None". The user picks a provider, a model and a reasoning level from the same lists as for the
 * main model. The editor refuses the same choice as the main one and says why. A backup that is not
 * ready on this computer (its account is missing or not connected) shows as text with a muted line,
 * so that an edit of another field cannot change it. This part of the editor is the only way to set
 * a backup: a proposal, the chat and a linked device cannot (docs/spec-questions.md, B6).
 */
export const BackupField = (props: {
  workflowId: string
  node: WorkflowNode
  choices: readonly ModelChoice[]
  patch: (change: NodePatch) => Promise<unknown>
}) => {
  const { t } = useApp()
  const holds = createHolds(() => props.workflowId)
  const [choosing, setChoosing] = createSignal(false)
  // The pick that the user builds before it is whole: a provider, then a model.
  const [account, setAccount] = createSignal("")
  const [model, setModel] = createSignal("")
  const [effort, setEffort] = createSignal("")
  const saved = createMemo(() => props.node.backup, undefined, {
    equals: (a, b) => (a === null && b === null) || sameModelChoice(a, b),
  })
  // The pick that is saved shows in the three fields. A pick that the user changes shows first, and
  // is saved when it is whole and differs from the main choice.
  createEffect(
    on(saved, (pick) => {
      if (!pick) return
      setAccount(pick.accountId)
      setModel(pick.model)
      setEffort(pick.effort ?? "")
    }),
  )
  const [refused, setRefused] = createSignal(false)
  const main = (): ModelPick | null =>
    props.node.accountId && props.node.model
      ? { accountId: props.node.accountId, model: props.node.model, effort: props.node.effort }
      : null
  const accountId = () => account()
  const choice = () => props.choices.find((c) => c.accountId === accountId())
  const modelId = () => model()
  const info = () => choice()?.models.find((m) => m.id === modelId())
  const effortId = () => effort()
  // A saved backup is ready when its account is connected on this computer (spec 006).
  const ready = () =>
    saved() === null || props.choices.some((c) => c.accountId === saved()?.accountId)
  const shown = () => saved() !== null || choosing()
  const save = (next: ModelPick) => {
    // The editor refuses the same provider, model and level as the main choice, and says why.
    if (sameModelChoice(main(), next)) {
      setRefused(true)
      return
    }
    setRefused(false)
    void props.patch({ backup: next }).then(() => {
      setChoosing(false)
    })
  }
  const remove = () => {
    setChoosing(false)
    setRefused(false)
    setAccount("")
    setModel("")
    setEffort("")
    void props.patch({ backup: null })
  }
  const label = (m: { id: string; label: string; labelKey?: MessageKey }) =>
    m.labelKey ? t(m.labelKey) : m.label
  return (
    <div class={styles.field} data-testid="node-backup">
      <span class={styles.fieldLabel}>{t("node.backup.label")}</span>
      <Show
        when={main() !== null || saved() !== null}
        fallback={
          <span class={styles.hintText} data-testid="node-backup-no-main">
            {t("node.backup.noMain")}
          </span>
        }
      >
        <Show
          when={shown()}
          fallback={
            <div class={styles.row}>
              <span data-testid="node-backup-none">{t("node.backup.none")}</span>
              <Button onClick={() => setChoosing(true)} data-testid="node-backup-choose">
                {t("node.backup.choose")}
              </Button>
            </div>
          }
        >
          <Show
            when={ready()}
            fallback={
              <>
                <span data-testid="node-backup-summary" data-user-data>
                  {[saved()?.model, saved()?.effort].filter(Boolean).join(" · ")}
                </span>
                <span class={styles.hintText} data-testid="node-backup-not-ready">
                  {t("node.backup.notReady")}
                </span>
                <div>
                  <Button onClick={remove} data-testid="node-backup-remove">
                    {t("node.backup.remove")}
                  </Button>
                </div>
              </>
            }
          >
            <select
              class={styles.control}
              aria-label={t("node.backup.provider")}
              data-testid="node-backup-provider"
              value={accountId()}
              onChange={(e) => {
                // The saved backup stays until a whole new choice is made: a provider alone is
                // not a choice. Only "default" (no provider) clears it.
                if (e.currentTarget.value === "") return remove()
                setRefused(false)
                setChoosing(true)
                setAccount(e.currentTarget.value)
                setModel("")
                setEffort("")
              }}
            >
              <option value="">{t("node.provider.default")}</option>
              <Keyed each={props.choices} by={(c) => c.accountId}>
                {(c) => (
                  <option value={c().accountId} selected={accountId() === c().accountId}>
                    {c().accountName}
                  </option>
                )}
              </Keyed>
            </select>
            <Show when={choice()}>
              {(chosen) => (
                <select
                  class={styles.control}
                  aria-label={t("node.backup.model")}
                  data-testid="node-backup-model"
                  value={modelId()}
                  onChange={(e) => {
                    setModel(e.currentTarget.value)
                    setEffort("")
                    const next = e.currentTarget.value
                    if (next) save({ accountId: accountId(), model: next, effort: null })
                  }}
                >
                  <option value="">{t("node.model.default")}</option>
                  <Keyed
                    each={chosen().models.filter((m) => !m.hidden || m.id === modelId())}
                    by={(m) => m.id}
                  >
                    {(m) => (
                      <option value={m().id} selected={modelId() === m().id}>
                        {label(m())}
                      </option>
                    )}
                  </Keyed>
                </select>
              )}
            </Show>
            <Show when={info()?.efforts.length}>
              <select
                class={styles.control}
                aria-label={t("node.backup.reasoning")}
                data-testid="node-backup-effort"
                value={effortId()}
                onChange={(e) => {
                  setEffort(e.currentTarget.value)
                  save({
                    accountId: accountId(),
                    model: modelId(),
                    effort: e.currentTarget.value || null,
                  })
                }}
              >
                <option value="">{t("node.reasoning.default")}</option>
                <For each={info()?.efforts ?? []}>
                  {(level) => (
                    <option value={level} selected={effortId() === level}>
                      {EFFORT_KEYS.includes(level) ? t(effortKey(level)) : level}
                    </option>
                  )}
                </For>
              </select>
            </Show>
            <Show when={refused()}>
              <span class={styles.errorText} role="alert" data-testid="node-backup-same">
                {t("node.backup.same")}
              </span>
            </Show>
            <Show when={saved() !== null}>
              <div>
                <Button onClick={remove} data-testid="node-backup-remove">
                  {t("node.backup.remove")}
                </Button>
              </div>
            </Show>
          </Show>
        </Show>
        <span class={styles.hintText}>{t("node.backup.hint")}</span>
        <Show when={holds().find((h) => h.nodeId === props.node.id)}>
          {(hold) => <BackupHold hold={hold()} testId="node-backup-hold" />}
        </Show>
      </Show>
    </div>
  )
}
