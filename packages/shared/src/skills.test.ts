import { describe, expect, test } from "bun:test"
import { charLength } from "./agents.ts"
import {
  copySkillName,
  numberedSkillName,
  SKILL_NAME_MAX,
  type Skill,
  skillAfterAgentDelete,
  skillListLead,
  skillName,
  skillNameKey,
  skillPickSource,
} from "./skills.ts"
import { TASK_SOURCES, type TaskSource } from "./task.ts"

describe("skill names", () => {
  test("a slash at the start and spaces at both ends are removed", () => {
    expect(skillName("  /Weekly summary ")).toBe("Weekly summary")
    expect(skillNameKey("/Weekly Summary")).toBe(skillNameKey("weekly summary"))
  })

  test("a taken name gets a number, ignoring case", () => {
    const taken = new Set([skillNameKey("Check a claim")])
    const is = (name: string) => taken.has(skillNameKey(name))
    expect(numberedSkillName("Other", is)).toBe("Other")
    expect(numberedSkillName("check a CLAIM", is)).toBe("check a CLAIM 2")
    taken.add(skillNameKey("Check a claim 2"))
    expect(numberedSkillName("Check a claim", is)).toBe("Check a claim 3")
  })

  test("the number stays inside the length limit", () => {
    const long = "x".repeat(SKILL_NAME_MAX)
    const taken = new Set([skillNameKey(long)])
    const name = numberedSkillName(long, (candidate) => taken.has(skillNameKey(candidate)))
    expect(charLength(name)).toBeLessThanOrEqual(SKILL_NAME_MAX)
    expect(name.endsWith(" 2")).toBe(true)
  })
})

describe("the name of a copy (spec 017, flow 3)", () => {
  const names = (...list: string[]) => {
    const taken = new Set(list.map(skillNameKey))
    return (candidate: string) => taken.has(skillNameKey(candidate))
  }

  test("the copy gets the word of the interface language", () => {
    expect(copySkillName("Weekly summary", " copy", names())).toBe("Weekly summary copy")
    expect(copySkillName("주간 요약", " 사본", names())).toBe("주간 요약 사본")
  })

  test("a copy name that is taken gets a number, ignoring case", () => {
    const taken = names("Weekly summary copy", "weekly summary COPY 2")
    expect(copySkillName("Weekly summary", " copy", taken)).toBe("Weekly summary copy 3")
  })

  test("a slash at the start of the name is not kept", () => {
    expect(copySkillName("/Weekly summary", " copy", names())).toBe("Weekly summary copy")
  })

  test("a long name is cut so that the copy fits the limit", () => {
    const copy = copySkillName("x".repeat(SKILL_NAME_MAX), " copy", names())
    expect(charLength(copy)).toBe(SKILL_NAME_MAX)
    expect(copy.endsWith(" copy")).toBe(true)
    const again = copySkillName("x".repeat(SKILL_NAME_MAX), " copy", names(copy))
    expect(charLength(again)).toBeLessThanOrEqual(SKILL_NAME_MAX)
    expect(again.endsWith(" copy 2")).toBe(true)
  })
})

describe("a skill when an agent is deleted (spec 017)", () => {
  const alive = new Set(["b", "c"])
  const exists = (id: string) => alive.has(id)

  test("a skill for all agents stays", () => {
    expect(skillAfterAgentDelete(null, "a", exists)).toEqual({ kind: "same" })
  })

  test("a skill that does not name the agent stays", () => {
    expect(skillAfterAgentDelete(["b", "c"], "a", exists)).toEqual({ kind: "same" })
  })

  test("the agent leaves the list of a skill that names other agents too", () => {
    expect(skillAfterAgentDelete(["a", "b"], "a", exists)).toEqual({
      kind: "shorter",
      agentIds: ["b"],
    })
  })

  test("a skill that was only for the agent is deleted", () => {
    expect(skillAfterAgentDelete(["a"], "a", exists)).toEqual({ kind: "delete" })
  })

  test("an agent that went before this rule does not keep a skill alive", () => {
    expect(skillAfterAgentDelete(["gone", "a"], "a", exists)).toEqual({ kind: "delete" })
    expect(skillAfterAgentDelete(["gone", "a", "c"], "a", exists)).toEqual({
      kind: "shorter",
      agentIds: ["gone", "c"],
    })
  })
})

describe("the skill list of a turn (spec 017, flow 8)", () => {
  const skill = (name: string, description: string, instructions = "STEPS"): Skill => ({
    id: name,
    name,
    description,
    instructions,
    agentIds: null,
    enabled: true,
    createdAt: 0,
  })

  test("the list holds names and notes, never the instructions", () => {
    const lead = skillListLead([
      skill("Weekly summary", "Ask for a briefing now."),
      skill("Check a claim", "Check one claim.", "OTHER STEPS"),
    ])
    expect(lead).toContain('"Weekly summary": Ask for a briefing now.')
    expect(lead).toContain('"Check a claim": Check one claim.')
    expect(lead).toContain("read_skill")
    expect(lead).not.toContain("STEPS")
    expect(lead).not.toContain("OTHER")
  })

  test("a skill with an empty note stays out, for slash use only", () => {
    expect(skillListLead([skill("Hidden", "   ")])).toBe("")
    expect(skillListLead([])).toBe("")
    const lead = skillListLead([skill("Hidden", ""), skill("Shown", "Use me.")])
    expect(lead).not.toContain("Hidden")
    expect(lead).toContain('"Shown": Use me.')
  })

  test("only direct chats and threads read the list", () => {
    const yes: TaskSource[] = ["chat", "handover", "teams", "follow_up"]
    for (const source of TASK_SOURCES) expect(skillPickSource(source)).toBe(yes.includes(source))
  })
})
