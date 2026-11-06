import {
  ACTION_KINDS,
  type ActionKind,
  type ActionLogEntry,
  type ActionResult,
  type ActionRule,
  type MessageKey,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../lib/format.ts"
import { outsideSourceText } from "../lib/outside.ts"
import { call } from "../lib/rpc.ts"
import { sensitiveLabelText } from "../lib/sensitive.ts"
import { useApp } from "../state/app.tsx"
import { showRules } from "../state/rulesLink.ts"
import { Segmented } from "../ui/controls.tsx"
import { useWorkflowList } from "../workflows/names.ts"
import styles from "./settings.module.css"

type ResultFilter = ActionResult | "all"
const RESULTS: readonly ResultFilter[] = ["all", "ran", "failed", "refused", "stopped"]

/** The value of a filter that lets every entry pass. */
const ANY = ""

/**
 * The action log of spec 007, newest first, with filters for the workflow, the result and the step
 * kind, and a search of the target. Each entry says whether the turn held outside content and
 * names its first source. A row that a rule decided opens that rule; any other row has no link.
 */
export const ActionLogSection = () => {
  const app = useApp()
  const { t } = app
  const workflows = useWorkflowList()
  const [result, setResult] = createSignal<ResultFilter>("all")
  const [workflow, setWorkflow] = createSignal(ANY)
  const [kind, setKind] = createSignal(ANY)
  const [search, setSearch] = createSignal("")
  const [entries, { refetch }] = createResource(
    () => ({ result: result(), workflow: workflow(), kind: kind(), search: search().trim() }),
    (f) =>
      call("actionLog.list", {
        ...(f.result === "all" ? {} : { result: f.result }),
        ...(f.workflow === ANY ? {} : { workflowId: f.workflow }),
        ...(f.kind === ANY ? {} : { kind: f.kind as ActionKind }),
        ...(f.search ? { search: f.search } : {}),
      }),
  )
  onCleanup(window.robot.on("actionLog.changed", () => void refetch()))
  onCleanup(window.robot.on("rules.changed", () => void refetch()))
  /** The match text of a rule as the log shows it: the second part, when the rule has one. */
  const ruleText = (rule: ActionRule) =>
    rule.kind === "connection"
      ? `${rule.text} · ${rule.detail ?? t("rules.anyTool")}`
      : rule.kind === "secret"
        ? `${rule.text} · ${rule.detail ?? t("rules.anyMethod")}`
        : rule.text

  const row = (e: ActionLogEntry) => (
    <li
      class={styles.logRow}
      data-testid="action-log-entry"
      data-outside={e.outside !== null}
      data-sensitive={e.sensitive !== null}
    >
      <div class={styles.logHead}>
        <span class={styles.label}>
          {t(`permissions.log.kind.${e.kind}` as MessageKey)}
          <Show when={e.access}>
            {(access) => (
              <span data-testid="action-log-access" data-access={access()}>
                {" · "}
                {t(`permissions.log.access.${access()}` as MessageKey)}
              </span>
            )}
          </Show>
        </span>
        <span class={styles.logTag} data-result={e.result}>
          {t(`permissions.log.result.${e.result}` as MessageKey)}
        </span>
      </div>
      <div class={styles.logTarget}>{e.target}</div>
      <div class={styles.hint}>
        {[
          formatDateTime(app.locale(), e.at),
          e.workflowName || t("permissions.log.deletedWorkflow"),
          t(`permissions.log.decided.${e.decidedBy}` as MessageKey),
        ].join(" · ")}
      </div>
      <div class={styles.hint} data-testid="action-log-outside">
        {e.outside
          ? t("permissions.log.outside", { source: outsideSourceText(t, e.outside) })
          : t("permissions.log.noOutside")}
      </div>
      {/*
        The check of "Ask when unsure" (spec 007): when it was sure, the step ran and the check
        decided, with its probability. When it was not, it sent the step to the user, with its
        reason. A step that did not go to the check shows nothing here.
      */}
      <Show when={e.check}>
        {(check) => (
          <div class={styles.hint} data-testid="action-log-check" data-allowed={check().allowed}>
            {check().allowed
              ? t("permissions.log.check.allowed", {
                  percent: Math.round((check().probability ?? 0) * 100),
                })
              : t("permissions.log.check.sent", {
                  reason: t(
                    `permissions.log.check.reason.${check().reason ?? "unsure"}` as MessageKey,
                  ),
                })}
          </div>
        )}
      </Show>
      <div class={styles.hint} data-testid="action-log-sensitive">
        {e.sensitive
          ? t("permissions.log.sensitive", { label: sensitiveLabelText(t, e.sensitive) })
          : t("permissions.log.noSensitive")}
      </div>
      {/* The rule that decided the step. A rule that was deleted later shows its text. */}
      <Show when={e.rule}>
        {(rule) => (
          <div data-testid="action-log-rule" data-deleted={rule().deleted}>
            <Show
              when={!rule().deleted}
              fallback={
                <span class={styles.ruleDeleted}>
                  {t("permissions.log.rule", { text: ruleText(rule()) })} ·{" "}
                  <strong data-testid="action-log-rule-deleted">
                    {t("permissions.log.ruleDeleted")}
                  </strong>
                </span>
              }
            >
              <button
                type="button"
                class={styles.rowLink}
                data-testid="action-log-rule-open"
                aria-label={t("permissions.log.ruleOpen", { text: ruleText(rule()) })}
                onClick={() => {
                  showRules({ ruleId: rule().id })
                }}
              >
                {t("permissions.log.rule", { text: ruleText(rule()) })}
              </button>
            </Show>
          </div>
        )}
      </Show>
    </li>
  )

  return (
    <>
      <div class={`${styles.row} ${styles.rowWrap}`}>
        <div class={styles.grow}>
          <div class={styles.label}>{t("permissions.log.title")}</div>
          <div class={`${styles.hint} ${styles.words}`}>{t("permissions.log.hint")}</div>
        </div>
        <div class={styles.scrollRow}>
          <Segmented
            label={t("permissions.log.filterResult")}
            testId="action-log-result"
            value={result()}
            onChange={setResult}
            options={RESULTS.map((r) => ({
              value: r,
              label:
                r === "all"
                  ? t("permissions.log.allResults")
                  : t(`permissions.log.result.${r}` as MessageKey),
            }))}
          />
        </div>
      </div>
      <div class={`${styles.row} ${styles.rowWrap}`}>
        <select
          class={styles.select}
          aria-label={t("permissions.log.filterWorkflow")}
          data-testid="action-log-workflow"
          value={workflow()}
          onChange={(e) => setWorkflow(e.currentTarget.value)}
        >
          <option value={ANY} selected={workflow() === ANY}>
            {t("permissions.log.anyWorkflow")}
          </option>
          <For each={workflows.list()}>
            {(w) => (
              <option value={w.id} selected={workflow() === w.id}>
                {w.name}
              </option>
            )}
          </For>
        </select>
        <select
          class={styles.select}
          aria-label={t("permissions.log.filterKind")}
          data-testid="action-log-kind"
          value={kind()}
          onChange={(e) => setKind(e.currentTarget.value)}
        >
          <option value={ANY}>{t("permissions.log.anyKind")}</option>
          <For each={ACTION_KINDS}>
            {(k) => <option value={k}>{t(`permissions.log.kind.${k}` as MessageKey)}</option>}
          </For>
        </select>
        <input
          type="search"
          class={styles.input}
          aria-label={t("permissions.log.search")}
          placeholder={t("permissions.log.search")}
          data-testid="action-log-search"
          value={search()}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>
      <Show
        when={(entries.latest ?? []).length > 0}
        fallback={
          <p class={styles.muted} data-testid="action-log-empty">
            {t(
              result() !== "all" || workflow() !== ANY || kind() !== ANY || search().trim()
                ? "permissions.log.searchEmpty"
                : "permissions.log.empty",
            )}
          </p>
        }
      >
        <ul class={styles.log} data-testid="action-log">
          <For each={entries.latest ?? []}>{row}</For>
        </ul>
      </Show>
    </>
  )
}
