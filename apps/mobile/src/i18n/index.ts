import { catalogues as desktopCatalogues } from "@robot/shared/i18n/index"
import { resolveJosa } from "@robot/shared/i18n/josa"
import { en, type MessageKey } from "./en.ts"
import { ko } from "./ko.ts"

export type { MessageKey } from "./en.ts"

export const LOCALES = ["en", "ko"] as const
export type Locale = (typeof LOCALES)[number]
export type LanguageChoice = "system" | Locale

export const catalogues: Record<Locale, Record<MessageKey, string>> = { en, ko }

export type MessageParams = Readonly<Record<string, string | number>>

const fill = (template: string, params?: MessageParams) =>
  params
    ? resolveJosa(
        template.replace(/\{(\w+)\}/g, (whole, name: string) =>
          name in params ? String(params[name]) : whole,
        ),
      )
    : template

/** The text of a key, with `{name}` placeholders filled from params. */
export const translate = (locale: Locale, key: MessageKey, params?: MessageParams): string =>
  fill(catalogues[locale][key] ?? en[key], params)

/** Names of the `{placeholders}` in a template. */
export const placeholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort()

/** The language to show for a choice, from the languages of the system in their order. */
export const resolveLocale = (choice: LanguageChoice, system: readonly string[]): Locale => {
  if (choice !== "system") return choice
  for (const tag of system) {
    const language = tag.toLowerCase().split(/[-_]/)[0]
    if (language === "ko") return "ko"
    if (language === "en") return "en"
  }
  return "en"
}

/**
 * The text for an error code of the link or of a server. The phone has its own words for the
 * codes of pairing and the link. A code that only a server knows (for example the reason of a
 * refused upload) uses the catalogue of the desktop, which has English and Korean too.
 */
export const errorText = (locale: Locale, code: string, detail = ""): string => {
  if (code === "update_app") {
    return translate(
      locale,
      detail === "this" ? "error.update_app.this" : "error.update_app.server",
    )
  }
  const own = `error.${code}` as MessageKey
  if (own in en) return translate(locale, own, { detail, code })
  const desktop = desktopCatalogues[locale] as Record<string, string | undefined>
  const text = desktop[`error.${code}`]
  if (text) return fill(text, { detail, code, name: detail })
  return translate(locale, "error.generic", { code })
}

/** A size in bytes as words, for a file chip. */
export const fileSizeText = (locale: Locale, bytes: number) => {
  if (bytes < 1024) return translate(locale, "file.size.b", { n: bytes })
  if (bytes < 1024 * 1024) {
    return translate(locale, "file.size.kb", { n: Math.round(bytes / 1024) })
  }
  return translate(locale, "file.size.mb", {
    n: (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, ""),
  })
}
