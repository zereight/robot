/**
 * The handbook (spec 002, "Handbook") and the instructions of a channel (spec 004): texts that an
 * agent reads before its own instructions or after them. This file holds the limits, the shapes of
 * the history, and the one rule for the order in which the texts reach the agent.
 */

/** The handbook holds 0 to 20000 characters (spec 002). */
export const HANDBOOK_MAX = 20_000
/** The history of the handbook keeps the last 20 versions (spec 002). */
export const HANDBOOK_HISTORY_MAX = 20
/** The instructions of a channel hold up to 4000 characters (spec 004). */
export const CHANNEL_INSTRUCTIONS_MAX = 4_000
/** The goal of an organization holds 0 to 400 characters (spec 030, "Goal"). */
export const ORG_GOAL_MAX = 400

/**
 * The lead prompt (spec 004, "Lead prompt"): the agent that leads a channel reads it in each turn of
 * that channel. When the lead changes, the old lead gets the note LEAD_ENDED_NOTE in its memory.
 */
export const LEAD_PROMPT =
  "You are the lead of this channel. You are an orchestrator: you delegate work, you do not do it yourself. You read each new job first and split it into parts. Give each part to a member, with a short label and a done test. Do not do the work of a part, and do not do the work of a member. Answer yourself only a question about the plan or the state of the job. After the parts end, give a verdict on each and post one summary."
export const LEAD_ENDED_NOTE = "You are not the lead of this channel."

/**
 * Where a version of the handbook came from: the page of settings, a linked device (012), a
 * restore, or an import of a team file (014, 002).
 */
export const HANDBOOK_SOURCES = ["page", "device", "restore", "import"] as const
export type HandbookSource = (typeof HANDBOOK_SOURCES)[number]

/** The source of a version that an import of a team file made (spec 002, "Agent file"). */
export const HANDBOOK_FROM_FILE: HandbookSource = "import"

/** One saved text of the handbook. The newest version of a server is the handbook now. */
export interface HandbookVersion {
  readonly id: string
  readonly serverId: string
  readonly text: string
  readonly source: HandbookSource
  readonly createdAt: number
}

/** The handbook of one server. `updatedAt` is null while it was never written. */
export interface Handbook {
  readonly serverId: string
  readonly text: string
  readonly updatedAt: number | null
}

/** Length in user-visible characters, as for the other texts of the app. */
const length = (text: string) => [...text].length

/** True when `text` is longer than the handbook may be. */
export const handbookTooLong = (text: string) => length(text) > HANDBOOK_MAX

/** True when `text` is longer than the instructions of a channel may be. */
export const channelInstructionsTooLong = (text: string) => length(text) > CHANNEL_INSTRUCTIONS_MAX

/** The texts that one turn of an agent reads (spec 002, "Handbook"; spec 004, "Rules"; 030, "Goal"). */
export interface InstructionTexts {
  /** The handbook, or "" when the agent does not read it or the handbook is empty. */
  readonly handbook: string
  /**
   * The goals of the organizations of the agent, from the top organization down (spec 030,
   * "Goal"). Each one has the name of its organization. Absent or empty outside an organization.
   */
  readonly orgs?: readonly { readonly name: string; readonly text: string }[] | undefined
  /** The instructions of the agent. */
  readonly own: string
  /** The instructions of the channel of this turn, with its name; absent outside a channel. */
  readonly channel?: { readonly name: string; readonly text: string } | undefined
}

const present = (text: string) => text.trim() !== ""

const list = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`

/**
 * The instruction text of a turn. The handbook comes first, then the goals of the organizations of
 * the agent from the top down (spec 030, "Goal"), then the instructions of the agent, then the
 * instructions of the channel. The app tells the agent this order and that the later text wins when
 * two texts differ, and that the rules of the app win over all of them (spec 002).
 *
 * With only the own instructions, the text is the instructions as they are, so an agent that has
 * no handbook, no organization goal and no channel text sees nothing new.
 */
export const composeInstructions = (texts: InstructionTexts): string => {
  const handbook = present(texts.handbook) ? texts.handbook.trim() : ""
  const orgs = (texts.orgs ?? []).filter((o) => present(o.text))
  const channel = texts.channel && present(texts.channel.text) ? texts.channel : undefined
  if (!handbook && orgs.length === 0 && !channel) return texts.own
  const blocks: { readonly label: string; readonly phrase: string; readonly text: string }[] = []
  if (handbook) blocks.push({ label: "Handbook", phrase: "the handbook", text: handbook })
  for (const org of orgs) {
    const name = `the organization "${org.name}"`
    blocks.push({
      label: `Goal of ${name}`,
      phrase: `the goal of ${name}`,
      text: org.text.trim(),
    })
  }
  if (present(texts.own)) {
    blocks.push({
      label: "Your own instructions",
      phrase: "your own instructions",
      text: texts.own.trim(),
    })
  }
  if (channel) {
    const name = `the channel "${channel.name}"`
    blocks.push({
      label: `Instructions of ${name}`,
      phrase: `the instructions of ${name}`,
      text: channel.text.trim(),
    })
  }
  const intro =
    blocks.length > 1
      ? `Your instructions come in ${blocks.length} texts, in this order: ${list(
          blocks.map((b) => b.phrase),
        )}. When two texts say different things, the later text wins. The rules of the app always win over all of them.`
      : "The rules of the app always win over the text below."
  return [intro, ...blocks.map((b) => `${b.label}:\n${b.text}`)].join("\n\n")
}
