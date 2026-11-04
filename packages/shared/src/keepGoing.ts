// "Keep going on open steps" (spec 005, "Keep going"; 013). An agent can end a turn before its
// work is done and leave steps open. When its program reports a list of steps, the app asks it to
// go on. The app decides from the list and never from the words of a reply.

/** A request can go on at most this many times (spec 005). */
export const KEEP_GOING_MAX = 8

/** One step of the list that a program reports (spec 006, "Rules"). */
export interface ListedStep {
  /** The words of the step, as the program wrote them. */
  readonly label: string
  readonly done: boolean
}

/** The list keeps at most this many steps, and a label at most this many characters. */
export const LIST_STEPS_MAX = 100
export const LIST_LABEL_MAX = 200

/**
 * Reads the steps of a list that a program reported. A step with no words is left out, a label is
 * cut, and a list is cut at `LIST_STEPS_MAX` steps. A list can be empty: the program cleared it.
 */
export const readStepList = (
  steps: readonly { readonly label: string; readonly done: boolean }[],
): ListedStep[] =>
  steps
    .map((step) => ({
      label: [...step.label.trim()].slice(0, LIST_LABEL_MAX).join(""),
      done: step.done,
    }))
    .filter((step) => step.label !== "")
    .slice(0, LIST_STEPS_MAX)

/** The labels of the steps that are not done, in the order of the list. */
export const openSteps = (plan: readonly ListedStep[] | null | undefined): string[] =>
  (plan ?? []).filter((step) => !step.done).map((step) => step.label)

/**
 * True when two sets of open steps are the same: the same count and the same labels (spec 005).
 * The order of the list does not count.
 */
export const sameOpenSteps = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((label, i) => label === right[i])
}

/** What the rule needs to know when a turn ends (spec 005, "Keep going"). */
export interface KeepGoingInput {
  /** The setting "Keep going on open steps" (013). */
  readonly enabled: boolean
  /** The last list that the program reported in this task. Null when it reported none. */
  readonly plan: readonly ListedStep[] | null
  /** The turn ended with a last line "Blocked:" (spec 005, "Blocked"). */
  readonly blocked: boolean
  /** A card waits for the user (an approval or a question). */
  readonly waiting: boolean
  /** How many times this request has gone on. */
  readonly count: number
  /** The open steps before the last continuation. Null before the first one. */
  readonly previous: readonly string[] | null
}

/**
 * The open steps to go on with, or null when the task ends. A turn goes on when it ended with no
 * error and no Stop (the caller does not ask in these cases), no "Blocked:" line and no waiting
 * card, and the last list holds a step that is not done. It stops at the limit, and when the open
 * steps are the same as before the last continuation.
 */
export const nextKeepGoing = (input: KeepGoingInput): string[] | null => {
  if (!input.enabled || input.blocked || input.waiting) return null
  if (input.count >= KEEP_GOING_MAX) return null
  const open = openSteps(input.plan)
  if (open.length === 0) return null
  if (input.previous !== null && sameOpenSteps(open, input.previous)) return null
  return open
}

/** The most steps that the message lists. */
const MESSAGE_STEPS_MAX = 40

/**
 * The short message that asks the agent to go on (spec 005). It is for the model only: it is not a
 * message of the user, and the chat has no row for it. It tells the agent to ask the user with a
 * question card and not in plain text, and it answers no question of the agent.
 */
export const KEEP_GOING_MESSAGE =
  "You ended your turn, but your list of steps still has steps that are not done. Go on with them. If you need a decision from the user, ask with a question card. Do not ask in plain text."

/** The message with the open steps listed, so a program that keeps no list can find them again. */
export const keepGoingMessage = (open: readonly string[]): string =>
  open.length === 0
    ? KEEP_GOING_MESSAGE
    : `${KEEP_GOING_MESSAGE}\n\nOpen steps:\n${open
        .slice(0, MESSAGE_STEPS_MAX)
        .map((label) => `- ${label}`)
        .join("\n")}`
