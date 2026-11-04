/**
 * "Keep the computer awake" (spec 013, General): when the app stops the computer from going to
 * sleep. A computer that sleeps runs no agent and no routine (spec 009).
 *
 * - `off`: never. The computer sleeps as the system says.
 * - `working`: while an agent works.
 * - `routines`: while an agent works, and while a routine is on, as long as the computer is on
 *   power. On its battery the computer keeps awake only for the work that runs.
 */
export const KEEP_AWAKE_MODES = ["off", "working", "routines"] as const
export type KeepAwakeMode = (typeof KEEP_AWAKE_MODES)[number]
export const KEEP_AWAKE_DEFAULT: KeepAwakeMode = "working"

/** Why the computer is held awake. */
export type KeepAwakeReason = "working" | "routines"

export interface KeepAwakeInput {
  readonly mode: KeepAwakeMode
  /** The agents that work now. */
  readonly working: number
  /** The routines that are on and run on this computer. */
  readonly routines: number
  readonly onBattery: boolean
}

/** What the app tells the settings: whether it holds the computer awake, and why. */
export interface KeepAwakeState {
  readonly reason: KeepAwakeReason | null
  readonly mode: KeepAwakeMode
  readonly working: number
  readonly routines: number
  readonly onBattery: boolean
}

/**
 * The reason to hold the computer awake now, or null to let it sleep. Work that runs comes first:
 * it holds the computer on battery too, because it stops when the computer sleeps. A routine holds
 * it only on power, because it can wait hours for its time, and that costs the battery.
 */
export const keepAwakeReason = (input: KeepAwakeInput): KeepAwakeReason | null => {
  if (input.mode === "off") return null
  if (input.working > 0) return "working"
  if (input.mode === "routines" && input.routines > 0 && !input.onBattery) return "routines"
  return null
}

export const keepAwakeState = (input: KeepAwakeInput): KeepAwakeState => ({
  reason: keepAwakeReason(input),
  mode: input.mode,
  working: input.working,
  routines: input.routines,
  onBattery: input.onBattery,
})
