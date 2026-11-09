import {
  type MessageKey,
  type MessageParams,
  SKILL_DESCRIPTION_MAX,
  SKILL_FACTS,
  SKILL_LEAN_MAX,
  type SkillFactId,
  type SkillFactReason,
  type SkillFactResult,
} from "@robot/shared"

/**
 * The saved part of the diet in percent, or null when the diet cut nothing (spec 017, "Make a
 * skill from a workflow", step 3). The card shows "Nothing to cut." instead of the line.
 */
export const dietPercent = (before: number, after: number): number | null => {
  if (before <= 0 || after >= before) return null
  return Math.round(((before - after) / before) * 100)
}

/** The facts in the order of `SKILL_FACTS` (spec 017, "Skill check", step 2). */
export const orderFacts = (facts: readonly SkillFactResult[]): readonly SkillFactResult[] =>
  [...facts].sort((a, b) => SKILL_FACTS.indexOf(a.id) - SKILL_FACTS.indexOf(b.id))

const FACT_KEYS: Record<SkillFactId, MessageKey> = {
  saved: "skills.check.fact.saved",
  on: "skills.check.fact.on",
  listed: "skills.check.fact.listed",
  slash: "skills.check.fact.slash",
  loads: "skills.check.fact.loads",
  noSecret: "skills.check.fact.noSecret",
  lean: "skills.check.fact.lean",
}

/** The label of one fact of the skill check. */
export const factKey = (id: SkillFactId): MessageKey => FACT_KEYS[id]

const STATUS_KEYS: Record<SkillFactResult["status"], MessageKey> = {
  ok: "skills.check.ok",
  fail: "skills.check.failed",
  long: "skills.check.long",
  skipped: "skills.check.skipped",
}

/** The word for one status of the skill check. "Long" is not a failure (spec 017). */
export const statusKey = (status: SkillFactResult["status"]): MessageKey => STATUS_KEYS[status]

const REASON_KEYS: Record<SkillFactReason, MessageKey> = {
  missing: "skills.check.reason.missing",
  off: "skills.check.reason.off",
  no_description: "skills.check.reason.no_description",
  name_shared: "skills.check.reason.name_shared",
  empty: "skills.check.reason.empty",
  secret_instructions: "skills.check.reason.secret_instructions",
  secret_description: "skills.check.reason.secret_description",
  long_instructions: "skills.check.reason.long_instructions",
  long_description: "skills.check.reason.long_description",
}

/**
 * The short sentence for one reason of the skill check, with the words it names. A long text also
 * names the length that "Lean" allows, which the check itself does not send.
 */
export const reasonText = (
  reason: NonNullable<SkillFactResult["reason"]>,
): {
  readonly key: MessageKey
  readonly params: MessageParams
} => {
  const params: Record<string, string | number> = { ...reason.params }
  if (reason.code === "long_instructions") params.max = SKILL_LEAN_MAX
  if (reason.code === "long_description") params.max = SKILL_DESCRIPTION_MAX
  return { key: REASON_KEYS[reason.code], params }
}
