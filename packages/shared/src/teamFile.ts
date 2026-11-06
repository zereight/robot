/**
 * The skills and handbook of a team file (spec 002, "Agent file"; spec 014, "Review
 * before an import"): which of them an export holds, and what an import makes from the ticks.
 */
import type { AgentFilePreview } from "./agentFile.ts"
import type { NotImported } from "./importReview.ts"

/**
 * The skills that an export holds for the picked agents: each skill that one of them may use. A
 * skill for all agents counts when at least one agent is picked. `agentIds` is null for a skill
 * for all agents.
 */
export const skillsForFile = <S extends { readonly agentIds: readonly string[] | null }>(
  skills: readonly S[],
  picked: ReadonlySet<string>,
): S[] =>
  skills.filter((s) =>
    s.agentIds === null ? picked.size > 0 : s.agentIds.some((id) => picked.has(id)),
  )

/** What the user ticked among the skills and the handbook of a file. */
export interface TeamTicks {
  readonly skills: readonly boolean[]
  readonly handbook: boolean
}

/** The places in the file of the parts that are ticked. */
export const tickedPlaces = (ticks: readonly boolean[]): number[] =>
  ticks.flatMap((on, i) => (on ? [i] : []))

/**
 * The ticks at the start: skills are ticked, and the handbook is not, because it
 * replaces the handbook of the server. A part where the app hid a secret is not ticked.
 */
export const startTeamTicks = (preview: Pick<AgentFilePreview, "skills">): TeamTicks => ({
  skills: preview.skills.map((k) => !k.secretRemoved),
  handbook: false,
})

export interface PlannedSkill {
  readonly index: number
  /** The agents of the file that are made and may use the skill. At least one. */
  readonly agents: readonly number[]
}

/** A ticked part that the import does not make, with the reason. */
export interface SkippedPart {
  readonly kind: "skill"
  readonly index: number
  readonly reason: "skill_no_agent" | "skills_full"
}

/**
 * What an import makes from the ticks (spec 002, "Agent file"):
 * - A skill is made for the agents that are made. A skill with no such agent is not made.
 * - A skill past the room of the server (spec 017: 100 skills) is not made. The skills before it,
 *   in the order of the file, are.
 * `made` tells if the agent at a place of the file is made.
 */
export const planTeam = (input: {
  readonly skills: readonly { readonly agents: readonly number[] }[]
  readonly made: (agent: number) => boolean
  readonly skillPicks: readonly number[]
  readonly skillRoom: number
}) => {
  const skills: PlannedSkill[] = []
  const skipped: SkippedPart[] = []
  let room = Math.max(0, input.skillRoom)
  for (const index of input.skillPicks) {
    const skill = input.skills[index]
    if (!skill) continue
    const agents = skill.agents.filter(input.made)
    if (agents.length === 0) skipped.push({ kind: "skill", index, reason: "skill_no_agent" })
    else if (room === 0) skipped.push({ kind: "skill", index, reason: "skills_full" })
    else {
      room--
      skills.push({ index, agents })
    }
  }
  return { skills, skipped }
}

/** The lines "Not imported" for the parts that the ticks leave out, with the names to show. */
export const skippedNotImported = (
  skipped: readonly SkippedPart[],
  preview: Pick<AgentFilePreview, "skills">,
): NotImported[] =>
  skipped.flatMap((part): NotImported[] => {
    const skill = preview.skills[part.index]
    return skill ? [{ reason: part.reason, owner: skill.name }] : []
  })

/** The lines of a handbook that the review shows before "Show all". */
export const HANDBOOK_PREVIEW_LINES = 4
/** The most characters of that preview. */
export const HANDBOOK_PREVIEW_CHARS = 280

/**
 * The first lines of a handbook for the review (spec 002, "Agent file"): at most
 * `HANDBOOK_PREVIEW_LINES` lines and `HANDBOOK_PREVIEW_CHARS` characters. `more` is true when
 * the text goes on, so the review shows "Show all".
 */
export const handbookPreview = (
  text: string,
): { readonly text: string; readonly more: boolean } => {
  const lines = text.trim().split(/\r?\n/).slice(0, HANDBOOK_PREVIEW_LINES).join("\n")
  const cut = [...lines].slice(0, HANDBOOK_PREVIEW_CHARS).join("")
  return { text: cut, more: cut !== text.trim() }
}
