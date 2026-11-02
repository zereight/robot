import { type MessageKey, translate } from "./i18n/index.ts"
import type { Locale } from "./settings.ts"
import { STARTER_PLANS, type StarterId, type StarterSetup } from "./starters.ts"

// The text of the starters. Only the window and the tests read this file: the main process gets
// the strings in the request, so the text catalogues stay out of it.

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
 * The text of a starter in one language. The new agent form reads it when the user picks the
 * starter, and keeps the language of the pick for the strings that it sends on Create (spec 002).
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

/**
 * The strings that go with the request on Create. It is null for a starter that makes nothing
 * else, so the window makes a plain agent then.
 */
export const starterSetup = (text: StarterText): StarterSetup | null =>
  text.routine || text.skill ? { routine: text.routine, skill: text.skill } : null
