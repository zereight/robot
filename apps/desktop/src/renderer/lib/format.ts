import type { Locale } from "@robot/shared"

/** True when `at` is a time that a date can hold. A larger number makes the formatter throw. */
export const isCalendarTime = (at: number) => Number.isFinite(at) && Math.abs(at) <= 8.64e15

/**
 * A date and a time, for a record such as "Last changed by". A value that is not a time of the
 * calendar gives an empty text: a bad number from a provider must never break a window.
 */
export const formatDateTime = (locale: Locale, at: number) =>
  isCalendarTime(at)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at)
    : ""
