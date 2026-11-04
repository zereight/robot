import type { Locale } from "../settings.ts"
import { en, type MessageKey } from "./en.ts"
import { resolveJosa } from "./josa.ts"
import { ko } from "./ko.ts"

export type { MessageKey } from "./en.ts"

export const catalogues: Record<Locale, Record<MessageKey, string>> = { en, ko }

export type MessageParams = Readonly<Record<string, string | number>>

/** Returns the text for a key, with `{name}` placeholders filled from params. */
export const translate = (locale: Locale, key: MessageKey, params?: MessageParams): string => {
  const template = catalogues[locale][key] ?? en[key]
  if (!params) return template
  return resolveJosa(
    template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    ),
  )
}

/** Names of the `{placeholders}` in a template. */
export const placeholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort()
