import {
  ACTION_KINDS,
  type ActionKind,
  type ActionLogEntry,
  type ActionResult,
  type ActionRule,
  type Agent,
  type MessageKey,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { outsideSourceText } from "../lib/outside.ts"
import { call } from "../lib/rpc.ts"
import { sensitiveLabelText } from "../lib/sensitive.ts"
import { useApp } from "../state/app.tsx"
import { showRules } from "../state/rulesLink.ts"
import { setOpenTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { Segmented } from "../ui/controls.tsx"
import styles from "./settings.module.css"

type ResultFilter = ActionResult | "all"
const RESULTS: readonly ResultFilter[] = ["all", "ran", "failed", "refused", "stopped"]

/** The value of a filter that lets every entry pass. */
const ANY = ""

/**
 * The action log of spec 007, newest first, with filters for the agent, the result and the step
 * kind, and a search of the target. Each entry says whether the turn held outside content and
 * names its first source. A row that a rule decided opens that rule; any other row opens the task
 * of its step.
 */
export const ActionLogSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [result, setResult] = createSignal<ResultFilter>("all")
  const [agent, setAgent] = createSignal(ANY)
  const [kind, setKind] = createSignal(ANY)
  const [search, setSearch] = createSignal("")
  const [entries, { refetch }] = createResource(
    () => ({ result: result(), agent: agent(), kind: kind(), search: search().trim() }),
    (f) =>
      call("actionLog.list", {
        ...(f.result === "all" ? {} : { result: f.result }),
        ...(f.agent === ANY ? {} : { agentId: f.agent }),
        ...(f.kind === ANY ? {} : { kind: f.kind as ActionKind }),
        ...(f.search ? { search: f.search } : {}),
      }),
  )
  const [agents, { refetch: refetchAgents }] = createResource(
    () => ui.localServer()?.id,
    async (serverId) => [
      ...(await call("agents.list", { serverId, archived: false })),
      ...(await call("agents.list", { serverId, archived: true })),
    ],
    { initialValue: [] as readonly Agent[] },
  )
  onCleanup(window.robot.on("actionLog.changed", () => void refetch()))
  onCleanup(window.robot.on("rules.changed", () => void refetch()))
  onCleanup(window.robot.on("agents.changed", () => void refetchAgents()))
  /** Shows the task of a step on the Tasks page; the settings close. */
  const openTask = (taskId: string) => {
    setOpenTarget({ kind: "task", id: taskId })
    ui.closeSettings()
    ui.selectPage("tasks")
  }
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
      {/*
        The row opens the rule that decided it (above). A row that no rule decided, and a row whose
        rule is gone, opens the task of its step. A row of a rule has a small link for the task
        too, so that both ways stay (spec 007).
      */}
      <Show when={e.taskId}>
        {(taskId) => (
          <button
            type="button"
            class={e.rule && !e.rule.deleted ? styles.taskLink : styles.rowLink}
            data-testid="action-log-task-open"
            onClick={() => openTask(taskId())}
          >
            {t("permissions.log.openTask")}
          </button>
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
          aria-label={t("permissions.log.filterAgent")}
          data-testid="action-log-agent"
          value={agent()}
          onChange={(e) => setAgent(e.currentTarget.value)}
        >
          <option value={ANY} selected={agent() === ANY}>
            {t("permissions.log.anyAgent")}
          </option>
          <For each={agents()}>
            {(a) => (
              <option value={a.id} selected={agent() === a.id}>
                {a.name}
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
              result() !== "all" || agent() !== ANY || kind() !== ANY || search().trim()
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
