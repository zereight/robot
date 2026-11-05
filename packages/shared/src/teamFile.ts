/**
 * The channels, skills and handbook of a team file (spec 002, "Agent file"; spec 014, "Review
 * before an import"): which of them an export holds, and what an import makes from the ticks.
 */
import type { AgentFilePreview } from "./agentFile.ts"
import type { NotImported } from "./importReview.ts"

/**
 * The channels that an export holds for the picked agents: a channel with a member, whose
 * members are all among the picked agents. (A channel cannot be archived yet; when it can, an
 * archived channel stays out.)
 */
export const channelsForFile = <C extends { readonly memberIds: readonly string[] }>(
  channels: readonly C[],
  picked: ReadonlySet<string>,
): C[] =>
  channels.filter((c) => c.memberIds.length > 0 && c.memberIds.every((id) => picked.has(id)))

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

/** What the user ticked among the channels, skills and the handbook of a file. */
export interface TeamTicks {
  /** One entry for each channel of the file. */
  readonly channels: readonly boolean[]
  readonly skills: readonly boolean[]
  readonly handbook: boolean
}

/** The places in the file of the parts that are ticked. */
export const tickedPlaces = (ticks: readonly boolean[]): number[] =>
  ticks.flatMap((on, i) => (on ? [i] : []))

/**
 * The ticks at the start: channels and skills are ticked, and the handbook is not, because it
 * replaces the handbook of the server. A part where the app hid a secret is not ticked.
 */
export const startTeamTicks = (
  preview: Pick<AgentFilePreview, "channels" | "skills">,
): TeamTicks => ({
  channels: preview.channels.map((c) => !c.secretRemoved),
  skills: preview.skills.map((k) => !k.secretRemoved),
  handbook: false,
})

export interface PlannedChannel {
  /** The place of the channel in the file. */
  readonly index: number
  /** The agents of the file that are made, in the order of the file. At least one. */
  readonly members: readonly number[]
  /** A place in the agents of the file, or null: a lead that is not made leaves none. */
  readonly lead: number | null
}

export interface PlannedSkill {
  readonly index: number
  /** The agents of the file that are made and may use the skill. At least one. */
  readonly agents: readonly number[]
}

/** A ticked part that the import does not make, with the reason. */
export type SkippedPart =
  | { readonly kind: "channel"; readonly index: number }
  | {
      readonly kind: "skill"
      readonly index: number
      readonly reason: "skill_no_agent" | "skills_full"
    }

/**
 * What an import makes from the ticks (spec 002, "Agent file"):
 * - A channel is made without a member that the user did not tick. A lead that is not made leaves
 *   it with no lead. A channel with no member left is not made.
 * - A skill is made for the agents that are made. A skill with no such agent is not made.
 * - A skill past the room of the server (spec 017: 100 skills) is not made. The skills before it,
 *   in the order of the file, are.
 * `made` tells if the agent at a place of the file is made.
 */
export const planTeam = (input: {
  readonly channels: readonly {
    readonly members: readonly number[]
    readonly lead: number | null
  }[]
  readonly skills: readonly { readonly agents: readonly number[] }[]
  readonly made: (agent: number) => boolean
  readonly channelPicks: readonly number[]
  readonly skillPicks: readonly number[]
  readonly skillRoom: number
}) => {
  const channels: PlannedChannel[] = []
  const skills: PlannedSkill[] = []
  const skipped: SkippedPart[] = []
  for (const index of input.channelPicks) {
    const channel = input.channels[index]
    if (!channel) continue
    const members = channel.members.filter(input.made)
    if (members.length === 0) skipped.push({ kind: "channel", index })
    else
      channels.push({
        index,
        members,
        lead: channel.lead !== null && members.includes(channel.lead) ? channel.lead : null,
      })
  }
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
  return { channels, skills, skipped }
}

/** The lines "Not imported" for the parts that the ticks leave out, with the names to show. */
export const skippedNotImported = (
  skipped: readonly SkippedPart[],
  preview: Pick<AgentFilePreview, "channels" | "skills">,
): NotImported[] =>
  skipped.flatMap((part): NotImported[] => {
    if (part.kind === "channel") {
      const channel = preview.channels[part.index]
      return channel ? [{ reason: "channel_no_member", owner: channel.name }] : []
    }
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
