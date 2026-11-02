import { describe, expect, test } from "bun:test"
import { charLength } from "./agents.ts"
import { numberedSkillName, SKILL_NAME_MAX, skillName, skillNameKey } from "./skills.ts"

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
