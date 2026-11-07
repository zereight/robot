/** Skills (spec 017): saved instructions that the user calls in a chat. */

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

/** What the agent reads before the text of a message with a skill chip. */
export const skillLead = (name: string, instructions: string) =>
  `Use the skill "${name}". Its instructions:\n${instructions}`

/**
 * What the agent reads about its skills at the start of a turn (spec 017, flow 8): the names and
 * the notes, never the instructions. A skill with an empty note stays out: it is for slash use
 * only. Empty when no skill has a note, so the turn runs as before.
 */
export const skillListLead = (skills: readonly Skill[]): string => {
  const noted = skills.filter((s) => s.description.trim() !== "")
  if (noted.length === 0) return ""
  const lines = noted.map((s) => `- "${s.name}": ${s.description.trim()}`)
  return `Skills you may use in this chat. Read the instructions of one with the tool "read_skill" when its note fits the task. Read only the skills that the task needs, one at a time:\n${lines.join("\n")}`
}
