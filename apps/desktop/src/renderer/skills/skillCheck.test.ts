import { describe, expect, test } from "bun:test"
import { catalogues, SKILL_FACTS, type SkillFactResult } from "@robot/shared"
import { dietPercent, factKey, orderFacts, reasonText, statusKey } from "./skillCheck.ts"

const fact = (id: SkillFactResult["id"]): SkillFactResult => ({ id, status: "ok" })

describe("dietPercent", () => {
  test("names the saved part in percent", () => {
    expect(dietPercent(100, 60)).toBe(40)
    expect(dietPercent(400, 390)).toBe(3)
  })

  test("is null when the diet cut nothing", () => {
    expect(dietPercent(100, 100)).toBeNull()
    expect(dietPercent(100, 120)).toBeNull()
    expect(dietPercent(0, 0)).toBeNull()
  })
})

describe("orderFacts", () => {
  test("lists the facts in the order of SKILL_FACTS", () => {
    const shuffled = [...SKILL_FACTS].reverse().map(fact)
    expect(orderFacts(shuffled).map((f) => f.id)).toEqual([...SKILL_FACTS])
  })
})

describe("factKey and statusKey", () => {
  test("name every fact", () => {
    for (const id of SKILL_FACTS) expect(factKey(id)).toBe(`skills.check.fact.${id}`)
  })

  test("name every status", () => {
    expect(statusKey("ok")).toBe("skills.check.ok")
    expect(statusKey("fail")).toBe("skills.check.failed")
    expect(statusKey("long")).toBe("skills.check.long")
    expect(statusKey("skipped")).toBe("skills.check.skipped")
  })
})

describe("reasonText", () => {
  test("names the other skill", () => {
    expect(reasonText({ code: "name_shared", params: { name: "Weekly" } })).toEqual({
      key: "skills.check.reason.name_shared",
      params: { name: "Weekly" },
    })
  })

  test("a long text also names the allowed length", () => {
    expect(reasonText({ code: "long_instructions", params: { length: 5000 } })).toEqual({
      key: "skills.check.reason.long_instructions",
      params: { length: 5000, max: 4000 },
    })
    expect(reasonText({ code: "long_description", params: { length: 200 } })).toEqual({
      key: "skills.check.reason.long_description",
      params: { length: 200, max: 140 },
    })
  })

  test("a plain reason holds no values", () => {
    expect(reasonText({ code: "missing" })).toEqual({
      key: "skills.check.reason.missing",
      params: {},
    })
  })
})

describe("words of the skill check", () => {
  test("say what the check saw, never that the skill works", () => {
    const banned = /\b(works|verified|correct|tested)\b/i
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      for (const [key, text] of Object.entries(catalogue)) {
        if (!key.startsWith("skills.check.") && !key.startsWith("skills.draft.")) continue
        expect({ locale, key, hit: banned.test(text) }).toEqual({ locale, key, hit: false })
      }
    }
  })
})
