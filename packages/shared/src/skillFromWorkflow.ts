import { redactSecrets } from "./redact.ts"
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  type Skill,
  type SkillInput,
  skillMatchesQuery,
  skillName,
  skillNameKey,
} from "./skills.ts"
import { SKILL_PICKER_MAX } from "./workflowChat.ts"
import type { WorkflowGraph, WorkflowNode } from "./workflows.ts"

/** How many first letters of a name the check types after the slash. */
const SLASH_PROBE = 3

/** The longest instructions of a lean skill (spec 017, "Make a skill from a workflow"). */
export const SKILL_LEAN_MAX = 4000

/** A draft skill from a workflow, with the length of its instructions before and after the diet. */
export interface SkillDraft extends SkillInput {
  readonly before: number
  readonly after: number
}

const chars = (text: string) => [...text].length
const cut = (text: string, max: number) => [...text].slice(0, max).join("")

const TEMPLATE_WORDS = /\{\{\s*(?:input|trigger)\s*\}\}/g

/** The key that makes two lines equal for the diet: case and spaces do not count. */
const lineKey = (line: string) => line.replace(/\s+/g, " ").trim().toLocaleLowerCase()

/**
 * The diet of one text (spec 017, "Make a skill from a workflow", step 3): no template words, no
 * empty line, no line that repeats one in `seen`, no doubled spaces, no secret. `seen` collects
 * the lines, so a repeat in a later step goes away too.
 */
export const dietLines = (text: string, seen: Set<string>): string[] => {
  const lines: string[] = []
  for (const raw of redactSecrets(text.replace(TEMPLATE_WORDS, "")).split(/\r?\n/)) {
    const line = raw.replace(/(\S)[ \t]{2,}/g, "$1 ").trimEnd()
    if (line.trim() === "") continue
    const key = lineKey(line)
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(line)
  }
  return lines
}

const SENTENCE = /[^.!?。\n]+[.!?。]*\s*/g

/** The first sentences of `text` that fit `max` characters, ending with "…". */
const shorten = (text: string, max: number): string => {
  if (chars(text) <= max) return text
  const room = Math.max(1, max - 1)
  let out = ""
  for (const piece of text.match(SENTENCE) ?? []) {
    if (chars(out + piece.trimEnd()) > room) break
    out += piece
  }
  return `${(out.trimEnd() === "" ? cut(text, room) : out).trimEnd()}…`
}

/**
 * The room that each text may use when the texts share `budget` characters (spec 017, step 3): a
 * text within an equal share stays whole, and its spare room goes to the longer texts.
 */
export const shares = (lengths: readonly number[], budget: number): number[] => {
  const room = lengths.map(() => 0)
  let open = lengths.map((_, i) => i)
  let left = Math.max(0, budget)
  while (open.length > 0) {
    const share = Math.floor(left / open.length)
    const small = open.filter((i) => (lengths[i] as number) <= share)
    if (small.length === 0) {
      for (const i of open) room[i] = share
      break
    }
    for (const i of small) {
      room[i] = lengths[i] as number
      left -= lengths[i] as number
    }
    open = open.filter((i) => !small.includes(i))
  }
  return room
}

interface Step {
  /** Words before the body that the diet never cuts. */
  readonly lead: string
  /** The prompt or the question: the part that the diet may cut. */
  readonly body: string
  /** The lines that name the next step: the diet never cuts them. */
  readonly tail: string
}

const stepText = (n: number, step: Step, body: string) => `${n}. ${step.lead}${body}${step.tail}`

/** The steps of the workflow, one for each node, in the order of the node numbers. */
const stepsOf = (graph: WorkflowGraph, clean: (text: string) => string): Step[] => {
  const nodes = [...graph.nodes].sort((a, b) => a.number - b.number)
  const place = new Map(nodes.map((n, i) => [n.id, i + 1]))
  const target = (
    node: WorkflowNode,
    match: (c: WorkflowGraph["connections"][number]) => boolean,
  ) => graph.connections.find((c) => c.from === node.id && match(c))?.to
  const go = (id: string | undefined) => {
    const n = id === undefined ? undefined : place.get(id)
    return n === undefined ? "stop" : `go to step ${n}`
  }
  return nodes.map((node, i): Step => {
    const next = nodes[i + 1]?.id
    if (node.kind === "decision") {
      const lines = node.options.map(
        (o) =>
          `If the answer is "${o.label}", ${go(target(node, (c) => c.source.kind === "option" && c.source.optionId === o.id))}.`,
      )
      return { lead: "", body: clean(node.question), tail: `\n${lines.join("\n")}` }
    }
    if (node.kind === "approval") {
      const approve = target(
        node,
        (c) => c.source.kind === "verdict" && c.source.verdict === "approve",
      )
      const reject = target(
        node,
        (c) => c.source.kind === "verdict" && c.source.verdict === "reject",
      )
      const lines = [`If the user rejects it, ${go(reject)}.`]
      if (approve !== undefined && approve !== next)
        lines.push(`If the user approves it, ${go(approve)}.`)
      return { lead: "Ask the user: ", body: clean(node.question), tail: `\n${lines.join("\n")}` }
    }
    return { lead: "", body: clean(node.prompt) || node.name, tail: "" }
  })
}

/**
 * The draft skill of a workflow (spec 017, "Make a skill from a workflow"): the name, the
 * description, and one step for each node, cut by the diet. `taken` tells whether a skill name is in
 * use, ignoring case. It asks no model and sends nothing out.
 */
export const draftSkillFromWorkflow = (
  workflow: { readonly name: string; readonly graph: WorkflowGraph },
  taken: (name: string) => boolean,
): SkillDraft => {
  const base = cut(skillName(workflow.name), SKILL_NAME_MAX).trimEnd()
  let name = base
  for (let n = 2; taken(name); n++) {
    const tail = ` ${n}`
    name = cut(base, SKILL_NAME_MAX - chars(tail)).trimEnd() + tail
  }

  const stepNames = [...workflow.graph.nodes]
    .sort((x, y) => x.number - y.number)
    .map((n) => n.name.trim())
    .filter((n) => n !== "")
  const described = redactSecrets(
    `Do the steps of the workflow ${base}${stepNames.length > 0 ? `: ${stepNames.join(", ")}` : ""}.`,
  )
  const description =
    chars(described) > SKILL_DESCRIPTION_MAX
      ? `${cut(described, SKILL_DESCRIPTION_MAX - 1).trimEnd()}…`
      : described

  const raw = stepsOf(workflow.graph, (t) => t.trim())
  const before = raw.map((s, i) => stepText(i + 1, s, s.body)).join("\n")

  const seen = new Set<string>()
  const lean = stepsOf(workflow.graph, (t) => dietLines(t, seen).join("\n"))
  const full = lean.map((s, i) => stepText(i + 1, s, s.body)).join("\n")
  let instructions = full
  if (chars(full) > SKILL_LEAN_MAX) {
    const fixed = lean.map((s, i) => chars(stepText(i + 1, s, "")))
    const budget = SKILL_LEAN_MAX - fixed.reduce((a, b) => a + b, 0) - (lean.length - 1)
    const room = shares(
      lean.map((s) => chars(s.body)),
      budget,
    )
    instructions = lean
      .map((s, i) => stepText(i + 1, s, shorten(s.body, room[i] as number)))
      .join("\n")
  }
  return { name, description, instructions, before: chars(before), after: chars(instructions) }
}

export type SkillFactId = "saved" | "on" | "listed" | "slash" | "loads" | "noSecret" | "lean"

export const SKILL_FACTS: readonly SkillFactId[] = [
  "saved",
  "on",
  "listed",
  "slash",
  "loads",
  "noSecret",
  "lean",
]

/** What one fact of the skill check shows (spec 017, "Skill check"). */
export interface SkillFactResult {
  readonly id: SkillFactId
  readonly status: "ok" | "fail" | "long" | "skipped"
  /** Why the fact is not "ok": a code for the interface text, and the words it names. */
  readonly reason?: {
    readonly code: SkillFactReason
    readonly params?: Readonly<Record<string, string | number>>
  }
}

export type SkillFactReason =
  | "missing"
  | "off"
  | "no_description"
  | "name_shared"
  | "empty"
  | "secret_instructions"
  | "secret_description"
  | "long_instructions"
  | "long_description"

const ok = (id: SkillFactId): SkillFactResult => ({ id, status: "ok" })
const no = (
  id: SkillFactId,
  status: "fail" | "long",
  code: SkillFactReason,
  params?: Record<string, string | number>,
): SkillFactResult => ({ id, status, reason: params ? { code, params } : { code } })

/**
 * The skill check (spec 017, "Skill check"): facts about one skill and the other skills of its
 * server, in the order of `SKILL_FACTS`. `skill` is null when the skill is not in the list. It
 * reads only, and asks no model.
 */
export const checkSkill = (
  skill: Skill | null,
  skills: readonly Skill[],
): readonly SkillFactResult[] => {
  if (skill === null)
    return SKILL_FACTS.map((id) =>
      id === "saved" ? no(id, "fail", "missing") : { id, status: "skipped" as const },
    )
  const key = skillNameKey(skill.name)
  const same = skills.find((s) => s.id !== skill.id && skillNameKey(s.name) === key)
  const shown = skills
    .filter((s) => s.enabled)
    .filter((s) => skillMatchesQuery(s.name, cut(skillName(skill.name), SLASH_PROBE)))
    .slice(0, SKILL_PICKER_MAX)
    .some((s) => s.id === skill.id)
  const secretIn = redactSecrets(skill.instructions) !== skill.instructions
  const secretDesc = redactSecrets(skill.description) !== skill.description
  return [
    ok("saved"),
    skill.enabled ? ok("on") : no("on", "fail", "off"),
    skill.description.trim() === "" ? no("listed", "fail", "no_description") : ok("listed"),
    same
      ? no("slash", "fail", "name_shared", { name: same.name })
      : !skill.enabled
        ? no("slash", "fail", "off")
        : shown
          ? ok("slash")
          : no("slash", "fail", "missing"),
    skill.instructions.trim() === "" ? no("loads", "fail", "empty") : ok("loads"),
    secretIn
      ? no("noSecret", "fail", "secret_instructions")
      : secretDesc
        ? no("noSecret", "fail", "secret_description")
        : ok("noSecret"),
    chars(skill.instructions) > SKILL_LEAN_MAX
      ? no("lean", "long", "long_instructions", { length: chars(skill.instructions) })
      : chars(skill.description) > SKILL_DESCRIPTION_MAX
        ? no("lean", "long", "long_description", { length: chars(skill.description) })
        : ok("lean"),
  ]
}
