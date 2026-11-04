import type { MessageKey, MessageParams, TaskUsage } from "@robot/shared"

type Translate = (key: MessageKey, params?: MessageParams) => string

/** A count of tokens in the number format of the language. `null` is a number that was not reported. */
export const formatCount = (locale: string, value: number | null): string =>
  value === null ? "—" : new Intl.NumberFormat(locale).format(value)

/**
 * The cost that the provider reports, in US dollars (spec 005). The app never works one out. A
 * small cost keeps up to 4 decimals, so it does not read as 0.
 */
export const formatCost = (locale: string, micros: number): string =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(micros / 1_000_000)

/** "7,000 in · 1,200 out". A number that the provider did not report shows as "—" (spec 005). */
export const usageLine = (
  t: Translate,
  locale: string,
  usage: Pick<TaskUsage, "input" | "output">,
): string =>
  t("taskUsage.line", {
    input: formatCount(locale, usage.input),
    output: formatCount(locale, usage.output),
  })
