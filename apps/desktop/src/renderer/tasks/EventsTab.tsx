import {
  EVENT_RESULTS,
  EVENTS_PAGE,
  type EventResult,
  eventReasonText,
  eventResultKey,
  eventSourceKey,
  eventText,
  eventWhyText,
  type MessageKey,
  type RobotEvent,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatHitTime } from "../chat/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { setOpenTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./tasks.module.css"

/**
 * The tab "Events" (spec 038): one row for each arrival at a place that the user made, the place
 * that took it, and the reason when the place did nothing. It starts no work.
 */
export const EventsTab = (props: {
  readonly t: (key: MessageKey, params?: Record<string, string>) => string
}) => {
  const ui = useUi()
  const { locale } = useApp()
  const t = props.t
  /** The catalogue through a key that the row holds: a row names its own key (spec 038). */
  const byKey = (key: string, params?: Record<string, string>) => t(key as MessageKey, params)
  const [result, setResult] = createSignal<EventResult | "">("")
  const [query, setQuery] = createSignal("")
  const [openId, setOpenId] = createSignal<string | null>(null)
  /** How many pages of 50 the user asked for. "Show more" adds one. */
  const [pages, setPages] = createSignal(1)

  const [rows, { refetch }] = createResource(
    () => ({ serverId: ui.server()?.id, result: result(), pages: pages() }),
    async (input) => {
      if (!input.serverId) return [] as readonly RobotEvent[]
      const all: RobotEvent[] = []
      for (let page = 0; page < input.pages; page++) {
        const part = await call("events.list", {
          serverId: input.serverId,
          ...(input.result ? { result: input.result } : {}),
          offset: page * EVENTS_PAGE,
        }).catch(() => [] as readonly RobotEvent[])
        all.push(...part)
        // A short page means that there are no more rows.
        if (part.length < EVENTS_PAGE) break
      }
      return all
    },
    { initialValue: [] as readonly RobotEvent[] },
  )

  // A new event, or a trimmed test event, arrives while the tab is open (spec 038).
  onCleanup(
    window.robot.on("events.changed", ({ serverId }) => {
      if (serverId === ui.server()?.id) void refetch()
    }),
  )

  /** One line of text that the user reads for the row: the summary, then the reason. */
  const line = (event: RobotEvent) =>
    event.result === "waits" && event.subject
      ? t("events.waiting", { subject: event.subject })
      : event.result === "skipped" && event.reason
        ? (eventReasonText(event.reason, byKey) ?? eventText(event.summary, byKey))
        : eventText(event.summary, byKey)

  const shown = () =>
    rows()?.filter((e) => {
      const text = query().trim().toLowerCase()
      if (!text) return true
      const type = eventText(e.type, byKey).toLowerCase()
      const summary = eventText(e.summary, byKey).toLowerCase()
      return (
        summary.includes(text) ||
        type.includes(text) ||
        (e.subject ?? "").toLowerCase().includes(text)
      )
    }) ?? []

  const open = () => shown().find((e) => e.id === openId()) ?? null

  return (
    <div class={styles.page} data-testid="events-panel">
      <div class={styles.filters}>
        <label class={styles.filter}>
          <span>{t("events.filter.result")}</span>
          <select
            class={styles.select}
            onChange={(e) => setResult(e.currentTarget.value as EventResult | "")}
            data-testid="events-filter-result"
          >
            <option value="">{t("tasks.filter.all")}</option>
            <For each={EVENT_RESULTS}>
              {(r) => <option value={r}>{t(eventResultKey(r) as MessageKey)}</option>}
            </For>
          </select>
        </label>
        <input
          class={styles.search}
          type="search"
          placeholder={t("events.search")}
          aria-label={t("events.search")}
          onInput={(e) => setQuery(e.currentTarget.value)}
          data-testid="events-search"
        />
      </div>

      <Show
        when={(rows()?.length ?? 0) > 0}
        fallback={
          // A filter or a search that hides every row is not an empty page (spec 038).
          <p
            class={styles.muted}
            data-testid={result() || query().trim() ? "events-no-match" : "events-empty"}
          >
            {result() || query().trim() ? t("events.noMatch") : t("events.empty")}
          </p>
        }
      >
        <Show
          when={shown().length > 0}
          fallback={
            <p class={styles.muted} data-testid="events-no-match">
              {t("events.noMatch")}
            </p>
          }
        >
          <table class={styles.table} data-testid="events-table">
            <thead>
              <tr>
                <th scope="col">{t("events.col.source")}</th>
                <th scope="col">{t("events.col.type")}</th>
                <th scope="col">{t("events.col.summary")}</th>
                <th scope="col">{t("events.col.result")}</th>
                <th scope="col" class={styles.num}>
                  {t("events.col.time")}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()}>
                {(event) => (
                  <tr data-testid="event-row" data-result={event.result}>
                    <td>{t(eventSourceKey(event.source) as MessageKey)}</td>
                    <td>{eventText(event.type, byKey)}</td>
                    <th scope="row">
                      <button
                        type="button"
                        class={styles.rowButton}
                        onClick={() => setOpenId(event.id)}
                        data-testid="event-open"
                      >
                        {line(event)}
                      </button>
                      <Show when={event.placeName}>
                        <div class={styles.muted} data-testid="event-place">
                          {event.placeName}
                        </div>
                      </Show>
                      <Show when={event.outside}>
                        <div class={styles.muted} data-testid="event-mark">
                          {t("events.detail.mark")}
                        </div>
                      </Show>
                    </th>
                    <td data-testid="event-result">
                      {t(eventResultKey(event.result) as MessageKey)}
                    </td>
                    <td class={styles.num}>{formatHitTime(locale(), event.at)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={shown().length >= pages() * EVENTS_PAGE}>
            <button
              type="button"
              class={styles.rowButton}
              onClick={() => setPages((n) => n + 1)}
              data-testid="events-more"
            >
              {t("today.more")}
            </button>
          </Show>
        </Show>
      </Show>

      <Show when={open()}>
        {(event) => (
          <Dialog
            label={t("events.detail.title")}
            onClose={() => setOpenId(null)}
            testId="event-detail"
          >
            <div class={styles.eventDetail}>
              <dl class={styles.fields}>
                <dt>{t("events.col.source")}</dt>
                <dd>{t(eventSourceKey(event().source) as MessageKey)}</dd>
                <dt>{t("events.col.type")}</dt>
                <dd>{eventText(event().type, byKey)}</dd>
                <Show when={event().subject}>
                  {(subject) => (
                    <>
                      <dt>{t("events.detail.subject")}</dt>
                      <dd>{subject()}</dd>
                    </>
                  )}
                </Show>
                <Show when={event().callId}>
                  {(id) => (
                    <>
                      <dt>{t("events.detail.id")}</dt>
                      <dd>{id()}</dd>
                    </>
                  )}
                </Show>
                <dt>{t("events.col.result")}</dt>
                <dd>{t(eventResultKey(event().result) as MessageKey)}</dd>
                <Show when={event().reason}>
                  {(reason) => (
                    <>
                      <dt>{t("tasks.error")}</dt>
                      <dd data-testid="event-reason">{eventReasonText(reason(), byKey)}</dd>
                    </>
                  )}
                </Show>
                <dt>{t("events.detail.why")}</dt>
                <dd data-testid="event-why">{eventWhyText(event().why, byKey)}</dd>
                <Show when={event().got}>
                  <dt>{t("events.detail.got")}</dt>
                  <dd data-testid="event-got">{event().got}</dd>
                </Show>
                <Show when={event().detail}>
                  <dt>{t("tasks.prompt")}</dt>
                  <dd>{event().detail}</dd>
                </Show>
              </dl>
              <div class={styles.actions}>
                <Show when={event().result === "routed" && event().agentId}>
                  <button
                    type="button"
                    class={styles.rowButton}
                    onClick={() => {
                      setOpenTarget({ kind: "agentTasks", id: event().agentId ?? "" })
                      setOpenId(null)
                    }}
                    data-testid="event-open-place"
                  >
                    {t("events.detail.openPlace")}
                  </button>
                </Show>
                <button
                  type="button"
                  class={styles.rowButton}
                  onClick={() => setOpenId(null)}
                  data-testid="event-close"
                >
                  {t("events.detail.close")}
                </button>
              </div>
            </div>
          </Dialog>
        )}
      </Show>
    </div>
  )
}
