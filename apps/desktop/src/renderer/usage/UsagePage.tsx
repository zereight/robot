import {
  type MessageKey,
  type OrgUsageRow,
  USAGE_RANGES,
  type UsageRange,
  usageByAgent,
  usageByDay,
  usageTotal,
} from "@robot/shared"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { formatSeconds } from "../lib/seconds.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Segmented } from "../ui/controls.tsx"
import styles from "./usage.module.css"

export const UsagePage = () => {
  const { t, locale } = useApp()
  const ui = useUi()
  const [days, setDays] = createSignal<UsageRange>(7)
  // Opening the page loads the numbers again, so they match the chats.
  const [rows] = createResource(
    () => {
      const serverId = ui.server()?.id
      return serverId ? { serverId, days: days() } : undefined
    },
    (key) => call("usage.summary", key),
    { initialValue: [] },
  )
  // The organizations with a daily token limit and the tokens used today (spec 006, 030). They do
  // not depend on the range. A task of a member changes them, so they are read again.
  const [limits, { refetch: refetchLimits }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("usage.organizations", { serverId }).catch((): readonly OrgUsageRow[] => []),
    { initialValue: [] as readonly OrgUsageRow[] },
  )
  onCleanup(window.robot.on("organizations.changed", () => void refetchLimits()))
  onCleanup(window.robot.on("tasks.changed", () => void refetchLimits()))
  const number = createMemo(() => new Intl.NumberFormat(locale()))
  const dayLabel = (day: string) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number]
    return new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(y, m - 1, d))
  }
  const total = () => usageTotal(rows())

  // The median "First reply" is a time of one agent on one day (spec 005), so only the day tables show it.
  const firstReply = (ms: number | null) =>
    ms === null ? t("time.unknown") : t("time.seconds", { value: formatSeconds(ms, locale()) })

  const Head = (props: { day?: boolean }) => (
    <tr>
      <th scope="col">{t("usage.col.agent")}</th>
      <th scope="col" class={styles.num}>
        {t("usage.col.replies")}
      </th>
      <th scope="col" class={styles.num}>
        {t("usage.col.input")}
      </th>
      <th scope="col" class={styles.num}>
        {t("usage.col.output")}
      </th>
      <Show when={props.day}>
        <th scope="col" class={styles.num}>
          {t("usage.col.firstReply")}
        </th>
      </Show>
    </tr>
  )

  return (
    <div class={`${shell.page} ${styles.usage}`} data-testid="usage-page">
      <div class={styles.top}>
        <Segmented
          label={t("usage.range")}
          testId="usage-range"
          value={String(days())}
          onChange={(value) => setDays(Number(value) as UsageRange)}
          options={USAGE_RANGES.map((n) => ({
            value: String(n),
            label: t(`usage.range.${n}` as MessageKey),
          }))}
        />
      </div>

      <Show
        when={rows().length > 0}
        fallback={
          <p class={styles.muted} data-testid="usage-empty">
            {t("usage.empty")}
          </p>
        }
      >
        <dl class={styles.totals} data-testid="usage-total">
          <div>
            <dt>{t("usage.col.replies")}</dt>
            <dd data-testid="usage-total-replies">{number().format(total().replies)}</dd>
          </div>
          <div>
            <dt>{t("usage.col.input")}</dt>
            <dd data-testid="usage-total-input">{number().format(total().inputTokens)}</dd>
          </div>
          <div>
            <dt>{t("usage.col.output")}</dt>
            <dd data-testid="usage-total-output">{number().format(total().outputTokens)}</dd>
          </div>
        </dl>

        <h2>{t("usage.byAgent")}</h2>
        <table class={styles.table} data-testid="usage-by-agent">
          <thead>
            <Head />
          </thead>
          <tbody>
            <For each={usageByAgent(rows())}>
              {(a) => (
                <tr data-testid="usage-agent-row">
                  <th scope="row">{a.agentName}</th>
                  <td class={styles.num}>{number().format(a.replies)}</td>
                  <td class={styles.num}>{number().format(a.inputTokens)}</td>
                  <td class={styles.num}>{number().format(a.outputTokens)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>

        <h2>{t("usage.byDay")}</h2>
        <For each={usageByDay(rows())}>
          {(day) => (
            <table class={styles.table} data-testid="usage-day">
              <caption>{dayLabel(day.day)}</caption>
              <thead>
                <Head day />
              </thead>
              <tbody>
                <For each={day.agents}>
                  {(a) => (
                    <tr data-testid="usage-day-row">
                      <th scope="row">{a.agentName}</th>
                      <td class={styles.num}>{number().format(a.replies)}</td>
                      <td class={styles.num}>{number().format(a.inputTokens)}</td>
                      <td class={styles.num}>{number().format(a.outputTokens)}</td>
                      <td
                        class={styles.num}
                        data-testid="usage-first-reply"
                        data-ms={a.firstReplyMs ?? ""}
                      >
                        {firstReply(a.firstReplyMs)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          )}
        </For>
        <p class={styles.muted}>{t("usage.note")}</p>
      </Show>

      <Show when={limits().length > 0}>
        <h2>{t("usage.orgs")}</h2>
        <table class={styles.table} data-testid="usage-orgs">
          <thead>
            <tr>
              <th scope="col">{t("usage.col.org")}</th>
              <th scope="col" class={styles.num}>
                {t("usage.col.usedToday")}
              </th>
              <th scope="col" class={styles.num}>
                {t("usage.col.limit")}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={limits()}>
              {(c) => (
                <tr data-testid="usage-org-row" data-org={c.name}>
                  <th scope="row">{c.name}</th>
                  <td class={styles.num} data-testid="usage-org-used">
                    {number().format(c.used)}
                  </td>
                  <td class={styles.num} data-testid="usage-org-limit">
                    {number().format(c.limit)}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  )
}
