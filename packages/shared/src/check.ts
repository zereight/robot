import type { TaskState } from "./task.ts"

// ---------------------------------------------------------------------------------------------
// The done test, the verdict and the check of the lead (spec 004, 005).
// ---------------------------------------------------------------------------------------------

/** A done test is one line of up to 200 characters. */
export const DONE_TEST_MAX = 200
/** The reason of a verdict "Not met" is up to 160 characters. */
export const VERDICT_REASON_MAX = 160
/** The lead looks at a channel at most this many times after a message of the user. */
export const LOOKS_MAX = 3
/** The last messages of the channel that the lead reads, and the cut of each one. */
export const CHECK_MESSAGES = 12
export const CHECK_MESSAGE_MAX = 600
/** The end of the last reply of a member that the lead reads for a part, in characters. */
export const CHECK_REPLY_MAX = 1500
/** A nudge or a question of the lead is cut at this many characters. */
export const CHECK_TEXT_MAX = 2000

export const VERDICTS = ["met", "not_met"] as const
export type Verdict = (typeof VERDICTS)[number]
export const isVerdict = (value: unknown): value is Verdict =>
  typeof value === "string" && (VERDICTS as readonly string[]).includes(value)

/** The first `max` characters of a text. A character is a code point. */
export const cutChars = (text: string, max: number) => {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join("") : text
}

/** The last `max` characters of a text. */
export const endChars = (text: string, max: number) => {
  const chars = [...text]
  return chars.length > max ? chars.slice(chars.length - max).join("") : text
}

/**
 * A done test from what the lead wrote: one line, up to 200 characters. Line breaks become
 * spaces. Gives null for nothing, or for text that is not a string.
 */
export const cleanDoneTest = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null
  const line = raw.replace(/\s+/g, " ").trim()
  return line === "" ? null : cutChars(line, DONE_TEST_MAX)
}

/** The reason of a verdict "Not met": up to 160 characters on one line. Null for no reason. */
export const cleanReason = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null
  const line = raw.replace(/\s+/g, " ").trim()
  return line === "" ? null : cutChars(line, VERDICT_REASON_MAX)
}

/**
 * The text that a member gets with a part. The done test sits before the prompt, so the prompt
 * stays the last line.
 */
export const partText = (label: string, prompt: string, doneTest: string | null) =>
  [`Your part: ${label}`, ...(doneTest ? [`Done test: ${doneTest}`] : []), prompt].join("\n")

/** What the verdict of a part needs: it is done, it has a done test, no verdict, no decision. */
export interface JudgeFacts {
  readonly state: TaskState
  readonly doneTest: string | null
  readonly verdict: Verdict | null
  /** When the user decided on the part (accept, request changes). Null when the user did not. */
  readonly decidedAt: number | null
}

/**
 * True when the check gives a verdict to this part. A part that failed, was blocked or was
 * cancelled gets none. A part with no done test gets none. A part that the user decided on gets
 * none: the decision of the user is final. A later check gives a verdict to a part that has none.
 */
export const needsVerdict = (part: JudgeFacts) =>
  part.state === "done" &&
  part.doneTest !== null &&
  part.verdict === null &&
  part.decidedAt === null

// ---------------------------------------------------------------------------------------------
// The answer of the lead.
// ---------------------------------------------------------------------------------------------

export interface GivenVerdict {
  /** The number of the part in the state that the lead read, from 1. */
  readonly part: number
  readonly verdict: Verdict
  readonly reason: string | null
}

export type CheckAction =
  | {
      readonly kind: "nudge"
      /** The part to nudge, by number. Null when the lead named the member only. */
      readonly part: number | null
      readonly member: string | null
      readonly instruction: string
    }
  | { readonly kind: "ask"; readonly question: string }
  | { readonly kind: "nothing" }

export interface CheckAnswer {
  readonly verdicts: readonly GivenVerdict[]
  readonly action: CheckAction
}

const NOTHING: CheckAction = { kind: "nothing" }

const partNumber = (value: unknown): number | null => {
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null
}

const readVerdict = (value: unknown): Verdict | null => {
  if (typeof value !== "string") return null
  const word = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
  if (word === "met") return "met"
  return word === "not_met" || word === "notmet" ? "not_met" : null
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? cutChars(value.trim(), CHECK_TEXT_MAX) : null

/**
 * Reads the answer of the lead to a check. The answer is one JSON object (a code fence around it
 * is fine). Gives null when it cannot be read: the lead then "cannot answer" and the parts keep no
 * verdict. An action that is missing or unknown, or that lacks its text, counts as "nothing".
 */
export const parseCheck = (reply: string): CheckAnswer | null => {
  const trimmed = reply.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let data: unknown
  try {
    data = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  const object = data as Record<string, unknown>
  const verdicts: GivenVerdict[] = []
  const seen = new Set<number>()
  if (Array.isArray(object.verdicts)) {
    for (const item of object.verdicts) {
      const { part, verdict, reason } = (item ?? {}) as Record<string, unknown>
      const number = partNumber(part)
      const value = readVerdict(verdict)
      if (number === null || value === null || seen.has(number)) continue
      seen.add(number)
      verdicts.push({
        part: number,
        verdict: value,
        reason: value === "met" ? null : cleanReason(reason),
      })
    }
  }
  const action = readAction(object)
  return { verdicts, action }
}

const readAction = (object: Record<string, unknown>): CheckAction => {
  const word = typeof object.action === "string" ? object.action.trim().toLowerCase() : ""
  if (word === "nudge") {
    const instruction = text(object.instruction)
    if (!instruction) return NOTHING
    const part = partNumber(object.part)
    const member =
      typeof object.member === "string" && object.member.trim() ? object.member.trim() : null
    if (part === null && member === null) return NOTHING
    return { kind: "nudge", part, member, instruction }
  }
  if (word === "ask") {
    const question = text(object.question)
    return question ? { kind: "ask", question } : NOTHING
  }
  return NOTHING
}

// ---------------------------------------------------------------------------------------------
// What the lead may do (spec 004, "Check by the lead").
// ---------------------------------------------------------------------------------------------

export interface NudgeFacts {
  readonly state: TaskState
  readonly verdict: Verdict | null
  readonly decidedAt: number | null
  /** The part was nudged, or it is a part that a nudge started. */
  readonly nudged: boolean
}

export type NudgeRefusal = "decided" | "stopped" | "open" | "again"

/**
 * Why the lead may not nudge this part, or null when it may. A part that the user decided on is
 * final. A part that the user stopped was stopped on purpose. A part that has not ended cannot be
 * nudged. A part that has the verdict "Not met" and was nudged already is not nudged again for
 * that reason: the lead then asks, or does nothing.
 */
export const nudgeRefusal = (part: NudgeFacts): NudgeRefusal | null => {
  if (part.decidedAt !== null) return "decided"
  if (part.state === "cancelled") return "stopped"
  if (part.state !== "done" && part.state !== "failed" && part.state !== "blocked") return "open"
  if (part.verdict === "not_met" && part.nudged) return "again"
  return null
}

export interface LinkedPart {
  readonly id: string
  /** The earlier part that this part tries again (a nudge, a retry or a change). */
  readonly retryOf: string | null
  readonly state: TaskState
  readonly verdict: Verdict | null
}

/**
 * The parts that have the verdict "Not met" and that no later part fixed (spec 004, flow 5). A
 * later part fixed a part when it follows it through the links of retries, is done, and has the
 * verdict "Met". The summary names these parts.
 */
export const stillNotMet = (parts: readonly LinkedPart[]): string[] => {
  const later = new Map<string, LinkedPart[]>()
  for (const part of parts) {
    if (part.retryOf === null) continue
    later.set(part.retryOf, [...(later.get(part.retryOf) ?? []), part])
  }
  const fixed = (id: string, seen = new Set<string>()): boolean =>
    (later.get(id) ?? []).some((next) => {
      if (seen.has(next.id)) return false
      seen.add(next.id)
      return (next.state === "done" && next.verdict === "met") || fixed(next.id, seen)
    })
  return parts.filter((p) => p.verdict === "not_met" && !fixed(p.id)).map((p) => p.id)
}
