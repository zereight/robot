import type { MessageKey, PermissionRule, RuleDecision, RuleInput, RuleKind } from "@robot/shared"
import { RULE_KINDS, RULE_TEXT_MAX, RULES_MAX, SECRET_METHODS } from "@robot/shared"
import {
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { clearRulesTarget, rulesTarget } from "../state/rulesLink.ts"
import { Button, Segmented } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { useWorkflowList } from "../workflows/names.ts"
import styles from "./settings.module.css"

/** The value of the workflow filter: every rule, the rules for all workflows, or one workflow. */
const EVERY = ""
const ALL_WORKFLOWS = "*"

type DecisionFilter = RuleDecision | "all"
const DECISIONS: readonly DecisionFilter[] = ["all", "allow", "deny"]

/** What the form holds while the user types. */
interface Draft {
  workflow: string
  kind: RuleKind
  text: string
  detail: string
  anyDetail: boolean
  decision: RuleDecision
}

/**
 * Settings, Permissions: the permission rules of spec 007. Rules come newest first. The user can
 * filter by workflow and by decision, add a rule, edit a rule and delete a rule. A rule that the app
 * cannot read says so, and the user can delete it.
 */
export const RulesSection = () => {
  const app = useApp()
  const { t } = app
  const workflows = useWorkflowList()
  const [workflowFilter, setWorkflowFilter] = createSignal(EVERY)
  const [decisionFilter, setDecisionFilter] = createSignal<DecisionFilter>("all")
  const [focused, setFocused] = createSignal<string>()
  const [rules, { refetch }] = createResource(
    () => ({ workflow: workflowFilter(), decision: decisionFilter() }),
    (filter) =>
      call("rules.list", {
        ...(filter.workflow === EVERY
          ? {}
          : { workflowId: filter.workflow === ALL_WORKFLOWS ? null : filter.workflow }),
        ...(filter.decision === "all" ? {} : { decision: filter.decision }),
      }),
  )
  const [count, { refetch: refetchCount }] = createResource(
    async () => (await call("rules.list", {})).length,
  )
  onCleanup(
    window.robot.on("rules.changed", () => {
      void refetch()
      void refetchCount()
    }),
  )
  onCleanup(
    window.robot.on("workflows.changed", () => {
      void refetch()
      void refetchCount()
    }),
  )

  // A request from a row of the action log (spec 007).
  createEffect(
    on(rulesTarget, (target) => {
      if (!target) return
      clearRulesTarget()
      setDecisionFilter("all")
      setWorkflowFilter(target.workflowId ?? EVERY)
      setFocused(target.ruleId)
      if (target.ruleId)
        queueMicrotask(() =>
          document
            .querySelector(`[data-rule-id="${target.ruleId}"]`)
            ?.scrollIntoView({ block: "center" }),
        )
    }),
  )
  // Once the list is drawn, the rule of a request is brought into view.
  createEffect(() => {
    const id = focused()
    if (!id || !rules.latest) return
    queueMicrotask(() =>
      document.querySelector(`[data-rule-id="${id}"]`)?.scrollIntoView({ block: "center" }),
    )
  })

  const [editing, setEditing] = createSignal<{ rule?: PermissionRule; draft: Draft }>()
  const [error, setError] = createSignal<ErrorText>()

  const blank = (): Draft => ({
    workflow:
      workflowFilter() === EVERY ? (workflows.list()[0]?.id ?? ALL_WORKFLOWS) : workflowFilter(),
    kind: "shell",
    text: "",
    detail: "",
    anyDetail: true,
    decision: "allow",
  })
  const draftOf = (rule: PermissionRule): Draft => ({
    workflow: rule.workflowId ?? ALL_WORKFLOWS,
    kind: rule.kind ?? "shell",
    text: rule.text,
    detail: rule.detail ?? "",
    anyDetail: rule.detail === null,
    decision: rule.decision ?? "allow",
  })
  const inputOf = (draft: Draft): RuleInput => ({
    workflowId: draft.workflow === ALL_WORKFLOWS ? null : draft.workflow,
    kind: draft.kind,
    text: draft.text,
    ...(draft.kind === "connection" || draft.kind === "secret"
      ? { detail: draft.anyDetail ? null : draft.detail }
      : {}),
    decision: draft.decision,
  })

  const save = async () => {
    const current = editing()
    if (!current) return
    setError(undefined)
    try {
      const input = inputOf(current.draft)
      const saved = current.rule
        ? await call("rules.update", { id: current.rule.id, rule: input })
        : await call("rules.add", input)
      setEditing(undefined)
      setFocused(saved.id)
      await refetch()
    } catch (e) {
      setError(describeError(e))
    }
  }
  const remove = async (rule: PermissionRule) => {
    setError(undefined)
    try {
      await call("rules.delete", { id: rule.id })
    } catch (e) {
      setError(describeError(e))
    }
  }

  /** The match text of a rule as a row shows it. */
  const matchText = (rule: PermissionRule) => {
    if (rule.kind === "connection") return `${rule.text} · ${rule.detail ?? t("rules.anyTool")}`
    if (rule.kind === "secret") return `${rule.text} · ${rule.detail ?? t("rules.anyMethod")}`
    return rule.text
  }

  const row = (rule: PermissionRule) => {
    const workflow = () => workflows.byId(rule.workflowId)
    return (
      <li
        class={styles.logRow}
        data-testid="rule-row"
        data-rule-id={rule.id}
        data-decision={rule.decision ?? "unreadable"}
        data-kind={rule.kind ?? ""}
        data-focused={focused() === rule.id ? "true" : undefined}
      >
        <div class={styles.logHead}>
          <span class={styles.secretAgent} data-testid="rule-workflow">
            <Show when={rule.workflowId !== null} fallback={<span>{t("rules.allWorkflows")}</span>}>
              <span>{workflow()?.name ?? t("secrets.unknownWorkflow")}</span>
            </Show>
          </span>
          <Show
            when={rule.readable && rule.decision}
            fallback={
              <span class={styles.logTag} data-result="failed" data-testid="rule-unreadable">
                {t("rules.unreadable")}
              </span>
            }
          >
            {(decision) => (
              <span class={styles.logTag} data-decision={decision()} data-testid="rule-tag">
                {t(`rules.decision.${decision()}` as MessageKey)}
              </span>
            )}
          </Show>
        </div>
        <div class={styles.logTarget} data-testid="rule-text">
          {matchText(rule)}
        </div>
        <div class={styles.hint}>
          {[
            rule.kind ? t(`rules.kind.${rule.kind}` as MessageKey) : "—",
            formatDateTime(app.locale(), rule.createdAt),
          ].join(" · ")}
        </div>
        <Show when={!rule.readable}>
          <div class={styles.hint} data-testid="rule-unreadable-hint">
            {t("rules.unreadable.hint")}
          </div>
        </Show>
        <div class={styles.actions}>
          <Show when={rule.readable}>
            <Button
              onClick={() => {
                setError(undefined)
                setEditing({ rule, draft: draftOf(rule) })
              }}
              data-testid="rule-edit"
            >
              {t("rules.edit")}
            </Button>
          </Show>
          <Button variant="danger" onClick={() => void remove(rule)} data-testid="rule-delete">
            {t("rules.delete")}
          </Button>
        </div>
      </li>
    )
  }

  const patch = (change: Partial<Draft>) => {
    const current = editing()
    if (current) setEditing({ ...current, draft: { ...current.draft, ...change } })
  }
  /** A name above a control. The control carries the same name for assistive technology. */
  const field = (label: string, body: JSX.Element) => (
    <div class={styles.formField}>
      <span class={styles.label} aria-hidden="true">
        {label}
      </span>
      {body}
    </div>
  )

  return (
    <div data-testid="rules">
      <div class={`${styles.row} ${styles.rowWrap}`}>
        <div class={styles.grow}>
          <div class={styles.label}>{t("rules.title")}</div>
          <div class={`${styles.hint} ${styles.words}`}>{t("rules.hint")}</div>
        </div>
        <Button
          variant="primary"
          class={styles.noWrap}
          disabled={(count() ?? 0) >= RULES_MAX}
          onClick={() => {
            setError(undefined)
            setEditing({ draft: blank() })
          }}
          data-testid="rule-add"
        >
          {t("rules.add")}
        </Button>
      </div>
      <div class={`${styles.row} ${styles.rowWrap}`}>
        <select
          class={styles.select}
          aria-label={t("rules.filterWorkflow")}
          data-testid="rules-workflow"
          value={workflowFilter()}
          onChange={(e) => setWorkflowFilter(e.currentTarget.value)}
        >
          <option value={EVERY} selected={workflowFilter() === EVERY}>
            {t("rules.anyWorkflow")}
          </option>
          <option value={ALL_WORKFLOWS} selected={workflowFilter() === ALL_WORKFLOWS}>
            {t("rules.allWorkflows")}
          </option>
          {/* The workflows load after the page opens, so each option says if it is the chosen one. */}
          <For each={workflows.list()}>
            {(w) => (
              <option value={w.id} selected={workflowFilter() === w.id}>
                {w.name}
              </option>
            )}
          </For>
        </select>
        <Segmented
          label={t("rules.filterDecision")}
          testId="rules-decision"
          value={decisionFilter()}
          onChange={setDecisionFilter}
          options={DECISIONS.map((d) => ({
            value: d,
            label: d === "all" ? t("rules.anyDecision") : t(`rules.decision.${d}` as MessageKey),
          }))}
        />
      </div>
      <Show when={!editing() && error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="rules-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
      <Show
        when={(rules.latest ?? []).length > 0}
        fallback={
          <p class={styles.muted} data-testid="rules-empty">
            {t("rules.empty")}
          </p>
        }
      >
        <ul class={styles.log} data-testid="rules-list">
          <For each={rules.latest ?? []}>{row}</For>
        </ul>
      </Show>
      <Presence when={editing()}>
        {(current) => (
          <Dialog
            label={current.rule ? t("rules.edit.title") : t("rules.add.title")}
            onClose={() => setEditing(undefined)}
            testId="rule-dialog"
          >
            <form
              class={styles.ruleForm}
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <h2 class={styles.label}>
                {current.rule ? t("rules.edit.title") : t("rules.add.title")}
              </h2>
              {field(
                t("rules.field.workflow"),
                <select
                  class={styles.select}
                  aria-label={t("rules.field.workflow")}
                  data-testid="rule-form-workflow"
                  value={current.draft.workflow}
                  onChange={(e) => patch({ workflow: e.currentTarget.value })}
                >
                  <option value={ALL_WORKFLOWS}>{t("rules.allWorkflows")}</option>
                  <For each={workflows.list()}>{(w) => <option value={w.id}>{w.name}</option>}</For>
                </select>,
              )}
              {field(
                t("rules.field.kind"),
                <select
                  class={styles.select}
                  aria-label={t("rules.field.kind")}
                  data-testid="rule-form-kind"
                  value={current.draft.kind}
                  onChange={(e) =>
                    patch({
                      kind: e.currentTarget.value as RuleKind,
                      detail: "",
                      anyDetail: true,
                    })
                  }
                >
                  <For each={RULE_KINDS}>
                    {(k) => <option value={k}>{t(`rules.kind.${k}` as MessageKey)}</option>}
                  </For>
                </select>,
              )}
              {field(
                t(`rules.match.${current.draft.kind}` as MessageKey),
                <input
                  class={styles.input}
                  aria-label={t(`rules.match.${current.draft.kind}` as MessageKey)}
                  value={current.draft.text}
                  maxLength={RULE_TEXT_MAX}
                  spellcheck={false}
                  autocomplete="off"
                  data-testid="rule-form-text"
                  onInput={(e) => patch({ text: e.currentTarget.value })}
                />,
              )}
              <Show when={current.draft.kind === "connection"}>
                {field(
                  t("rules.field.tool"),
                  <span class={styles.formInline}>
                    <label class={styles.check}>
                      <input
                        type="checkbox"
                        checked={current.draft.anyDetail}
                        data-testid="rule-form-any"
                        onChange={(e) => patch({ anyDetail: e.currentTarget.checked })}
                      />
                      {t("rules.anyTool")}
                    </label>
                    <Show when={!current.draft.anyDetail}>
                      <input
                        class={styles.input}
                        aria-label={t("rules.field.tool")}
                        value={current.draft.detail}
                        maxLength={RULE_TEXT_MAX}
                        spellcheck={false}
                        data-testid="rule-form-detail"
                        onInput={(e) => patch({ detail: e.currentTarget.value })}
                      />
                    </Show>
                  </span>,
                )}
              </Show>
              <Show when={current.draft.kind === "secret"}>
                {field(
                  t("rules.field.method"),
                  <select
                    class={styles.select}
                    aria-label={t("rules.field.method")}
                    data-testid="rule-form-method"
                    value={current.draft.anyDetail ? "" : current.draft.detail}
                    onChange={(e) =>
                      patch({
                        anyDetail: e.currentTarget.value === "",
                        detail: e.currentTarget.value,
                      })
                    }
                  >
                    <option value="">{t("rules.anyMethod")}</option>
                    <For each={SECRET_METHODS}>{(m) => <option value={m}>{m}</option>}</For>
                  </select>,
                )}
              </Show>
              <div class={styles.formField}>
                <span class={styles.label}>{t("rules.field.decision")}</span>
                <Segmented
                  label={t("rules.field.decision")}
                  testId="rule-form-decision"
                  value={current.draft.decision}
                  onChange={(decision) => patch({ decision })}
                  options={(["allow", "deny"] as const).map((d) => ({
                    value: d,
                    label: t(`rules.decision.${d}` as MessageKey),
                  }))}
                />
              </div>
              <Show when={error()}>
                {(err) => (
                  <div class={styles.error} role="alert" data-testid="rule-form-error">
                    {t(err().key, err().params)}
                  </div>
                )}
              </Show>
              <div class={styles.actions}>
                <Button onClick={() => setEditing(undefined)}>{t("rules.cancel")}</Button>
                <Button type="submit" variant="primary" data-testid="rule-form-save">
                  {t("rules.save")}
                </Button>
              </div>
            </form>
          </Dialog>
        )}
      </Presence>
    </div>
  )
}
