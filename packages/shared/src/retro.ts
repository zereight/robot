import { redactSecrets } from "./redact.ts"

/**
 * The retrospective of an organization (spec 030, "Retrospective"). An organization looks at the
 * work of its members in the last 7 days and proposes one to three changes to the instructions of an
 * agent or to a skill. The user saves a proposal or closes the form: nothing is saved here.
 *
 * This file holds the shape of the evidence, the text of the one request, and the parser of the
 * answer. It is pure, so a test can check that the request never carries a message, a prompt, a
 * thinking step or a tool output.
 */

/** The most proposals that one look back gives (spec 030, "Retrospective"). */
export const RETRO_MAX = 3
/** The reason of a "Not met" verdict that the request carries, cut at this many characters. */
export const RETRO_REASON_MAX = 160
/** The evidence line of a proposal holds this many characters at most. */
export const RETRO_EVIDENCE_MAX = 160

/** One piece of work that the retrospective reads: a label, a state, and the verdict of a part. */
export interface RetroWork {
  /** The label of the task, which the board and the chart already show (spec 024, 029). */
  readonly label: string
  readonly state: "done" | "blocked" | "failed"
  /** The verdict of the part of a channel, or null when the task is no part. */
  readonly verdict: "met" | "not_met" | null
  /** The reason of a verdict "Not met", or null. It is text of the lead, not of the user. */
  readonly verdictReason: string | null
}

/** What one look back reads. It holds no prompt, no message and no tool output. */
export interface RetroEvidence {
  /** The name of the organization and of each member that the node draws. */
  readonly organization: string
  readonly members: readonly string[]
  readonly work: readonly RetroWork[]
}

/** The words of the work in the request: one line for each piece, in the order given. */
export const retroWorkLines = (evidence: RetroEvidence): string[] =>
  evidence.work.map((w) => {
    const verdict =
      w.verdict === null
        ? ""
        : w.verdict === "met"
          ? " · verdict Met"
          : ` · verdict Not met: ${(w.verdictReason ?? "").slice(0, RETRO_REASON_MAX)}`
    return `- ${w.label} · ${w.state}${verdict}`
  })

/**
 * The one request of a look back (spec 030, "Retrospective"). It names the organization, its
 * members, and the labels and verdicts of the work. It holds no prompt, no message, no thinking and
 * no tool output, so it cannot carry outside content by accident.
 */
export const retroRequest = (evidence: RetroEvidence, known: readonly string[] = []): string => {
  const hide = (text: string) => redactSecrets(text, known)
  const lines = retroWorkLines(evidence).map(hide)
  return [
    `The organization: ${hide(evidence.organization)}`,
    `Its members: ${evidence.members.map(hide).join(", ")}`,
    "",
    "The work of its members in the last 7 days:",
    lines.length > 0 ? lines.join("\n") : "No work ended.",
  ].join("\n")
}

/** The system text of a look back. It asks for proposals and says what a proposal must hold. */
export const RETRO_SYSTEM = [
  "You look back at the work of an organization and propose changes that would make the next work better.",
  "You get the labels of the work and the verdicts of the parts. You do not get the messages and the files.",
  `Give one to ${RETRO_MAX} proposals, the most useful first. Each proposal is one of two kinds:`,
  '- "instructions": a new text for the instructions of one member. Give the whole text, not a diff.',
  '- "skill": a new skill for one member, with a name, a description of when to use it, and the instructions.',
  "Each proposal names the member it is for and the evidence it rests on, in one short line of counts.",
  "Propose a change only when the work shows what went wrong. When it does not, give no proposal.",
  "Answer with JSON only, as an array of objects with the fields kind, agent, evidence, and then",
  "text for instructions, or name, description and instructions for a skill.",
].join("\n")

/** One proposal that the user may save (spec 030, "Retrospective"). */
export type RetroProposal =
  | {
      readonly kind: "instructions"
      /** The member whose instructions change, by name. The user picks the agent in the profile. */
      readonly agent: string
      readonly evidence: string
      readonly text: string
    }
  | {
      readonly kind: "skill"
      readonly agent: string
      readonly evidence: string
      readonly name: string
      readonly description: string
      readonly instructions: string
    }

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/**
 * The proposals of an answer, or null when the answer holds none. An answer that is not JSON, or
 * that holds no proposal of a known kind with the text that its kind needs, gives null: the caller
 * then shows the reason of the spec and saves nothing.
 */
export const retroProposals = (answer: string): RetroProposal[] | null => {
  const start = answer.indexOf("[")
  const end = answer.lastIndexOf("]")
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(answer.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: RetroProposal[] = []
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue
    const item = raw as Record<string, unknown>
    const agent = text(item.agent)
    const evidence = text(item.evidence).slice(0, RETRO_EVIDENCE_MAX)
    if (agent === "") continue
    const kind = text(item.kind)
    if (kind === "instructions") {
      const body = text(item.text) !== "" ? text(item.text) : text(item.instructions)
      if (body === "") continue
      out.push({ kind: "instructions", agent, evidence, text: body })
    } else if (kind === "skill") {
      const name = text(item.name)
      const instructions = text(item.instructions)
      if (name === "" || instructions === "") continue
      out.push({
        kind: "skill",
        agent,
        evidence,
        name,
        description: text(item.description),
        instructions,
      })
    }
  }
  return out.length === 0 ? null : out.slice(0, RETRO_MAX)
}
