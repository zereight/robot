import { describe, expect, test } from "bun:test"
import { charLength } from "./agents.ts"
import {
  numberedSkillName,
  SKILL_NAME_MAX,
  skillAfterAgentDelete,
  skillName,
  skillNameKey,
} from "./skills.ts"

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
