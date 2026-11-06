import {
  isLooser,
  type MessageKey,
  type ModelChoice,
  type NodePatch,
  OPTIONS_MIN,
  PERMISSION_LEVELS,
  type PermissionLevel,
  type WorkflowDetail,
  type WorkflowNode,
} from "@robot/shared"
import { Plus, Trash2, X } from "lucide-solid"
import { createSignal, For, type JSX, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button, IconButton, Switch } from "../ui/controls.tsx"
import styles from "./graph.module.css"

const levelKey = (level: PermissionLevel) => `permission.level.${level}` as MessageKey
const effortKey = (effort: string) => `node.effort.${effort}` as MessageKey
const EFFORT_KEYS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

const Field = (props: { label: string; hint?: string; children: JSX.Element }) => (
  <div class={styles.field}>
    <span class={styles.fieldLabel} aria-hidden="true">
      {props.label}
    </span>
    {props.children}
    <Show when={props.hint}>
      <span class={styles.hintText}>{props.hint}</span>
    </Show>
  </div>
)

/**
 * The side panel of one node (spec 010, flow 2): name, prompt, provider, model, reasoning level,
 * permission level and the connections of a text node; question, threshold, options and the target
 * of each option of a decision node. A change saves when the field loses focus.
 */
export const NodePanel = (props: {
  workflow: WorkflowDetail
  node: WorkflowNode
  choices: readonly ModelChoice[]
  readOnly: boolean
  onDeleted: () => void
}) => {
  const { t } = useApp()
  const [problem, setProblem] = createSignal<ErrorText>()
  const [removing, setRemoving] = createSignal<string>() // id of the connection that asks
  const [deleting, setDeleting] = createSignal(false)
  const graph = () => props.workflow.graph
  const guard = async <T,>(work: () => Promise<T>) => {
    setProblem(undefined)
    try {
      return await work()
    } catch (e) {
      setProblem(describeError(e))
      return undefined
    }
  }
  const patch = (change: NodePatch) =>
    guard(() => call("workflows.node.update", { id: props.node.id, patch: change }))

  const choice = () => props.choices.find((c) => c.accountId === props.node.accountId)
  const modelInfo = () => choice()?.models.find((m) => m.id === props.node.model)
  const modelLabel = (m: { id: string; label: string; labelKey?: MessageKey }) =>
    m.labelKey ? t(m.labelKey) : m.label
  const allowedLevels = () =>
    PERMISSION_LEVELS.filter((l) => !isLooser(l, props.workflow.permission))
  const others = () => graph().nodes.filter((n) => n.id !== props.node.id)
  const outgoing = () =>
    graph().connections.filter((c) => c.from === props.node.id && c.optionId === null)
  const nodeOf = (id: string) => graph().nodes.find((n) => n.id === id)
  const targetOf = (optionId: string) => graph().connections.find((c) => c.optionId === optionId)

  const setTarget = (optionId: string, to: string) =>
    guard(async () => {
      const existing = targetOf(optionId)
      if (existing) {
        if (existing.to === to) return
        await call("workflows.disconnect", { id: existing.id })
      }
      if (to !== "")
        await call("workflows.connect", {
          workflowId: props.workflow.id,
          from: props.node.id,
          to,
          optionId,
        })
    })

  return (
    <section
      class={styles.panel}
      aria-label={t("graph.panel.title", {
        number: props.node.number,
        kind: t(props.node.kind === "text" ? "graph.kind.text" : "graph.kind.decision"),
      })}
      data-testid="node-panel"
    >
      <h3>
        {t("graph.panel.title", {
          number: props.node.number,
          kind: t(props.node.kind === "text" ? "graph.kind.text" : "graph.kind.decision"),
        })}
      </h3>
      <fieldset disabled={props.readOnly} class={styles.fields}>
        <Field label={t("node.name")}>
          <input
            class={styles.control}
            value={props.node.name}
            aria-label={t("node.name")}
            data-testid="node-name"
            onChange={(e) => void patch({ name: e.currentTarget.value })}
          />
        </Field>

        <Show
          when={props.node.kind === "text"}
          fallback={
            <>
              <Field label={t("node.question")}>
                <textarea
                  class={styles.control}
                  value={props.node.question}
                  aria-label={t("node.question")}
                  data-testid="node-question"
                  onChange={(e) => void patch({ question: e.currentTarget.value })}
                />
              </Field>
              <Field label={t("node.threshold")} hint={t("node.threshold.hint")}>
                <input
                  class={styles.control}
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={props.node.threshold}
                  aria-label={t("node.threshold")}
                  data-testid="node-threshold"
                  onChange={(e) => void patch({ threshold: Number(e.currentTarget.value) })}
                />
              </Field>
              <p class={styles.hintText}>{t("node.decisionModel")}</p>
              <div class={styles.field}>
                <span class={styles.fieldLabel}>{t("node.options")}</span>
                <For each={props.node.options}>
                  {(option, i) => (
                    <div class={styles.optionRow} data-testid="node-option">
                      <input
                        class={styles.control}
                        value={option.label}
                        aria-label={t("node.option.label", { n: i() + 1 })}
                        data-testid="node-option-label"
                        onChange={(e) =>
                          void guard(() =>
                            call("workflows.option.rename", {
                              id: option.id,
                              label: e.currentTarget.value,
                            }),
                          )
                        }
                      />
                      <select
                        class={styles.control}
                        aria-label={t("node.option.target", { n: i() + 1 })}
                        data-testid="node-option-target"
                        value={targetOf(option.id)?.to ?? ""}
                        onChange={(e) => void setTarget(option.id, e.currentTarget.value)}
                      >
                        <option value="">{t("node.target.none")}</option>
                        <For each={others()}>
                          {(n) => (
                            <option value={n.id} selected={targetOf(option.id)?.to === n.id}>
                              {n.number}. {n.name}
                            </option>
                          )}
                        </For>
                      </select>
                      <IconButton
                        label={t("node.option.remove", { n: i() + 1 })}
                        disabled={props.node.options.length <= OPTIONS_MIN}
                        data-testid="node-option-remove"
                        onClick={() =>
                          void guard(() => call("workflows.option.remove", { id: option.id }))
                        }
                      >
                        <X size={16} />
                      </IconButton>
                    </div>
                  )}
                </For>
                <div>
                  <Button
                    data-testid="node-option-add"
                    onClick={() =>
                      void guard(() =>
                        call("workflows.option.add", {
                          nodeId: props.node.id,
                          label: `${t("node.option.label", { n: props.node.options.length + 1 })}`,
                        }),
                      )
                    }
                  >
                    <Plus size={14} /> {t("node.option.add")}
                  </Button>
                </div>
              </div>
            </>
          }
        >
          <Field label={t("node.prompt")} hint={t("node.prompt.hint")}>
            <textarea
              class={styles.control}
              value={props.node.prompt}
              aria-label={t("node.prompt")}
              data-testid="node-prompt"
              onChange={(e) => void patch({ prompt: e.currentTarget.value })}
            />
          </Field>
          <Field label={t("node.provider")}>
            <select
              class={styles.control}
              aria-label={t("node.provider")}
              data-testid="node-provider"
              value={props.node.accountId ?? ""}
              onChange={(e) =>
                void patch({ accountId: e.currentTarget.value || null, model: null, effort: null })
              }
            >
              <option value="">{t("node.provider.default")}</option>
              <For each={props.choices}>
                {(c) => (
                  <option value={c.accountId} selected={props.node.accountId === c.accountId}>
                    {c.accountName}
                  </option>
                )}
              </For>
            </select>
          </Field>
          <Show when={choice()}>
            {(account) => (
              <Field label={t("node.model")}>
                <select
                  class={styles.control}
                  aria-label={t("node.model")}
                  data-testid="node-model"
                  value={props.node.model ?? ""}
                  onChange={(e) => {
                    const model = e.currentTarget.value || null
                    const next = account().models.find((m) => m.id === model)
                    const keep =
                      next && props.node.effort && next.efforts.includes(props.node.effort)
                    void patch({ model, ...(keep ? {} : { effort: null }) })
                  }}
                >
                  <option value="">{t("node.model.default")}</option>
                  <For
                    each={account().models.filter((m) => !m.hidden || m.id === props.node.model)}
                  >
                    {(m) => (
                      <option value={m.id} selected={props.node.model === m.id}>
                        {modelLabel(m)}
                      </option>
                    )}
                  </For>
                </select>
              </Field>
            )}
          </Show>
          <Show when={modelInfo()?.efforts.length}>
            <Field label={t("node.reasoning")}>
              <select
                class={styles.control}
                aria-label={t("node.reasoning")}
                data-testid="node-effort"
                value={props.node.effort ?? ""}
                onChange={(e) => void patch({ effort: e.currentTarget.value || null })}
              >
                <option value="">{t("node.reasoning.default")}</option>
                <For each={modelInfo()?.efforts ?? []}>
                  {(effort) => (
                    <option value={effort} selected={props.node.effort === effort}>
                      {EFFORT_KEYS.includes(effort) ? t(effortKey(effort)) : effort}
                    </option>
                  )}
                </For>
              </select>
            </Field>
          </Show>
          <Field label={t("node.permission")} hint={t("node.permission.hint")}>
            <select
              class={styles.control}
              aria-label={t("node.permission")}
              data-testid="node-permission"
              value={props.node.permission ?? ""}
              onChange={(e) =>
                void patch({
                  permission: (e.currentTarget.value || null) as PermissionLevel | null,
                })
              }
            >
              <option value="">{t("node.permission.workflow")}</option>
              <For each={allowedLevels()}>
                {(level) => (
                  <option value={level} selected={props.node.permission === level}>
                    {t(levelKey(level))}
                  </option>
                )}
              </For>
            </select>
          </Field>
          <div class={styles.field}>
            <span class={styles.fieldLabel}>{t("node.next")}</span>
            <Show
              when={outgoing().length > 0}
              fallback={<p class={styles.hintText}>{t("node.next.none")}</p>}
            >
              <ul class={styles.list}>
                <For each={outgoing()}>
                  {(c) => (
                    <li class={styles.listRow} data-testid="node-next">
                      <span>
                        {nodeOf(c.to)?.number}. {nodeOf(c.to)?.name}
                      </span>
                      <IconButton
                        label={t("node.next.remove", { name: nodeOf(c.to)?.name ?? "" })}
                        data-testid="node-next-remove"
                        onClick={() => setRemoving(c.id)}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={removing()}>
              {(id) => {
                const c = () => graph().connections.find((x) => x.id === id())
                return (
                  <Show when={c()}>
                    {(conn) => (
                      <Confirm
                        ask={t("node.next.remove.ask", {
                          number: nodeOf(conn().to)?.number ?? 0,
                          name: nodeOf(conn().to)?.name ?? "",
                        })}
                        confirm={t("node.next.remove.confirm")}
                        keep={t("common.keep")}
                        testId="node-next-ask"
                        confirmTestId="node-next-confirm"
                        onKeep={() => setRemoving(undefined)}
                        onConfirm={() => {
                          void guard(() => call("workflows.disconnect", { id: conn().id })).then(
                            () => setRemoving(undefined),
                          )
                        }}
                      />
                    )}
                  </Show>
                )
              }}
            </Show>
            <select
              class={styles.control}
              aria-label={t("node.next.add")}
              data-testid="node-next-add"
              value=""
              onChange={(e) => {
                const to = e.currentTarget.value
                e.currentTarget.value = ""
                if (to)
                  void guard(() =>
                    call("workflows.connect", {
                      workflowId: props.workflow.id,
                      from: props.node.id,
                      to,
                    }),
                  )
              }}
            >
              <option value="">{t("node.next.add")}</option>
              <For each={others().filter((n) => !outgoing().some((c) => c.to === n.id))}>
                {(n) => (
                  <option value={n.id}>
                    {n.number}. {n.name}
                  </option>
                )}
              </For>
            </select>
          </div>
          <div class={styles.row}>
            <Switch
              label={t("node.continue")}
              checked={props.node.continueOnFailure}
              testId="node-continue"
              onChange={(checked) => void patch({ continueOnFailure: checked })}
            />
            <span>
              {t("node.continue")}
              <span class={styles.hintText}> {t("node.continue.hint")}</span>
            </span>
          </div>
        </Show>
      </fieldset>

      <Show when={problem()}>
        {(p) => (
          <p class={styles.errorText} role="alert" data-testid="node-error">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>

      <Show when={!props.readOnly}>
        <Show
          when={deleting()}
          fallback={
            <div>
              <Button variant="danger" onClick={() => setDeleting(true)} data-testid="node-delete">
                {t("node.delete")}
              </Button>
            </div>
          }
        >
          <Confirm
            ask={t("node.delete.ask", { number: props.node.number, name: props.node.name })}
            confirm={t("node.delete")}
            keep={t("common.keep")}
            testId="node-delete-ask"
            confirmTestId="node-delete-confirm"
            onKeep={() => setDeleting(false)}
            onConfirm={() => {
              void guard(() => call("workflows.node.remove", { id: props.node.id })).then((r) => {
                setDeleting(false)
                if (r === undefined && !problem()) props.onDeleted()
              })
            }}
          />
        </Show>
      </Show>
    </section>
  )
}
