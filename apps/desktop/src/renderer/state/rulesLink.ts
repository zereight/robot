import { createSignal } from "solid-js"

/**
 * A request to show the rules page (spec 007): filtered to one agent (the link in the profile of
 * an agent), or at one rule (a row of the action log). The page reads it and clears it.
 */
export interface RulesTarget {
  readonly agentId?: string
  readonly ruleId?: string
}

const [target, setTarget] = createSignal<RulesTarget>()

/** The request that waits. */
export const rulesTarget = target

/** Asks the rules page to show. The caller opens Settings, Permissions. */
export const showRules = (next: RulesTarget) => setTarget(next)

export const clearRulesTarget = () => setTarget(undefined)
