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
// "Too many requests" is a busy provider, not a usage limit (spec 006, "Busy provider").
const PLAN_WORDS =
  /usage limit|plan limit|(5|five)[- ]hour limit|weekly limit|daily limit|monthly limit|limit (reached|exceeded)|hit your (\w+ )?limit|reached your (\w+ )?limit|extra usage|allowance|rate[_ -]?limit|\b429\b/i

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

/** An account, a model and a reasoning level (spec 006). */
export interface ModelPick {
  readonly accountId: string
  readonly model: string
  readonly effort: string | null
}

/**
 * The hold of the main model of a text node, as the editor and the run view of this computer show it
 * (spec 006, "Backup model"). It is a state of one computer: it does not sync (019), and a linked
 * device and the phone never get it (012, 011).
 */
export interface NodeHold {
  readonly nodeId: string
  /** The number of the node in its workflow, for the run view. */
  readonly number: number
  /** When the hold ends, in ms since the epoch. */
  readonly until: number
  /** The backup model that takes the tasks of the node while the hold lasts. */
  readonly backup: ModelPick
  /** The id of the main model of the node, for the button "Use <main model> now". */
  readonly main: string
}

/**
 * The muted line of the task view: "<main model> reached its limit. <backup model> goes on."
 * `main` and `backup` are model ids. `resetsAt` is the reset time when the provider named one.
 */
export interface TaskBackupNote {
  readonly main: string
  readonly backup: string
  readonly resetsAt: number | null
}

/** True while the hold lasts at `now`. */
export const holdLasts = (hold: Pick<NodeHold, "until"> | null | undefined, now: number) =>
  hold !== null && hold !== undefined && hold.until > now

/** The same account, model and effort. The form refuses this as a backup (spec 006). */
export const sameModelChoice = (a: ModelPick | null, b: ModelPick | null): boolean =>
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

/**
 * The answer to a model that tries to set or change a backup model of a node, in a graph change or in
 * a tool of the chat. A backup model is a second account for the node, so only the user sets it, in
 * the editor of the node (spec 006, "Backup model"; docs/spec-questions.md, B6).
 */
export const BACKUP_REFUSED_TEXT =
  "A backup model cannot be set or changed here. Only the user sets it, in the editor of the node. Leave the backup out."

/** True when the arguments of a tool call name a backup model: any key that starts with "backup". */
export const namesBackup = (args: Record<string, unknown>, clear?: readonly unknown[]): boolean =>
  Object.keys(args).some((key) => /^backup/i.test(key)) ||
  (clear ?? []).some((c) => typeof c === "string" && /^backup/i.test(c))
