import {
  DECISION_MODEL_DEFAULT,
  DECISION_MODEL_MAX,
  type DecisionChoice,
  type DecisionTestResult,
  type MessageKey,
  type PickReason,
} from "@robot/shared"
import { createResource, createSignal, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, Segmented, Switch } from "../ui/controls.tsx"
import styles from "./settings.module.css"

/** The reasons that all mean "the model was not sure enough" (spec 013, "unsure answer"). */
const UNSURE: readonly PickReason[] = ["no_single_member", "below_threshold", "not_most_likely"]
const UNREADABLE: readonly PickReason[] = ["unknown_option", "probability_not_number"]

const reasonKey = (reason: PickReason): MessageKey => {
  if (UNSURE.includes(reason)) return "decision.test.reason.unsure"
  if (UNREADABLE.includes(reason)) return "decision.test.reason.unreadable"
  return `decision.test.reason.${reason}` as MessageKey
}

const Row = (props: {
  label: string
  hint?: string
  testId?: string
  children?: import("solid-js").JSX.Element
}) => (
  <div class={styles.row} data-testid={props.testId}>
    <div>
      <div class={styles.label}>{props.label}</div>
      <Show when={props.hint}>
        <div class={styles.hint}>{props.hint}</div>
      </Show>
    </div>
    {props.children}
  </div>
)

/**
 * Settings, Decision model (spec 013): off, or Jev through OpenRouter with a key and a model
 * name, and a Test that sends one real request. The page learns whether a key is saved and never
 * shows it.
 */
export const DecisionSection = () => {
  const app = useApp()
  const { t } = app
  const [status, { refetch }] = createResource(() => call("decision.status"))
  const [error, setError] = createSignal<ErrorText>()
  const [testing, setTesting] = createSignal(false)
  const [result, setResult] = createSignal<DecisionTestResult>()
  const [modelDraft, setModelDraft] = createSignal<string>()
  let keyField: HTMLInputElement | undefined

  const keySaved = () => status()?.keys.openrouter === true
  const modelShown = () => modelDraft() ?? app.settings.decisionModelName
  /** True when the choice has its key and its model name, so a check can be asked (spec 013). */
  const setUp = () =>
    app.settings.decisionModel === "openrouter" &&
    keySaved() &&
    app.settings.decisionModelName.trim() !== ""

  const guard = async (run: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    }
  }
  const saveKey = () => {
    const value = keyField?.value ?? ""
    if (keyField) keyField.value = ""
    if (!value.trim()) return
    setResult(undefined)
    void guard(async () => {
      await call("decision.keys", { openrouter: value })
      await refetch()
    })
  }
  const removeKey = () => {
    setResult(undefined)
    void guard(async () => {
      await call("decision.keys", { openrouter: null })
      await refetch()
    })
  }
  const commitModel = () => {
    const value = (modelDraft() ?? "").trim()
    if (modelDraft() !== undefined && value !== app.settings.decisionModelName) {
      setResult(undefined)
      app.update({ decisionModelName: value })
    }
    setModelDraft(undefined)
  }
  const test = () => {
    setResult(undefined)
    setTesting(true)
    void guard(async () => setResult(await call("decision.test"))).finally(() => setTesting(false))
  }

  const outcome = () => {
    const r = result()
    if (!r) return undefined
    return r.ok
      ? t("decision.test.ok", {
          member: r.member,
          percent: Math.round(r.probability * 100),
          ms: r.ms,
        })
      : t(reasonKey(r.reason), { code: r.code ?? 0 })
  }

  return (
    <>
      <p class={styles.muted}>{t("decision.hint")}</p>
      <Row label={t("decision.choice")} testId="setting-decision-choice-row">
        <Segmented
          label={t("decision.choice")}
          testId="setting-decision-choice"
          value={app.settings.decisionModel}
          onChange={(decisionModel: DecisionChoice) => {
            setResult(undefined)
            app.update({ decisionModel })
          }}
          options={[
            { value: "off", label: t("decision.choice.off") },
            { value: "openrouter", label: t("decision.choice.openrouter") },
          ]}
        />
      </Row>
      <Show
        when={app.settings.decisionModel === "openrouter"}
        fallback={<p class={styles.note}>{t("decision.off.hint")}</p>}
      >
        <Row
          label={t("decision.key")}
          hint={keySaved() ? t("decision.key.saved") : t("decision.key.none")}
          testId="setting-decision-key-row"
        >
          <form
            class={styles.actions}
            onSubmit={(e) => {
              e.preventDefault()
              saveKey()
            }}
          >
            <input
              ref={keyField}
              class={styles.input}
              type="password"
              autocomplete="off"
              spellcheck={false}
              maxLength={500}
              aria-label={t("decision.key.field")}
              placeholder={t("decision.key.field")}
              data-testid="setting-decision-key"
            />
            <Button type="submit" data-testid="setting-decision-key-save">
              {t("decision.key.save")}
            </Button>
            <Show when={keySaved()}>
              <Button onClick={removeKey} data-testid="setting-decision-key-remove">
                {t("decision.key.remove")}
              </Button>
            </Show>
          </form>
        </Row>
        <Row
          label={t("decision.model")}
          hint={t("decision.model.hint", { model: DECISION_MODEL_DEFAULT })}
          testId="setting-decision-model-row"
        >
          <input
            class={styles.input}
            type="text"
            spellcheck={false}
            autocomplete="off"
            maxLength={DECISION_MODEL_MAX}
            value={modelShown()}
            aria-label={t("decision.model")}
            onInput={(e) => setModelDraft(e.currentTarget.value)}
            onBlur={commitModel}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            data-testid="setting-decision-model"
          />
        </Row>
        <Row
          label={t("decision.test")}
          hint={t("decision.test.hint")}
          testId="setting-decision-test-row"
        >
          <Button onClick={test} disabled={testing()} data-testid="setting-decision-test">
            {testing() ? t("decision.test.running") : t("decision.test.run")}
          </Button>
        </Row>
        <Show when={outcome()}>
          {(text) => (
            <p
              class={result()?.ok ? styles.note : styles.error}
              role="status"
              data-testid="setting-decision-result"
              data-ok={result()?.ok === true}
              data-reason={result() && !result()?.ok ? (result() as { reason: string }).reason : ""}
            >
              {text()}
            </p>
          )}
        </Show>
        <p class={styles.note} data-testid="setting-decision-sends">
          {t("decision.sends")}
        </p>
      </Show>
      {/*
        The switch "Permission checks" (spec 013): agents at the level "Ask when unsure" ask this
        model before a checked step. It is off by default and cannot go on until the choice above
        has its key and its model name. It can always go off.
      */}
      <Row
        label={t("decision.checks")}
        hint={t("decision.checks.hint")}
        testId="setting-permission-checks-row"
      >
        <Switch
          label={t("decision.checks")}
          testId="setting-permission-checks"
          checked={app.settings.permissionChecks}
          disabled={!app.settings.permissionChecks && !setUp()}
          onChange={(permissionChecks) => void guard(() => app.update({ permissionChecks }))}
        />
      </Row>
      <Show when={!app.settings.permissionChecks && !setUp()}>
        <p class={styles.note} data-testid="setting-permission-checks-needs">
          {t("decision.checks.needsSetup")}
        </p>
      </Show>
      <Show when={error()}>
        {(e) => (
          <p class={styles.error} role="alert" data-testid="setting-decision-error">
            {t(e().key, e().params)}
          </p>
        )}
      </Show>
    </>
  )
}
