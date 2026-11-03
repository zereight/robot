import { Schema } from "effect"

/**
 * The decision model (spec 013): a small model that answers fast, with a probability for each
 * option. It is off by default. This version knows two choices: off, and Jev through OpenRouter.
 */
export const DECISION_CHOICES = ["off", "openrouter"] as const
export const DecisionChoice = Schema.Literals(DECISION_CHOICES)
export type DecisionChoice = typeof DecisionChoice.Type

/** The model that the choice "Jev through OpenRouter" starts with. */
export const DECISION_MODEL_DEFAULT = "typesafe/jev-1.14"
export const DECISION_MODEL_MAX = 200

/** The public Decisions API of OpenRouter. */
export const DECISION_URL = "https://openrouter.ai"
export const DECISION_PATH = "/api/alpha/decisions"

/** An answer counts only when the chosen option has at least this probability (spec 004). */
export const FAST_PICK_MIN = 0.6
/** The app waits at most this long for an answer (spec 004). */
export const DECISION_WAIT_MS = 3000
/** How many earlier messages of the channel go to the model, and how long each may be. */
export const PICK_RECENT_MAX = 5
export const PICK_RECENT_CHARS = 500
export const PICK_JOB_CHARS = 4000

/** The keys that a save may change. A key that is not named stays; `null` removes it. */
export const DecisionKeys = Schema.Struct({
  openrouter: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
})
export type DecisionKeys = typeof DecisionKeys.Type

/** What the settings page may learn: only whether a key is saved, never the key. */
export interface DecisionStatus {
  readonly keys: { readonly openrouter: boolean }
}

/** Why a decision gave no pick. The log of channels and the Test button use these words. */
export const PICK_REASONS = [
  "not_set_up",
  "timeout",
  "network_error",
  "service_error",
  "unreadable",
  "no_single_member",
  "unknown_option",
  "probability_not_number",
  "below_threshold",
  "not_most_likely",
] as const
export type PickReason = (typeof PICK_REASONS)[number]

/** One member as the model sees it. */
export interface PickMember {
  readonly name: string
  readonly role: string
}

export interface PickInput {
  readonly channelName: string
  readonly topic: string
  /** The last few messages before the job, oldest first. */
  readonly recent: readonly { readonly from: string; readonly text: string }[]
  readonly job: string
  readonly members: readonly PickMember[]
}

/** The answer of one pick. `index` is the chosen member, or null when there is no pick. */
export interface PickResult {
  readonly index: number | null
  readonly reason?: PickReason
  /** The status code of the service, when it refused the request. */
  readonly code?: number
  readonly probability: number | null
  readonly ms: number
}

/** The result of the Test button. */
export type DecisionTestResult =
  | {
      readonly ok: true
      readonly member: string
      readonly probability: number
      readonly ms: number
    }
  | {
      readonly ok: false
      readonly reason: PickReason
      readonly code?: number
      readonly ms: number
    }

/** The made-up members and job of the Test button. They are sent to the service. */
export const TEST_PICK: PickInput = {
  channelName: "Test",
  topic: "A test of the decision model",
  recent: [],
  job: "The login screen crashes when the password field is empty. Please fix it.",
  members: [
    { name: "Ada", role: "Writes and fixes code" },
    { name: "Ben", role: "Writes the help articles" },
    { name: "Cleo", role: "Plans the trips of the team" },
  ],
}

const NONE_KEY = "none"
const memberKey = (index: number) => `member_${index + 1}`

const clip = (text: string, max: number) =>
  text.length > max ? `${[...text].slice(0, max).join("")}…` : text

/**
 * The request for the Decisions API: one Choice question. An option has a plain key, so a name
 * can never act as an instruction, and the name and role line stand in its description. One more
 * option says that no single member fits.
 */
export const buildPickRequest = (model: string, input: PickInput) => {
  const criteria: Record<string, string> = {}
  input.members.forEach((m, i) => {
    criteria[memberKey(i)] = m.role.trim() ? `${m.name}: ${m.role.trim()}` : m.name
  })
  criteria[NONE_KEY] = "No single member fits, or the job needs several members."
  return {
    model,
    state: {
      channel: { name: input.channelName, topic: input.topic },
      recent_messages: input.recent.map((m) => ({
        from: m.from,
        text: clip(m.text, PICK_RECENT_CHARS),
      })),
      job: clip(input.job, PICK_JOB_CHARS),
    },
    questions: {
      pick: {
        type: "choice" as const,
        instructions:
          "Which member of this channel should take the job? Choose the one member whose role fits the job best.",
        criteria,
      },
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Reads the body of an answer. The app acts only when the chosen option is a member, is the most
 * likely option, and has a probability of at least `FAST_PICK_MIN` (spec 004).
 */
export const readPickAnswer = (
  body: unknown,
  memberCount: number,
): { ok: true; index: number; probability: number } | { ok: false; reason: PickReason } => {
  const answer = isRecord(body) && isRecord(body.answers) ? body.answers.pick : undefined
  if (!isRecord(answer) || answer.type !== "choice" || typeof answer.choice !== "string")
    return { ok: false, reason: "unreadable" }
  if (!isRecord(answer.probabilities)) return { ok: false, reason: "unreadable" }
  const chosen = answer.choice
  if (chosen === NONE_KEY) return { ok: false, reason: "no_single_member" }
  const index = Array.from({ length: memberCount }, (_, i) => memberKey(i)).indexOf(chosen)
  if (index < 0) return { ok: false, reason: "unknown_option" }
  const probability = answer.probabilities[chosen]
  if (typeof probability !== "number" || !Number.isFinite(probability))
    return { ok: false, reason: "probability_not_number" }
  for (const other of Object.values(answer.probabilities))
    if (typeof other === "number" && other > probability)
      return { ok: false, reason: "not_most_likely" }
  if (probability < FAST_PICK_MIN) return { ok: false, reason: "below_threshold" }
  return { ok: true, index, probability }
}
