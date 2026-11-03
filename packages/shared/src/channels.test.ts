import { describe, expect, test } from "bun:test"
import { mentionsEveryone, parseMentions, parsePlan, planText, stepLabel } from "./channels.ts"

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

describe("everyone mention", () => {
  test("finds @all, ignoring case, at the start or after a space or a mark", () => {
    expect(mentionsEveryone("@all please look")).toBe(true)
    expect(mentionsEveryone("hey @ALL, look")).toBe(true)
    expect(mentionsEveryone("look\n@All")).toBe(true)
    expect(mentionsEveryone("(@all)")).toBe(true)
  })
  test("ignores @all inside a word, a longer word and a word with no @", () => {
    expect(mentionsEveryone("mail me@all.com")).toBe(false)
    expect(mentionsEveryone("@allan please")).toBe(false)
    expect(mentionsEveryone("@all_hands")).toBe(false)
    expect(mentionsEveryone("all of you")).toBe(false)
  })
  test("works after Korean text", () => {
    expect(mentionsEveryone("다들 @all 봐줘")).toBe(true)
    expect(mentionsEveryone("다들@all 봐줘")).toBe(false)
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
        { member: "Bo", label: "Intro", prompt: "Write it", doneTest: null },
        { member: "Cy", label: "Check", prompt: "Check\nmore", doneTest: null },
      ])
    }
    expect(planText(parsePlan(json, members) as never)).toBe(
      "Two parts\n\n1. Bo: Intro\n2. Cy: Check",
    )
  })
  test("a part may carry a done test: one line, up to 200 characters", () => {
    const long = "x".repeat(250)
    const plan = parsePlan(
      JSON.stringify({
        plan: "Parts",
        parts: [
          { member: "Bo", label: "A", prompt: "Do A", doneTest: "Holds a title\nand a date" },
          { member: "Cy", label: "B", prompt: "Do B", done_test: long },
          { member: "Bo", label: "C", prompt: "Do C", doneTest: "   " },
          { member: "Cy", label: "D", prompt: "Do D", doneTest: 7 },
        ],
      }),
      members,
    )
    expect(plan?.parts.map((p) => p.doneTest)).toEqual([
      "Holds a title and a date",
      "x".repeat(200),
      null,
      null,
    ])
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
