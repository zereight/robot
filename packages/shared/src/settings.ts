import { Schema, Struct } from "effect"
import { DEVICE_NAME_MAX } from "./link.ts"
import { ISLAND_MODES } from "./notifications.ts"

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
  /** True once the user finished or skipped the first start guide. */
  firstRunDone: Schema.Boolean,
  /** Which kinds of system notification are on. */
  notifyKinds: Schema.Struct({
    reply: Schema.Boolean,
    mention: Schema.Boolean,
    approval: Schema.Boolean,
    question: Schema.Boolean,
    task_failed: Schema.Boolean,
    routine_failed: Schema.Boolean,
  }),
  /** The status island of macOS. */
  island: Schema.Literals(ISLAND_MODES),
  /** The name that linked devices see. Empty means the name of the computer (spec 012). */
  deviceName: Schema.String.check(Schema.isMaxLength(DEVICE_NAME_MAX)),
  /** "Let other devices connect". Off at first start. */
  acceptLinks: Schema.Boolean,
  /** The port the app listened on last time, so a linked device finds it again. 0 for none. */
  linkPort: Schema.Number,
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
  firstRunDone: false,
  notifyKinds: {
    reply: true,
    mention: true,
    approval: true,
    question: true,
    task_failed: true,
    routine_failed: true,
  },
  island: "always",
  deviceName: "",
  acceptLinks: false,
  linkPort: 0,
}

export type Locale = "en" | "ko"

/** Picks the interface language from the setting and the system locale. */
export const resolveLocale = (language: Settings["language"], systemLocale: string): Locale => {
  if (language !== "system") return language
  return systemLocale.toLowerCase().startsWith("ko") ? "ko" : "en"
}
