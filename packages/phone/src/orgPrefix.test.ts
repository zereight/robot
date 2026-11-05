import { describe, expect, test } from "bun:test"
import { agentOrgNames, phoneShownName, titleAfterName } from "./orgPrefix.ts"

const org = (id: string, name: string, memberIds: string[], parentId: string | null = null) => ({
  id,
  serverId: "s",
  name,
  memberIds,
  leadId: null,
  parentId,
  handOffRange: "inherit",
  dailyTokenLimit: null,
  createdAt: 1,
})

describe("the organization of each agent, for the cache (spec 036, 011)", () => {
  test("each member gets the whole name of its deepest organization", () => {
    const names = agentOrgNames([
      org("p", "Product", ["ada", "bo"]),
      org("d", "Docs", ["ada"], "p"),
      org("o", "Research and Development Group", ["cy"]),
    ])
    expect(names).toEqual({ ada: "Docs", bo: "Product", cy: "Research and Development Group" })
  })

  test("an agent in no organization has no entry", () => {
    expect(agentOrgNames([org("p", "Product", ["ada"])])).toEqual({ ada: "Product" })
    expect(agentOrgNames([])).toEqual({})
  })

  test("an answer that is not a list gives null, so the cache keeps what it has", () => {
    expect(agentOrgNames(undefined)).toBeNull()
    expect(agentOrgNames({ code: "not_allowed" })).toBeNull()
    expect(agentOrgNames("x")).toBeNull()
  })

  test("a bad entry is skipped; the others count", () => {
    const names = agentOrgNames([
      null,
      { id: 1, name: "x", memberIds: [] },
      { id: "q", name: "Q", memberIds: "ada" },
      org("d", "Docs", ["ada", 7 as unknown as string]),
    ])
    expect(names).toEqual({ ada: "Docs" })
  })
})

describe("the shown name on the phone (spec 036)", () => {
  const names = { ada: "Research and Development Group" }

  test("with the switch on: prefix, note text and accessible name", () => {
    const shown = phoneShownName(names, true, "ada", "Ada")
    expect(shown.prefix).toBe("[Research and Dev…]")
    expect(shown.text).toBe("[Research and Dev…] Ada")
    expect(shown.label).toBe("Ada, Research and Development Group")
  })

  test("with the switch off, with no organization, or with no data: the name only", () => {
    expect(phoneShownName(names, false, "ada", "Ada").text).toBe("Ada")
    expect(phoneShownName(names, true, "bo", "Bo").text).toBe("Bo")
    expect(phoneShownName(null, true, "ada", "Ada").text).toBe("Ada")
    expect(phoneShownName(undefined, true, "ada", "Ada").prefix).toBeNull()
  })

  test("an agent id that is a name of Object does not find an organization", () => {
    expect(phoneShownName({}, true, "constructor", "X").prefix).toBeNull()
    expect(phoneShownName({}, true, "toString", "X").prefix).toBeNull()
  })
})

describe("the title of a card of Needs you (spec 036, 011)", () => {
  test("the name alone, or the name and the computer, gives the rest after the name", () => {
    expect(titleAfterName("Ada", "Ada")).toBe("")
    expect(titleAfterName("Ada · Studio", "Ada")).toBe(" · Studio")
  })

  test("a title that does not start with the name is kept as it is", () => {
    expect(titleAfterName("Ada L", "Ada")).toBeNull()
    expect(titleAfterName("Bo", "Ada")).toBeNull()
    expect(titleAfterName("", "Ada")).toBeNull()
  })
})
