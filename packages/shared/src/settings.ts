import { Schema, Struct } from "effect"

export const Language = Schema.Literals(["system", "en", "ko"])
export const Theme = Schema.Literals(["system", "dark", "light"])
export const TextSize = Schema.Literals(["small", "default", "large"])
export const ReduceMotion = Schema.Literals(["system", "on", "off"])

/** User settings. Local to this computer. */
export const Settings = Schema.Struct({
  language: Language,
  theme: Theme,
  textSize: TextSize,
  compactPlaces: Schema.Boolean,
  reduceMotion: ReduceMotion,
  startAtLogin: Schema.Boolean,
  /** Folder where new agent workspaces are made. Empty means the default folder. */
  workspaceRoot: Schema.String,
})
export type Settings = typeof Settings.Type

export const SettingsPatch = Settings.mapFields(Struct.map(Schema.optionalKey))
export type SettingsPatch = typeof SettingsPatch.Type

export const defaultSettings: Settings = {
  language: "system",
  theme: "system",
  textSize: "default",
  compactPlaces: false,
  reduceMotion: "system",
  startAtLogin: false,
  workspaceRoot: "",
}

export type Locale = "en" | "ko"

/** Picks the interface language from the setting and the system locale. */
export const resolveLocale = (language: Settings["language"], systemLocale: string): Locale => {
  if (language !== "system") return language
  return systemLocale.toLowerCase().startsWith("ko") ? "ko" : "en"
}
