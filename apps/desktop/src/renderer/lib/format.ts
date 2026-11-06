import type { Locale } from "@robot/shared"

/** A date and a time, for a record such as "Last changed by". */
export const formatDateTime = (locale: Locale, at: number) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at)
