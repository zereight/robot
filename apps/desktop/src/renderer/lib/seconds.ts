import type { Locale } from "@robot/shared"

/** A time in ms as seconds with one decimal, in the number style of the language (spec 005). */
export const formatSeconds = (ms: number, locale: Locale) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    ms / 1000,
  )
