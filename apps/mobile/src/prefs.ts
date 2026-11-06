import { type PhoneStorage, readJson } from "@robot/phone"
import type { LanguageChoice } from "./i18n/index.ts"

export type ThemeChoice = "system" | "dark" | "light"

/** The settings of this phone. They stay on the phone and never go to a computer. */
export interface Prefs {
  readonly language: LanguageChoice
  readonly theme: ThemeChoice
}

export const defaultPrefs: Prefs = {
  language: "system",
  theme: "system",
}

const PREFS_FILE = "prefs.json"

const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback

/** Reads the settings. A bad or missing value gives its default. */
export const readPrefs = async (storage: PhoneStorage): Promise<Prefs> => {
  const raw = await readJson<Record<string, unknown>>(storage, PREFS_FILE, {})
  return {
    language: oneOf(raw.language, ["system", "en", "ko"], "system"),
    theme: oneOf(raw.theme, ["system", "dark", "light"], "system"),
  }
}

export const writePrefs = (storage: PhoneStorage, prefs: Prefs) =>
  storage.write(PREFS_FILE, JSON.stringify(prefs))
