import { Schema } from "effect"
import { AgentCreate } from "./agents.ts"
import { type MessageKey, translate } from "./i18n/index.ts"
import type { Schedule } from "./schedule.ts"
import type { Locale } from "./settings.ts"

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

/** The routine of a starter runs on weekdays (Monday to Friday) at 08:00. */
export const STARTER_ROUTINE_SCHEDULE: Schedule = {
  kind: "weekly",
  days: [1, 2, 3, 4, 5],
  time: "08:00",
}

export interface StarterText {
  readonly name: string
  /** One line about what the agent does. It shows on the choice. */
  readonly job: string
  readonly role: string
  readonly instructions: string
  readonly routine: { readonly name: string; readonly prompt: string } | null
  readonly skill: {
    readonly name: string
    readonly description: string
    readonly instructions: string
  } | null
}

/**
 * The text of a starter in one language. The form reads it when the user picks the starter. The
 * app reads it again on Create, in the language that was in use at the pick (spec 002).
 */
export const starterText = (locale: Locale, id: StarterId): StarterText => {
  const plan = STARTER_PLANS[id]
  const text = (part: string) => translate(locale, `starter.${id}.${part}` as MessageKey)
  return {
    name: text("name"),
    job: text("job"),
    role: text("role"),
    instructions: text("instructions"),
    routine: plan.routine ? { name: text("routine.name"), prompt: text("routine.prompt") } : null,
    skill: plan.skill
      ? {
          name: text("skill.name"),
          description: text("skill.description"),
          instructions: text("skill.instructions"),
        }
      : null,
  }
}

/** The muted line of a choice: what else the starter makes. */
export const starterExtras = (locale: Locale, id: StarterId): string => {
  const plan = STARTER_PLANS[id]
  const parts = [
    ...(plan.routine ? [translate(locale, "starters.extra.routine")] : []),
    ...(plan.skill ? [translate(locale, "starters.extra.skill")] : []),
  ]
  return parts.length > 0 ? parts.join(", ") : translate(locale, "starters.extra.none")
}

export const StarterPick = Schema.Struct({
  id: Schema.Literals(STARTERS),
  /** The language of the interface when the user picked the starter. */
  locale: Schema.Literals(["en", "ko"]),
})
export type StarterPick = typeof StarterPick.Type

/**
 * A new agent from the form with a starter picked. The fields are those of the form. Only the
 * window of this computer sends it: a linked device sends the plain request (spec 012).
 */
export const AgentStarterCreate = Schema.Struct({
  ...AgentCreate.fields,
  starter: StarterPick,
})
export type AgentStarterCreate = typeof AgentStarterCreate.Type
