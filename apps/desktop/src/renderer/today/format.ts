import {
  catalogues,
  type Locale,
  type MessageKey,
  type MessageParams,
  sameDay,
  type TodayReason,
  type TodayRow,
  todayLine,
} from "@robot/shared"

type Translate = (key: MessageKey, params?: MessageParams) => string

/** A time for a row: the time alone on this day, the date and the time on another day. */
export const whenText = (locale: Locale, at: number, now = Date.now()) =>
  new Intl.DateTimeFormat(
    locale,
    sameDay(at, now)
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(at)

/** The words for why something failed. A reason with no text of its own gets the general text. */
export const reasonText = (t: Translate, reason: TodayReason | null) => {
  if (!reason) return ""
  const key = `error.${reason.code}`
  return key in catalogues.en ? t(key as MessageKey, { detail: reason.detail }) : t("error.unknown")
}

/**
 * The one line of a row. A card or a task shows its own text. A row without a card names the item:
 * the routine and why it stopped, the account and what is wrong, or the routine and its due time.
 * The line has at most 90 characters.
 */
export const rowLine = (t: Translate, locale: Locale, row: TodayRow, now = Date.now()) => {
  const time = (at: number) => whenText(locale, at, now)
  switch (row.kind) {
    case "routine_failed":
      return todayLine(
        t("today.line.failed", { name: row.text, reason: reasonText(t, row.reason) }),
      )
    case "routine_paused":
      return todayLine(
        t("today.line.paused", {
          name: row.text,
          count: row.count,
          reason: reasonText(t, row.reason),
        }),
      )
    case "account_signin":
      return todayLine(t("today.line.signIn", { name: row.text }))
    case "account_limit":
      return todayLine(
        row.resetsAt === null
          ? t("today.line.limit", { name: row.text })
          : t("today.line.limitReset", { name: row.text, time: time(row.resetsAt) }),
      )
    case "routine_next":
    case "workflow_next":
      return todayLine(t("today.line.due", { name: row.text, time: time(row.at) }))
    default:
      return todayLine(row.text)
  }
}

/**
 * The place or the source of a row, or an empty text. A row of work that is done tells how often
 * it ran.
 */
export const rowSource = (t: Translate, locale: Locale, row: TodayRow, now = Date.now()) => {
  const parts: string[] = []
  if (row.kind === "routine_done" || row.kind === "workflow_done") {
    const time = whenText(locale, row.at, now)
    parts.push(
      row.count === 1
        ? t("today.done.one", { time })
        : t("today.done.many", { count: row.count, time }),
    )
  }
  if (row.where?.kind === "direct") parts.push(t("today.place.direct"))
  else if (row.where?.kind === "channel")
    parts.push(t("today.place.channel", { name: row.where.name }))
  else if (row.where?.kind === "routine")
    parts.push(t("today.place.routine", { name: row.where.name }))
  else if (row.where?.kind === "workflow")
    parts.push(t("today.place.workflow", { name: row.where.name }))
  if (row.computer !== null)
    parts.push(t("today.computer", { name: row.computer || t("sync.anotherComputer") }))
  return parts.join(" · ")
}
