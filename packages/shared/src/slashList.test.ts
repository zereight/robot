import { describe, expect, test } from "bun:test"
import { SLASH_SKILLS_MAX, slashItems, slashQuery } from "./slashList.ts"

const skill = (name: string) => ({ name })

describe("the slash list (spec 003, flow 7)", () => {
  test("only a slash as the first character opens it", () => {
    expect(slashQuery("/")).toBe("")
    expect(slashQuery("/We")).toBe("we")
    expect(slashQuery("a /we")).toBeNull()
    expect(slashQuery("~/notes/todo")).toBeNull()
    expect(slashQuery("/two words")).toBeNull()
    expect(slashItems("~/notes/todo", [skill("notes")])).toEqual([])
  })

  test("the commands come first, then the skills", () => {
    const items = slashItems("/", [skill("Weekly summary"), skill("Check a claim")])
    expect(
      items.map((item) => (item.kind === "command" ? `/${item.command}` : item.skill.name)),
    ).toEqual(["/compact", "Weekly summary", "Check a claim"])
  })

  test("a skill that holds the typed letters still comes after the commands", () => {
    const items = slashItems("/com", [skill("Compare files"), skill("Run a compile")])
    expect(items.map((item) => item.kind)).toEqual(["command", "skill", "skill"])
  })

  test("the list narrows: names that start with the text come before names that hold it", () => {
    const items = slashItems("/we", [skill("Every week"), skill("Weekly summary"), skill("Other")])
    expect(items.map((item) => (item.kind === "skill" ? item.skill.name : ""))).toEqual([
      "Weekly summary",
      "Every week",
    ])
  })

  test("the text ignores letter case", () => {
    expect(slashItems("/COMP", [])).toEqual([{ kind: "command", command: "compact" }])
    expect(slashItems("/WEEK", [skill("weekly")]).map((item) => item.kind)).toEqual(["skill"])
  })

  test("a text that matches nothing gives an empty list", () => {
    expect(slashItems("/zzz", [skill("Weekly summary")])).toEqual([])
  })

  test("at most 30 skills show, and the commands do not count", () => {
    const many = Array.from({ length: 45 }, (_, n) => skill(`Skill ${n}`))
    const items = slashItems("/", many)
    expect(items.filter((item) => item.kind === "skill")).toHaveLength(SLASH_SKILLS_MAX)
    expect(items.filter((item) => item.kind === "command")).toHaveLength(1)
  })
})
