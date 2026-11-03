import type { ActionLogEntry, ActionResult, ActionRule, MessageKey } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { outsideSourceText } from "../lib/outside.ts"
import { call } from "../lib/rpc.ts"
import { sensitiveLabelText } from "../lib/sensitive.ts"
import { useApp } from "../state/app.tsx"
import { showRules } from "../state/rulesLink.ts"
import { Segmented } from "../ui/controls.tsx"
import styles from "./settings.module.css"

type ResultFilter = ActionResult | "all"
const RESULTS: readonly ResultFilter[] = ["all", "ran", "failed", "refused", "stopped"]

/**
 * The action log of spec 007, newest first, with a filter by result. Each entry says whether the
 * turn held outside content and names its first source.
 */
export const ActionLogSection = () => {
  const app = useApp()
  const { t } = app
  const [result, setResult] = createSignal<ResultFilter>("all")
  const [entries, { refetch }] = createResource(result, (r) =>
    call("actionLog.list", r === "all" ? {} : { result: r }),
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
          e.agentName || t("permissions.log.deletedAgent"),
          t(`permissions.log.decided.${e.decidedBy}` as MessageKey),
        ].join(" · ")}
      </div>
      <div class={styles.hint} data-testid="action-log-outside">
        {e.outside
          ? t("permissions.log.outside", { source: outsideSourceText(t, e.outside) })
          : t("permissions.log.noOutside")}
      </div>
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
                class={styles.ruleLink}
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
      <div class={styles.row}>
        <div>
          <div class={styles.label}>{t("permissions.log.title")}</div>
          <div class={`${styles.hint} ${styles.words}`}>{t("permissions.log.hint")}</div>
        </div>
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
      <Show
        when={(entries.latest ?? []).length > 0}
        fallback={<p class={styles.muted}>{t("permissions.log.empty")}</p>}
      >
        <ul class={styles.log} data-testid="action-log">
          <For each={entries.latest ?? []}>{row}</For>
        </ul>
      </Show>
    </>
  )
}
