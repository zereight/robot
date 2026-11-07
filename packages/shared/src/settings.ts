import { Schema, Struct } from "effect"
import { DECISION_CHOICES, DECISION_MODEL_DEFAULT, DECISION_MODEL_MAX } from "./decision.ts"
import { DEVICE_NAME_MAX } from "./link.ts"
import { TASKS_AT_ONCE_DEFAULT, TASKS_AT_ONCE_MAX, TASKS_AT_ONCE_MIN } from "./tasks.ts"

/** The step limit of a task (spec 005, "Limits of a task"). */
export const STEP_LIMIT_MIN = 20
export const STEP_LIMIT_MAX = 2000
export const STEP_LIMIT_DEFAULT = 300
/** True when `value` is a whole number that the setting "step limit" accepts. */
export const isStepLimit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= STEP_LIMIT_MIN &&
  value <= STEP_LIMIT_MAX

export const Language = Schema.Literals(["system", "en", "ko"])
export const Theme = Schema.Literals(["system", "dark", "light"])
export const TextSize = Schema.Literals(["small", "default", "large"])
export const ReduceMotion = Schema.Literals(["system", "on", "off"])

/**
 * How long a turn may show no sign of life before the app stops it, in minutes (spec 005 and
 * 013). 0 means never.
 */
export const SILENT_LIMITS = [1, 5, 10, 30, 60, 0] as const
export const SilentLimit = Schema.Literals(SILENT_LIMITS)
export type SilentLimit = typeof SilentLimit.Type
export const DEFAULT_SILENT_LIMIT: SilentLimit = 10

/** User settings. Local to this computer. */
export const Settings = Schema.Struct({
  language: Language,
  theme: Theme,
  textSize: TextSize,
  reduceMotion: ReduceMotion,
  startAtLogin: Schema.Boolean,
  /** Folder where new workflow workspaces are made. Empty means the default folder. */
  workspaceRoot: Schema.String,
  /** The most steps that one task may take, a whole number from 20 to 2000 (spec 005, 013). */
  stepLimit: Schema.Int.check(
    Schema.isBetween({ minimum: STEP_LIMIT_MIN, maximum: STEP_LIMIT_MAX }),
  ),
  /** True once the user finished or skipped the first start guide. */
  firstRunDone: Schema.Boolean,
  /** The silent limit in minutes; 0 for never. Local to this computer (spec 019). */
  silentLimit: SilentLimit,
  /** The name that linked devices see. Empty means the name of the computer (spec 012). */
  deviceName: Schema.String.check(Schema.isMaxLength(DEVICE_NAME_MAX)),
  /** "Let other devices connect". Off at first start. */
  acceptLinks: Schema.Boolean,
  /** The port the app listened on last time, so a linked device finds it again. 0 for none. */
  linkPort: Schema.Number,
  /**
   * "Allow saved secrets on this computer and the local network" (spec 020). Off by default.
   * A setting saved before this switch existed has none, and the switch is off.
   */
  secretsLocal: Schema.Boolean,
  /**
   * The decision model (spec 013). Off at first: the model of the lead decides, and nothing is
   * sent. A setting saved before this existed has none, and the model is off.
   */
  decisionModel: Schema.Literals(DECISION_CHOICES),
  /** The model name of the choice "Jev through OpenRouter". An empty name means not set up. */
  decisionModelName: Schema.String.check(Schema.isMaxLength(DECISION_MODEL_MAX)),
  /**
   * The switch "Permission checks" (spec 013). Off at first: an agent at the level "Ask when
   * unsure" works as at "Ask for risky steps", and nothing is sent to the decision model. A
   * setting saved before this existed has none, and the switch is off.
   */
  permissionChecks: Schema.Boolean,
  /** "Compact long chats automatically" (spec 003, 013). On by default. */
  autoCompact: Schema.Boolean,
  /** "Keep going on open steps" (spec 005, 013). On by default. */
  keepGoing: Schema.Boolean,
  /** "Tasks at once" (spec 005, "Queue"; 013): a whole number from 1 to 8. */
  tasksAtOnce: Schema.Int.check(
    Schema.isBetween({ minimum: TASKS_AT_ONCE_MIN, maximum: TASKS_AT_ONCE_MAX }),
  ),
  /** "While an agent works, new messages" (spec 003, 013): join the current turn, or wait. */
  duringTurn: Schema.Literals(["join", "queue"]),
  /**
   * "Show tool steps" (spec 003, "Folded tool steps"; 013, Appearance). On by default. With it off,
   * the chat folds each series of plain tool steps into one muted line with the count. It changes
   * the view only.
   */
  showToolSteps: Schema.Boolean,
})
export type Settings = typeof Settings.Type

export const SettingsPatch = Settings.mapFields(Struct.map(Schema.optionalKey))
export type SettingsPatch = typeof SettingsPatch.Type

export const defaultSettings: Settings = {
  language: "system",
  theme: "system",
  textSize: "default",
  reduceMotion: "system",
  startAtLogin: false,
  workspaceRoot: "",
  stepLimit: STEP_LIMIT_DEFAULT,
  firstRunDone: false,
  silentLimit: DEFAULT_SILENT_LIMIT,
  deviceName: "",
  acceptLinks: false,
  linkPort: 0,
  secretsLocal: false,
  decisionModel: "off",
  decisionModelName: DECISION_MODEL_DEFAULT,
  permissionChecks: false,
  autoCompact: true,
  keepGoing: true,
  tasksAtOnce: TASKS_AT_ONCE_DEFAULT,
  duringTurn: "join",
  showToolSteps: true,
}

export type Locale = "en" | "ko"

/** Picks the interface language from the setting and the system locale. */
export const resolveLocale = (language: Settings["language"], systemLocale: string): Locale => {
  if (language !== "system") return language
  return systemLocale.toLowerCase().startsWith("ko") ? "ko" : "en"
}
