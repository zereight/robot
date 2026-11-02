import { Schema, Struct } from "effect"
import { DEVICE_NAME_MAX } from "./link.ts"
import { ISLAND_MODES } from "./notifications.ts"
import { STEP_LIMIT_DEFAULT, STEP_LIMIT_MAX, STEP_LIMIT_MIN } from "./steps.ts"

/** "While an agent works, new messages": join the current turn, or wait in a queue. */
export const DURING_TURN = ["join", "queue"] as const
export type DuringTurn = (typeof DURING_TURN)[number]

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
  /** The most steps that one task may take, a whole number from 20 to 2000 (spec 005, 013). */
  stepLimit: Schema.Int.check(
    Schema.isBetween({ minimum: STEP_LIMIT_MIN, maximum: STEP_LIMIT_MAX }),
  ),
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
    /**
     * A notify step of a workflow. A setting that was saved before this kind existed has no
     * value for it, and the kind counts as on.
     */
    workflow_notice: Schema.optionalKey(Schema.Boolean),
  }),
  /** The status island of macOS. */
  island: Schema.Literals(ISLAND_MODES),
  /** The name that linked devices see. Empty means the name of the computer (spec 012). */
  deviceName: Schema.String.check(Schema.isMaxLength(DEVICE_NAME_MAX)),
  /** "Let other devices connect". Off at first start. */
  acceptLinks: Schema.Boolean,
  /** The port the app listened on last time, so a linked device finds it again. 0 for none. */
  linkPort: Schema.Number,
  /** What a message does that the user sends while the agent works (spec 003). */
  duringTurn: Schema.Literals(DURING_TURN),
  /**
   * "Allow saved secrets on this computer and the local network" (spec 020). Off by default.
   * A setting saved before this switch existed has none, and the switch is off.
   */
  secretsLocal: Schema.Boolean,
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
  stepLimit: STEP_LIMIT_DEFAULT,
  firstRunDone: false,
  notifyKinds: {
    reply: true,
    mention: true,
    approval: true,
    question: true,
    task_failed: true,
    routine_failed: true,
    workflow_notice: true,
  },
  island: "always",
  deviceName: "",
  acceptLinks: false,
  linkPort: 0,
  duringTurn: "join",
  secretsLocal: false,
}

export type Locale = "en" | "ko"

/** Picks the interface language from the setting and the system locale. */
export const resolveLocale = (language: Settings["language"], systemLocale: string): Locale => {
  if (language !== "system") return language
  return systemLocale.toLowerCase().startsWith("ko") ? "ko" : "en"
}
