import { Schema } from "effect"
import { AgentCreate, charLength } from "./agents.ts"
import { ROUTINE_NAME_MAX, ROUTINE_PROMPT_MAX } from "./routines.ts"
import type { Schedule } from "./schedule.ts"
import { skillProblems } from "./skills.ts"

// This file holds no interface text. The text catalogues are large, and the main process must not
// carry them: the window picks the text of a starter and sends the strings with the request (see
// `starterText.ts`, which only the window reads).

/** The starters of the new agent form, in the order of the list (spec 002, "Starters"). */
export const STARTERS = ["assistant", "briefer", "researcher", "reviewer", "organizer"] as const
export type StarterId = (typeof STARTERS)[number]

/** What a starter makes when the user presses Create, besides the three filled fields. */
export interface StarterPlan {
  /** A paused routine that posts in the chat of the new agent. */
  readonly routine: boolean
  /** One skill for the new agent only, turned on. */
  readonly skill: boolean
}

export const STARTER_PLANS: Readonly<Record<StarterId, StarterPlan>> = {
  assistant: { routine: false, skill: false },
  briefer: { routine: true, skill: true },
  researcher: { routine: false, skill: true },
  reviewer: { routine: false, skill: true },
  organizer: { routine: false, skill: true },
}

/**
 * The routine of a starter runs on weekdays (Monday to Friday) at 08:00. The request does not
 * carry it: the app sets the schedule, the pause and the place itself, so a request cannot make a
 * routine that is on.
 */
export const STARTER_ROUTINE_SCHEDULE: Schedule = {
  kind: "weekly",
  days: [1, 2, 3, 4, 5],
  time: "08:00",
}

/** A text that holds at least one character that is not a space. */
const notBlank = Schema.makeFilter((s: string) => s.trim().length > 0)

/**
 * The strings of the routine of a starter, in the language of the pick. They pass the same limits
 * as a routine that the user makes (spec 009): a name of 1 to 60 characters, a prompt of 1 to
 * 20000, and neither is only spaces.
 */
export const StarterRoutine = Schema.Struct({
  name: Schema.String.check(
    Schema.makeFilter((s: string) => charLength(s.trim()) <= ROUTINE_NAME_MAX),
    notBlank,
  ),
  prompt: Schema.String.check(Schema.isMaxLength(ROUTINE_PROMPT_MAX), notBlank),
})
export type StarterRoutine = typeof StarterRoutine.Type

/**
 * The strings of the skill of a starter, in the language of the pick. They pass the checks of the
 * skill form (spec 017): the name, the description and the instructions, each within its limit.
 */
export const StarterSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
}).check(
  Schema.makeFilter((skill: { name: string; description: string; instructions: string }) => {
    const problem = skillProblems(skill)[0]
    return problem ? `${problem.field}: ${problem.code}` : true
  }),
)
export type StarterSkill = typeof StarterSkill.Type

/**
 * What a starter makes besides the agent, as strings. The window resolves them in the language of
 * the interface at the moment of the pick (spec 002). A part that the starter does not make is
 * null.
 */
export const StarterSetup = Schema.Struct({
  routine: Schema.NullOr(StarterRoutine),
  skill: Schema.NullOr(StarterSkill),
})
export type StarterSetup = typeof StarterSetup.Type

/**
 * A new agent from the form with a starter picked. The fields are those of the form. Only the
 * window of this computer sends it: a linked device sends the plain request (spec 012).
 */
export const AgentStarterCreate = Schema.Struct({
  ...AgentCreate.fields,
  starter: StarterSetup,
})
export type AgentStarterCreate = typeof AgentStarterCreate.Type
