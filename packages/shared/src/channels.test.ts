import { describe, expect, test } from "bun:test"
import { parseMentions, parsePlan, planText, stepLabel } from "./channels.ts"

describe("mentions", () => {
  const names = ["Ada", "Ada Lovelace", "Bo"]
  test("finds @Name, ignoring case, and prefers the longer name", () => {
    expect(parseMentions("hey @ada, look", names)).toEqual(["Ada"])
    expect(parseMentions("@Ada Lovelace please", names)).toEqual(["Ada Lovelace"])
    expect(parseMentions("@bo and @Ada", names)).toEqual(["Ada", "Bo"])
  })
  test("ignores a name inside a word and a name without @", () => {
    expect(parseMentions("mail me@Bo.com", names)).toEqual([])
    expect(parseMentions("@Adam is not Ada", names)).toEqual([])
    expect(parseMentions("Ada Bo", names)).toEqual([])
  })
  test("works with Korean names", () => {
    expect(parseMentions("@민지 부탁해", ["민지", "철수"])).toEqual(["민지"])
    expect(parseMentions("@민지야 부탁해", ["민지"])).toEqual([])
  })
})

describe("plans", () => {
  const members = ["Bo", "Cy"]
  test("reads a JSON plan, also inside a code fence", () => {
    const json =
      '{"plan":"Two parts","parts":[{"member":"bo","label":"Intro","prompt":"Write it"},{"member":"Cy","prompt":"Check\\nmore"}]}'
    for (const text of [json, `\`\`\`json\n${json}\n\`\`\``]) {
      const plan = parsePlan(text, members)
      expect(plan?.plan).toBe("Two parts")
      expect(plan?.parts).toEqual([
        { member: "Bo", label: "Intro", prompt: "Write it" },
        { member: "Cy", label: "Check", prompt: "Check\nmore" },
      ])
    }
    expect(planText(parsePlan(json, members) as never)).toBe(
      "Two parts\n\n1. Bo: Intro\n2. Cy: Check",
    )
  })
  test("an ordinary answer, bad JSON and unknown members are no plan", () => {
    expect(parsePlan("Here is my answer {not json}", members)).toBeNull()
    expect(parsePlan("{broken", members)).toBeNull()
    expect(parsePlan('{"parts":[{"member":"Zed","prompt":"x"}]}', members)).toBeNull()
    expect(parsePlan('{"parts":"no"}', members)).toBeNull()
  })
  test("keeps at most 8 parts", () => {
    const parts = Array.from({ length: 12 }, (_, i) => ({
      member: "Bo",
      label: `p${i}`,
      prompt: "x",
    }))
    expect(parsePlan(JSON.stringify({ parts }), members)?.parts).toHaveLength(8)
  })
  test("step labels are cut at 48 characters", () => {
    expect(stepLabel("short")).toBe("short")
    expect([...stepLabel("x".repeat(60))]).toHaveLength(48)
  })
})
