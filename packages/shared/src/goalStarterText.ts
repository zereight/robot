import type { GoalStarterId, SavedStarter } from "./goalStarters.ts"
import { type MessageKey, translate } from "./i18n/index.ts"
import type { Locale } from "./settings.ts"
import { STARTERS, type StarterId } from "./starters.ts"
import { starterExtras, starterText } from "./starterText.ts"

// The text of the goal dialog (spec 031). Only the window and the tests read this file.

/** The roles that only the Product channel starter has. */
const PRODUCT_ROLES = ["pm", "planner", "designer", "developer", "qa"] as const
type ProductRole = (typeof PRODUCT_ROLES)[number]
type Role = StarterId | ProductRole

/** The agents of each channel starter. The first one is the lead. */
const CHANNEL_STARTERS = {
  research: ["researcher", "briefer", "assistant"],
  codeReview: ["reviewer", "assistant"],
  files: ["organizer", "assistant"],
  product: ["pm", "planner", "designer", "developer", "qa", "reviewer"],
} as const satisfies Partial<Record<GoalStarterId, readonly Role[]>>
type ChannelStarterId = keyof typeof CHANNEL_STARTERS

export const isChannelStarter = (id: GoalStarterId): id is ChannelStarterId =>
  id in CHANNEL_STARTERS

/** The agent starter that a row of the dialog is, or null for a channel starter. */
export const agentStarterOf = (id: GoalStarterId): StarterId | null =>
  (STARTERS as readonly string[]).includes(id) ? (id as StarterId) : null

/** What the preview shows and Create makes. `lead` is the index of the lead in `agents`. */
export interface ChannelPlan {
  readonly name: string
  readonly topic: string
  readonly lead: number
  readonly agents: readonly { name: string; role: string; instructions: string }[]
}

const roleText = (locale: Locale, role: Role) => {
  if ((STARTERS as readonly string[]).includes(role)) {
    const { name, role: line, instructions } = starterText(locale, role as StarterId)
    return { name, role: line, instructions }
  }
  const text = (part: string) => translate(locale, `starter.${role}.${part}` as MessageKey)
  return { name: text("name"), role: text("role"), instructions: text("instructions") }
}

/** The channel of a channel starter in one language. The language is that of the pick (spec 002). */
export const channelPlan = (locale: Locale, id: ChannelStarterId): ChannelPlan => ({
  name: translate(locale, `goal.${id}.name` as MessageKey),
  topic: translate(locale, `goal.${id}.topic` as MessageKey),
  lead: 0,
  agents: CHANNEL_STARTERS[id].map((role) => roleText(locale, role)),
})

/** The channel of a saved starter. It has the text that the user saved. */
export const savedPlan = (saved: SavedStarter): ChannelPlan => ({
  name: saved.name,
  topic: saved.topic,
  lead: saved.lead,
  agents: saved.agents,
})

export interface GoalRow {
  readonly name: string
  /** One line about what the starter does. */
  readonly line: string
  /** The muted line: what else an agent starter makes, or how many agents a channel makes. */
  readonly muted: string
}

export const goalRow = (locale: Locale, id: GoalStarterId): GoalRow => {
  if (isChannelStarter(id)) {
    return {
      name: translate(locale, `goal.${id}.name` as MessageKey),
      line: translate(locale, `goal.${id}.topic` as MessageKey),
      muted: translate(locale, "goal.agents", { count: CHANNEL_STARTERS[id].length }),
    }
  }
  const starter = agentStarterOf(id) as StarterId
  return {
    name: starterText(locale, starter).name,
    line: starterText(locale, starter).job,
    muted: starterExtras(locale, starter),
  }
}
