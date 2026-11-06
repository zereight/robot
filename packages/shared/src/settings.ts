import { Schema, Struct } from "effect"
import { DECISION_CHOICES, DECISION_MODEL_DEFAULT, DECISION_MODEL_MAX } from "./decision.ts"
import { KEEP_AWAKE_DEFAULT, KEEP_AWAKE_MODES } from "./keepAwake.ts"
import { DEVICE_NAME_MAX } from "./link.ts"
import { ISLAND_MODES, ISLAND_WIDTHS } from "./notifications.ts"
import { STEP_LIMIT_DEFAULT, STEP_LIMIT_MAX, STEP_LIMIT_MIN } from "./steps.ts"

/** "While an agent works, new messages": join the current turn, or wait in a queue. */
export const DURING_TURN = ["join", "queue"] as const
export type DuringTurn = (typeof DURING_TURN)[number]

/** "Agents working at once" (spec 005, 013): the number of slots, from 1 to 8. */
export const AGENTS_AT_ONCE_MIN = 1
export const AGENTS_AT_ONCE_MAX = 8
export const AGENTS_AT_ONCE_DEFAULT = 4
/** True for a valid number of "Agents working at once" (spec 005, 013). */
export const isAgentsAtOnce = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= AGENTS_AT_ONCE_MIN &&
  value <= AGENTS_AT_ONCE_MAX

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

/**
 * How long work that an agent gave may stay quiet before the giver asks for its state, in minutes
 * (spec 013, 004, 007). 0 means off.
 */
export const CHASE_INTERVALS = [5, 10, 15, 30, 60, 0] as const
export const ChaseInterval = Schema.Literals(CHASE_INTERVALS)
export type ChaseInterval = typeof ChaseInterval.Type
export const DEFAULT_CHASE_INTERVAL: ChaseInterval = 15

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
  /** The silent limit in minutes; 0 for never. Local to this computer (spec 019). */
  silentLimit: SilentLimit,
  /** The chase interval in minutes; 0 for off. Local to this computer (spec 019). */
  chaseInterval: ChaseInterval,
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
    /**
     * The Teams link needs the user (spec 028, 015). A setting that was saved before this kind
     * existed has no value for it, and the kind counts as on.
     */
    teams_link: Schema.optionalKey(Schema.Boolean),
  }),
  /** The status island of macOS. */
  island: Schema.Literals(ISLAND_MODES),
  /** "Island bar width" (spec 015): "compact" or "wide". A setting of this computer. */
  islandWidth: Schema.Literals(ISLAND_WIDTHS),
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
  /** "Agents working at once" (spec 005, 013): how many tasks run at the same time. */
  agentsAtOnce: Schema.Int.check(
    Schema.isBetween({ minimum: AGENTS_AT_ONCE_MIN, maximum: AGENTS_AT_ONCE_MAX }),
  ),
  /**
   * "Keep the computer awake" (spec 013): when the app stops the computer from sleeping. A setting
   * saved before this existed has none, and the default holds the computer while an agent works.
   */
  keepAwake: Schema.Literals(KEEP_AWAKE_MODES),
  /**
   * "Show tool steps" (Appearance): when off, finished plain tool steps fold into one line per
   * run. A step that runs, waits, failed, was refused, or carries a note always stays open.
   */
  showToolSteps: Schema.Boolean,
  /**
   * "Show the organization before an agent name" (Appearance, spec 036): when on, the name of an
   * agent in an organization shows as "[Docs] Ada". A setting of this computer. A setting saved
   * before this existed has none, and the switch is on.
   */
  showOrgPrefix: Schema.Boolean,
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
  silentLimit: DEFAULT_SILENT_LIMIT,
  chaseInterval: DEFAULT_CHASE_INTERVAL,
  notifyKinds: {
    reply: true,
    mention: true,
    approval: true,
    question: true,
    task_failed: true,
    routine_failed: true,
    workflow_notice: true,
    teams_link: true,
  },
  island: "always",
  islandWidth: "compact",
  deviceName: "",
  acceptLinks: false,
  linkPort: 0,
  duringTurn: "join",
  secretsLocal: false,
  decisionModel: "off",
  decisionModelName: DECISION_MODEL_DEFAULT,
  permissionChecks: false,
  autoCompact: true,
  keepGoing: true,
  agentsAtOnce: AGENTS_AT_ONCE_DEFAULT,
  keepAwake: KEEP_AWAKE_DEFAULT,
  showToolSteps: true,
  showOrgPrefix: true,
}

export type Locale = "en" | "ko"

/** Picks the interface language from the setting and the system locale. */
export const resolveLocale = (language: Settings["language"], systemLocale: string): Locale => {
  if (language !== "system") return language
  return systemLocale.toLowerCase().startsWith("ko") ? "ko" : "en"
}
