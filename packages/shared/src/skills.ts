/** Skills (spec 017): saved instructions that the user calls in a chat. */

import type { OrgToolEntry } from "./orgTools.ts"

export const SKILL_NAME_MAX = 40
export const SKILL_DESCRIPTION_MAX = 140
export const SKILL_INSTRUCTIONS_MAX = 20_000
/** A server holds at most this many skills. */
export const SKILLS_MAX = 100

export interface Skill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly instructions: string
  /** The agents that may use the skill. `null` means all agents. */
  readonly agentIds: readonly string[] | null
  /**
   * The channels in the list of the skill (spec 017, 030): each gives the skill to its members and
   * to the members of its lower channels. Empty for "All agents" and for a list of agents only.
   */
  readonly channelIds: readonly string[]
  /**
   * The organizations in the list of the skill (spec 017, 030) with the value "On" or "Off". An
   * organization that is not here has the value "Inherit". Empty for "All agents".
   */
  readonly organizations: readonly OrgToolEntry[]
  readonly enabled: boolean
  readonly createdAt: number
}

export interface SkillInput {
  readonly name: string
  readonly description: string
  readonly instructions: string
}

/** The field of a skill form that is wrong, and why. The reason is an error code. */
export interface SkillProblem {
  readonly field: "name" | "description" | "instructions"
  readonly code: "skill_name_empty" | "skill_name_long" | "skill_description_long" | "skill_empty"
}

/** The name as it is kept: trimmed, with no slash at the start. */
export const skillName = (name: string) => name.trim().replace(/^\/+/, "").trim()

/** The key that makes names unique: case does not count. */
export const skillNameKey = (name: string) => skillName(name).normalize("NFC").toLocaleLowerCase()

/**
 * A name that no skill uses yet. A name that is taken gets a number: "Name 2", "Name 3". The base
 * is cut when the name with its number would pass the length limit. `taken` tells whether a name
 * is in use. It must ignore case, as the check of the form does.
 */
export const numberedSkillName = (name: string, taken: (candidate: string) => boolean) => {
  const base = skillName(name)
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const tail = ` ${n}`
    const room = SKILL_NAME_MAX - [...tail].length
    const candidate = [...base].slice(0, room).join("").trimEnd() + tail
    if (!taken(candidate)) return candidate
  }
}

/**
 * The name of a copy of a skill (spec 017, flow 3): the name and the word "copy" in the language of
 * the interface (`suffix`, for example " copy"), and a number when that name is taken. The name is
 * cut so that the copy fits the length limit.
 */
export const copySkillName = (
  name: string,
  suffix: string,
  taken: (candidate: string) => boolean,
) => {
  const base = [...skillName(name)]
  for (let n = 1; ; n++) {
    const tail = n === 1 ? suffix : `${suffix} ${n}`
    const room = Math.max(1, SKILL_NAME_MAX - [...tail].length)
    const candidate = base.slice(0, room).join("").trimEnd() + tail
    if (!taken(candidate)) return candidate
  }
}

/** The problems of a skill form, in the order of the fields. Empty when it can be saved. */
export const skillProblems = (input: SkillInput): readonly SkillProblem[] => {
  const problems: SkillProblem[] = []
  const name = skillName(input.name)
  if (!name) problems.push({ field: "name", code: "skill_name_empty" })
  else if ([...name].length > SKILL_NAME_MAX)
    problems.push({ field: "name", code: "skill_name_long" })
  if ([...input.description.trim()].length > SKILL_DESCRIPTION_MAX)
    problems.push({ field: "description", code: "skill_description_long" })
  if (!input.instructions.trim() || input.instructions.length > SKILL_INSTRUCTIONS_MAX)
    problems.push({ field: "instructions", code: "skill_empty" })
  return problems
}

/** What a delete of an agent does to one skill (spec 017, "Rules"). */
export type SkillAfterAgentDelete =
  | { readonly kind: "same" }
  | { readonly kind: "shorter"; readonly agentIds: readonly string[] }
  | { readonly kind: "delete" }

/**
 * What happens to a skill when the agent `agentId` is deleted. A skill for all agents, and a skill
 * that does not name the agent, stay as they are. The agent leaves the list of the others. A skill
 * that was only for this agent is deleted: no agent that still exists is left in its list.
 * `exists` tells whether an agent is still there, in the archive or not; an id of an agent that
 * went before this rule counts as gone. A channel that is still there and that is in the list keeps
 * the skill (spec 030): the skill is not only for this agent.
 */
export const skillAfterAgentDelete = (
  agentIds: readonly string[] | null,
  agentId: string,
  exists: (id: string) => boolean,
  channelsLeft = 0,
): SkillAfterAgentDelete => {
  if (agentIds === null || !agentIds.includes(agentId)) return { kind: "same" }
  const rest = agentIds.filter((id) => id !== agentId)
  return rest.some(exists) || channelsLeft > 0
    ? { kind: "shorter", agentIds: rest }
    : { kind: "delete" }
}

/** What the agent reads before the text of a message with a skill chip. */
export const skillLead = (name: string, instructions: string) =>
  `Use the skill "${name}". Its instructions:\n${instructions}`
