import type { AgentModel } from "./agents.ts"

// The backup model (spec 006, "Backup model"). An agent can name a second account, model and
// effort. When a turn of the agent fails with a limit reason, the main model is held until the
// reset time and the backup takes the turns.

/** The reasons that count as a limit: the plan limit, the credit or the quota is spent. */
export const LIMIT_REASONS = ["plan", "credit", "quota"] as const
export type LimitReason = (typeof LIMIT_REASONS)[number]

export const isLimitReason = (value: unknown): value is LimitReason =>
  typeof value === "string" && (LIMIT_REASONS as readonly string[]).includes(value)

const CREDIT_WORDS =
  /credit balance|insufficient (credits?|funds|balance)|out of credits?|no (more )?credits?|add (more )?credits|buy more credits|payment required/i
const QUOTA_WORDS =
  /insufficient[_ ]quota|exceeded your (current )?quota|quota (is |was |has been )?(exceeded|spent|reached|used)|out of quota|no quota|quota exceeded|resource[_ ]exhausted/i
const PLAN_WORDS =
  /usage limit|plan limit|(5|five)[- ]hour limit|weekly limit|daily limit|monthly limit|limit (reached|exceeded)|hit your (\w+ )?limit|reached your (\w+ )?limit|extra usage|allowance|rate[_ -]?limit|too many requests|\b429\b/i

/**
 * Which limit a report from a provider or a program names. Credit and quota come before the plan
 * limit, because a text that names the credit does not mean the plan. Null when the text names none
 * of them: a report that the app cannot read is no limit reason, and the turn fails as a turn with
 * no backup does (spec 006).
 */
export const limitReasonOf = (text: string): LimitReason | null => {
  if (CREDIT_WORDS.test(text)) return "credit"
  if (QUOTA_WORDS.test(text)) return "quota"
  if (PLAN_WORDS.test(text)) return "plan"
  return null
}

/** How long the main model is held when the provider names no reset time (spec 006). */
export const HOLD_UNKNOWN_MS = 15 * 60_000

/**
 * When the hold of the main model ends. The reset time that the provider names counts when it is
 * in the future. Without one, or with one that has passed, the hold lasts 15 minutes.
 */
export const holdEnd = (now: number, resetsAt?: number | null): number =>
  resetsAt !== undefined && resetsAt !== null && resetsAt > now ? resetsAt : now + HOLD_UNKNOWN_MS

/**
 * The hold of the main model of an agent, as a window or a linked device shows it (spec 006,
 * 012). It is a state of one computer: it does not sync (spec 019).
 */
export interface ModelHold {
  /** When the hold ends, in ms since the epoch. */
  readonly until: number
  /** The backup model that takes the turns while the hold lasts. */
  readonly model: AgentModel
}

/** True while the hold lasts at `now`. */
export const holdLasts = (hold: Pick<ModelHold, "until"> | null | undefined, now: number) =>
  hold !== null && hold !== undefined && hold.until > now

/** The same account, model and effort. The form refuses this as a backup (spec 006). */
export const sameModelChoice = (a: AgentModel | null, b: AgentModel | null): boolean =>
  a !== null &&
  b !== null &&
  a.accountId === b.accountId &&
  a.model === b.model &&
  (a.effort ?? null) === (b.effort ?? null)

/**
 * The short message that asks the backup model to go on, when the failed try ran steps (spec 006).
 * It is for the model only. It is not a message of the user, and the chat has no row for it.
 */
export const GO_ON_MESSAGE =
  "The model that began this turn reached its limit and stopped. The work above is what it did so far. Go on from there: do not repeat steps that are done, and finish the request."

/** The text for the model that stands for a step that did not end when the first try stopped. */
export const STEP_CUT_OUTPUT = "The step did not finish: the model stopped before it ended."
