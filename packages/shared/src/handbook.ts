/**
 * The handbook (spec 002, "Handbook"): a text that an agent reads before its own instructions.
 * This file holds the limits, the shapes of the history, and the one rule for the order in which
 * the texts reach the agent.
 */

/** The handbook holds 0 to 20000 characters (spec 002). */
export const HANDBOOK_MAX = 20_000
/** The history of the handbook keeps the last 20 versions (spec 002). */
export const HANDBOOK_HISTORY_MAX = 20

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

/** The texts that one turn of an agent reads (spec 002, "Handbook"). */
export interface InstructionTexts {
  /** The handbook, or "" when the agent does not read it or the handbook is empty. */
  readonly handbook: string
  /** The instructions of the agent. */
  readonly own: string
}

const present = (text: string) => text.trim() !== ""

/**
 * The instruction text of a turn. The handbook comes first, then the instructions of the agent.
 * The app tells the agent this order and that the later text wins when two texts differ, and that
 * the rules of the app win over all of them (spec 002).
 *
 * With only the own instructions, the text is the instructions as they are, so an agent that has
 * no handbook sees nothing new.
 */
export const composeInstructions = (texts: InstructionTexts): string => {
  const handbook = present(texts.handbook) ? texts.handbook.trim() : ""
  if (!handbook) return texts.own
  const blocks: { readonly label: string; readonly phrase: string; readonly text: string }[] = [
    { label: "Handbook", phrase: "the handbook", text: handbook },
  ]
  if (present(texts.own)) {
    blocks.push({
      label: "Your own instructions",
      phrase: "your own instructions",
      text: texts.own.trim(),
    })
  }
  const intro =
    blocks.length > 1
      ? `Your instructions come in ${blocks.length} texts, in this order: ${blocks
          .map((b) => b.phrase)
          .join(
            " and ",
          )}. When two texts say different things, the later text wins. The rules of the app always win over all of them.`
      : "The rules of the app always win over the text below."
  return [intro, ...blocks.map((b) => `${b.label}:\n${b.text}`)].join("\n\n")
}
