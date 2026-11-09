import { describe, expect, test } from "bun:test"
import { checkSkill, draftSkillFromWorkflow, SKILL_LEAN_MAX, shares } from "./skillFromWorkflow.ts"
import type { Skill } from "./skills.ts"
import type { WorkflowGraph, WorkflowNode } from "./workflows.ts"

const node = (n: number, patch: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: `n${n}`,
  number: n,
  kind: "text",
  name: `Node ${n}`,
  prompt: "",
  accountId: null,
  model: null,
  effort: null,
  backup: null,
  silentLimit: "follow",
  permission: null,
  continueOnFailure: false,
  question: "",
  threshold: 0.9,
  options: [],
  x: 0,
  y: 0,
  ...patch,
})

const line = (from: string, to: string) => ({
  id: `${from}-${to}`,
  from,
  to,
  source: { kind: "text" as const },
})

const flow = (name: string, document: string, graph: WorkflowGraph) => ({ name, document, graph })
const free = () => false

describe("draftSkillFromWorkflow: the draft (spec 017)", () => {
  test("one numbered step for each node, without template words", () => {
    const draft = draftSkillFromWorkflow(
      flow("Weekly", "Write the weekly report. Keep it short.", {
        nodes: [
          node(1, { prompt: "Collect the news." }),
          node(2, { prompt: "Summarize {{input}} for the team." }),
          node(3, { prompt: "Send {{input}}" }),
        ],
        connections: [line("n1", "n2"), line("n2", "n3")],
      }),
      free,
    )
    expect(draft.name).toBe("Weekly")
    expect(draft.description).toBe("Write the weekly report.")
    expect(draft.instructions).toBe("1. Collect the news.\n2. Summarize for the team.\n3. Send")
    expect(draft.instructions).not.toContain("{{")
  })

  test("a decision and an approval name the step that each answer goes to", () => {
    const draft = draftSkillFromWorkflow(
      flow("Review", "", {
        nodes: [
          node(1, {
            kind: "decision",
            question: "Is the text ready?",
            options: [
              { id: "y", label: "Yes" },
              { id: "n", label: "No" },
            ],
          }),
          node(2, { kind: "approval", question: "Send it?" }),
          node(3, { prompt: "Rewrite it." }),
        ],
        connections: [
          { id: "a", from: "n1", to: "n2", source: { kind: "option", optionId: "y" } },
          { id: "b", from: "n1", to: "n3", source: { kind: "option", optionId: "n" } },
          { id: "c", from: "n2", to: "n3", source: { kind: "verdict", verdict: "reject" } },
        ],
      }),
      free,
    )
    expect(draft.instructions).toBe(
      [
        "1. Is the text ready?",
        'If the answer is "Yes", go to step 2.',
        'If the answer is "No", go to step 3.',
        "2. Ask the user: Send it?",
        "If the user rejects it, go to step 3.",
        "3. Rewrite it.",
      ].join("\n"),
    )
    expect(draft.description).toBe("Do the steps of the workflow Review.")
  })

  test("a rejection with no connection stops, and an approval that skips ahead says so", () => {
    const draft = draftSkillFromWorkflow(
      flow("Gate", "", {
        nodes: [
          node(1, { kind: "approval", question: "Go?" }),
          node(2, { prompt: "Skipped." }),
          node(3, { prompt: "Done." }),
        ],
        connections: [
          { id: "a", from: "n1", to: "n3", source: { kind: "verdict", verdict: "approve" } },
        ],
      }),
      free,
    )
    expect(draft.instructions).toContain("If the user rejects it, stop.")
    expect(draft.instructions).toContain("If the user approves it, go to step 3.")
  })

  test("a node with no prompt gives its name", () => {
    const draft = draftSkillFromWorkflow(
      flow("X", "", { nodes: [node(1, { name: "Fetch" })], connections: [] }),
      free,
    )
    expect(draft.instructions).toBe("1. Fetch")
  })

  test("a taken name gets a number inside the 40 characters", () => {
    const long = "w".repeat(60)
    const taken = new Set(["w".repeat(40)])
    const draft = draftSkillFromWorkflow(
      flow(long, "", { nodes: [node(1)], connections: [] }),
      (n) => taken.has(n),
    )
    expect([...draft.name].length).toBeLessThanOrEqual(40)
    expect(draft.name.endsWith(" 2")).toBe(true)
  })

  test("the description holds at most 140 characters", () => {
    const draft = draftSkillFromWorkflow(
      flow("X", `${"long ".repeat(60)}.`, { nodes: [node(1)], connections: [] }),
      free,
    )
    expect([...draft.description].length).toBeLessThanOrEqual(140)
    expect(draft.description.endsWith("…")).toBe(true)
  })

  test("the draft holds no model, folder or mark of the workflow", () => {
    const draft = draftSkillFromWorkflow(
      flow("X", "", {
        nodes: [
          node(1, { prompt: "Do it.", model: "opus-9", effort: "high", continueOnFailure: true }),
        ],
        connections: [],
      }),
      free,
    )
    expect(draft.instructions).toBe("1. Do it.")
  })
})

describe("draftSkillFromWorkflow: the diet (spec 017)", () => {
  test("repeated lines, empty lines and doubled spaces go away, and the lengths show it", () => {
    const draft = draftSkillFromWorkflow(
      flow("X", "", {
        nodes: [
          node(1, { prompt: "Be  brief.\n\nBe brief.\nBe BRIEF." }),
          node(2, { prompt: "Be brief.\nCheck the facts." }),
        ],
        connections: [],
      }),
      free,
    )
    expect(draft.instructions).toBe("1. Be brief.\n2. Check the facts.")
    expect(draft.after).toBeLessThan(draft.before)
  })

  test("a secret becomes [redacted]", () => {
    const draft = draftSkillFromWorkflow(
      flow("X", "", {
        nodes: [
          node(1, { prompt: "Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now." }),
        ],
        connections: [],
      }),
      free,
    )
    expect(draft.instructions).toContain("[redacted]")
    expect(draft.instructions).not.toContain("sk-ant")
  })

  test("a draft that the diet did not change has equal lengths", () => {
    const draft = draftSkillFromWorkflow(
      flow("X", "", { nodes: [node(1, { prompt: "Do it." })], connections: [] }),
      free,
    )
    expect(draft.after).toBe(draft.before)
  })

  test("long prompts are cut to 4000 characters, step by step, and every step stays", () => {
    const sentence = "This sentence is a filler line for the test. "
    const nodes = [
      node(1, { prompt: "Short step." }),
      node(2, { prompt: sentence.repeat(120) }),
      node(3, { prompt: sentence.replace("filler", "second").repeat(120) }),
      node(4, { prompt: "Another short step." }),
    ]
    const draft = draftSkillFromWorkflow(flow("X", "", { nodes, connections: [] }), free)
    expect(draft.after).toBeLessThanOrEqual(SKILL_LEAN_MAX)
    expect(draft.instructions).toContain("1. Short step.")
    expect(draft.instructions).toContain("4. Another short step.")
    expect(draft.instructions).not.toContain("1. Short step.…")
    const [, two, three] = draft.instructions.split(/\n(?=\d\. )/)
    expect(two?.endsWith("…")).toBe(true)
    expect(three?.endsWith("…")).toBe(true)
    expect(draft.before).toBeGreaterThan(SKILL_LEAN_MAX)
  })

  test("the lines that name the next step are never cut", () => {
    const filler = "A filler sentence that repeats. ".repeat(300)
    const draft = draftSkillFromWorkflow(
      flow("X", "", {
        nodes: [
          node(1, {
            kind: "decision",
            question: filler,
            options: [
              { id: "y", label: "Yes" },
              { id: "n", label: "No" },
            ],
          }),
          node(2, { prompt: "End." }),
        ],
        connections: [
          { id: "a", from: "n1", to: "n2", source: { kind: "option", optionId: "y" } },
          { id: "b", from: "n1", to: "n2", source: { kind: "option", optionId: "n" } },
        ],
      }),
      free,
    )
    expect(draft.instructions).toContain('If the answer is "Yes", go to step 2.')
    expect(draft.instructions).toContain('If the answer is "No", go to step 2.')
    expect(draft.after).toBeLessThanOrEqual(SKILL_LEAN_MAX)
  })
})

describe("shares", () => {
  test("a text within an equal share stays whole and its spare room goes to the longer ones", () => {
    expect(shares([10, 500, 500], 100)).toEqual([10, 45, 45])
    expect(shares([10, 20], 100)).toEqual([10, 20])
  })
})

const skill = (patch: Partial<Skill> = {}): Skill => ({
  id: "s1",
  name: "Weekly summary",
  description: "Write the weekly summary.",
  instructions: "1. Do it.",
  enabled: true,
  createdAt: 0,
  ...patch,
})

const statusOf = (facts: ReturnType<typeof checkSkill>) =>
  Object.fromEntries(facts.map((f) => [f.id, f.status]))

describe("checkSkill (spec 017, the skill check)", () => {
  test("a good skill shows OK for every fact, in order", () => {
    const facts = checkSkill(skill(), [skill()])
    expect(facts.map((f) => f.id)).toEqual([
      "saved",
      "on",
      "listed",
      "slash",
      "loads",
      "noSecret",
      "lean",
    ])
    expect(facts.every((f) => f.status === "ok")).toBe(true)
  })

  test("a skill that is off fails On and Slash, and the others stay", () => {
    const off = skill({ enabled: false })
    const facts = checkSkill(off, [off])
    expect(statusOf(facts)).toMatchObject({
      saved: "ok",
      on: "fail",
      listed: "ok",
      slash: "fail",
      loads: "ok",
    })
    expect(facts[1]?.reason?.code).toBe("off")
  })

  test("an empty description fails Listed, and the slash still works", () => {
    const quiet = skill({ description: "" })
    const facts = checkSkill(quiet, [quiet])
    expect(facts[2]).toEqual({ id: "listed", status: "fail", reason: { code: "no_description" } })
    expect(facts[3]?.status).toBe("ok")
  })

  test("another skill with the same name, in other case, fails Slash and names that skill", () => {
    const a = skill()
    const b = skill({ id: "s2", name: "WEEKLY SUMMARY" })
    const facts = checkSkill(a, [a, b])
    expect(facts[3]).toEqual({
      id: "slash",
      status: "fail",
      reason: { code: "name_shared", params: { name: "WEEKLY SUMMARY" } },
    })
  })

  test("empty instructions fail Loads", () => {
    const empty = skill({ instructions: "  " })
    expect(checkSkill(empty, [empty])[4]?.status).toBe("fail")
  })

  test("a secret in the instructions or the description fails No secret", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"
    const a = skill({ instructions: `Use ${key}` })
    const b = skill({ description: `Key ${key}` })
    expect(checkSkill(a, [a])[5]?.reason?.code).toBe("secret_instructions")
    expect(checkSkill(b, [b])[5]?.reason?.code).toBe("secret_description")
  })

  test("5000 characters are Long, with the length, and no fact fails", () => {
    const big = skill({ instructions: "x".repeat(5000) })
    const facts = checkSkill(big, [big])
    expect(facts[6]).toEqual({
      id: "lean",
      status: "long",
      reason: { code: "long_instructions", params: { length: 5000 } },
    })
    expect(facts.some((f) => f.status === "fail")).toBe(false)
  })

  test("a skill that is not in the list fails Saved and the rest are not checked", () => {
    const facts = checkSkill(null, [])
    expect(facts[0]?.status).toBe("fail")
    expect(facts.slice(1).every((f) => f.status === "skipped")).toBe(true)
  })
})
