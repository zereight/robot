import { describe, expect, test } from "bun:test"
import {
  agentMayUse,
  orgGivers,
  orgToolEntries,
  orgToolNow,
  orgToolValue,
  withOrgSwitch,
} from "./orgTools.ts"
import type { TreeOrg } from "./orgTree.ts"

// Spec 030, "Tools": the list of a skill or a connection holds organizations with the value "On"
// (or "Off"). An organization that is not in the list has "Inherit": it takes the value of its
// parent. A member may use the tool when the value of an organization it is a member of is "On".

const org = (id: string, parentId: string | null = null): TreeOrg => ({ id, parentId })
// Product > Docs > Site, and Ops alone.
const tree = [org("product"), org("docs", "product"), org("site", "docs"), org("ops")]
const on = (id: string) => ({ id, value: "on" as const })
const off = (id: string) => ({ id, value: "off" as const })

describe("the stored list", () => {
  test("a list that cannot be read, or holds a wrong entry, gives only the right entries", () => {
    expect(orgToolEntries(null)).toEqual([])
    expect(orgToolEntries("nope")).toEqual([])
    expect(orgToolEntries("{}")).toEqual([])
    expect(
      orgToolEntries(
        JSON.stringify([
          { id: "a", value: "on" },
          { id: "b", value: "off" },
          { id: "c", value: "maybe" },
          { id: 7, value: "on" },
          "d",
          { id: "a", value: "off" },
        ]),
      ),
    ).toEqual([on("a"), off("b")])
  })
})

describe("the value of an organization for a tool", () => {
  test("an organization in the list has its own value", () => {
    expect(orgToolValue(tree, [on("product")], "product")).toEqual({ value: "on", from: "product" })
    expect(orgToolValue(tree, [off("product")], "product")).toEqual({
      value: "off",
      from: "product",
    })
  })

  test('"Inherit" takes the value of the parent, up to the top organization', () => {
    const list = [on("product")]
    expect(orgToolValue(tree, list, "docs")).toEqual({ value: "on", from: "product" })
    expect(orgToolValue(tree, list, "site")).toEqual({ value: "on", from: "product" })
    // A top organization with "Inherit" has no tool.
    expect(orgToolValue(tree, list, "ops")).toEqual({ value: null, from: null })
    expect(orgToolValue(tree, [], "site")).toEqual({ value: null, from: null })
  })

  test("a lower organization can set its own value, and it goes down", () => {
    // "Off" in "Docs" takes the tool from "Docs" and "Site"; "On" in "Site" gives it back.
    const list = [on("product"), off("docs")]
    expect(orgToolValue(tree, list, "product").value).toBe("on")
    expect(orgToolValue(tree, list, "docs")).toEqual({ value: "off", from: "docs" })
    expect(orgToolValue(tree, list, "site")).toEqual({ value: "off", from: "docs" })
    expect(orgToolValue(tree, [...list, on("site")], "site")).toEqual({
      value: "on",
      from: "site",
    })
  })
})

describe("who gets the tool from organizations", () => {
  test('a member of Site gets the skill that Product turns on, and the line names "Product"', () => {
    expect(orgGivers(tree, [on("product")], ["site"])).toEqual(["product"])
  })

  test("a member of two organizations gets it when one of them has the value On", () => {
    expect(orgGivers(tree, [on("ops")], ["site", "ops"])).toEqual(["ops"])
    expect(orgGivers(tree, [on("product")], ["ops"])).toEqual([])
    expect(orgGivers(tree, [on("product")], [])).toEqual([])
  })

  test('"Off" in Docs takes only what Docs would get from above; a member of Product keeps it', () => {
    const list = [on("product"), off("docs")]
    expect(orgGivers(tree, list, ["docs"])).toEqual([])
    expect(orgGivers(tree, list, ["site"])).toEqual([])
    expect(orgGivers(tree, list, ["product"])).toEqual(["product"])
    // A member of Docs that is also a member of Product keeps the skill.
    expect(orgGivers(tree, list, ["docs", "product"])).toEqual(["product"])
  })

  test('"On" in Site gives the skill back to the members of Site', () => {
    expect(orgGivers(tree, [on("product"), off("docs"), on("site")], ["site"])).toEqual(["site"])
  })

  test("each giver is named once, the nearest organization of the agent first", () => {
    const list = [on("product"), on("site")]
    expect(orgGivers(tree, list, ["site", "docs"])).toEqual(["site", "product"])
    expect(orgGivers(tree, list, ["docs", "site"])).toEqual(["product", "site"])
  })

  test("an organization that is gone gives nothing", () => {
    expect(orgGivers(tree, [on("gone")], ["site"])).toEqual([])
    expect(orgGivers(tree, [on("product")], ["gone"])).toEqual([])
  })
})

describe("the switch of an organization in a list", () => {
  test("On adds the organization, and a second On changes nothing", () => {
    const first = withOrgSwitch([], "product", "on")
    expect(first).toEqual([on("product")])
    expect(withOrgSwitch(first, "product", "on")).toEqual(first)
  })

  test("Inherit takes the organization out of the list; the others stay in place", () => {
    const list = [on("product"), on("site")]
    expect(withOrgSwitch(list, "product", "inherit")).toEqual([on("site")])
    expect(withOrgSwitch(list, "ops", "inherit")).toEqual(list)
  })

  test("Off changes the value of an organization that is in the list", () => {
    expect(withOrgSwitch([on("docs")], "docs", "off")).toEqual([off("docs")])
  })
})

describe("whether an agent may use a skill or a connection", () => {
  const may = (
    agentIds: readonly string[] | null,
    entries: ReturnType<typeof on>[],
    agentId: string,
    memberOf: string[],
  ) => agentMayUse({ agentIds, entries }, agentId, tree, memberOf)

  test("a member of Site gets the skill that Product turns on", () => {
    expect(may([], [on("product")], "a", ["site"])).toBe(true)
    expect(may([], [on("product")], "a", [])).toBe(false)
    expect(may([], [on("product")], "a", ["ops"])).toBe(false)
  })

  test('"Off" in Docs takes it from the members of Docs and Site, not from Product', () => {
    const list = [on("product"), off("docs")]
    expect(may([], list, "a", ["docs"])).toBe(false)
    expect(may([], list, "a", ["site"])).toBe(false)
    expect(may([], list, "a", ["product"])).toBe(true)
  })

  test('"On" in Site gives it back to the members of Site', () => {
    expect(may([], [on("product"), off("docs"), on("site")], "a", ["site"])).toBe(true)
  })

  test('a member of Docs and Product keeps it when Docs is "Off"', () => {
    expect(may([], [on("product"), off("docs")], "a", ["docs", "product"])).toBe(true)
  })

  test('"All agents" is on: "Off" takes nothing away', () => {
    expect(may(null, [off("docs")], "a", ["docs"])).toBe(true)
    expect(may(null, [], "a", [])).toBe(true)
  })

  test('the own entry of the agent stays when its organization is "Off"', () => {
    expect(may(["a"], [on("product"), off("docs")], "a", ["docs"])).toBe(true)
    expect(may(["b"], [on("product"), off("docs")], "a", ["docs"])).toBe(false)
  })

  test("a member that leaves Site loses the skill", () => {
    expect(may([], [on("product")], "a", ["site"])).toBe(true)
    expect(may([], [on("product")], "a", [])).toBe(false)
  })
})

describe('the muted line "Now" under "Inherit"', () => {
  test("it names the value and the organization that the nearest entry on the line gives", () => {
    expect(orgToolNow(tree, [on("product")], "site")).toEqual({ value: "on", from: "product" })
    expect(orgToolNow(tree, [on("product"), off("docs")], "site")).toEqual({
      value: "off",
      from: "docs",
    })
  })

  test("it is null when nobody on the line gives a value", () => {
    expect(orgToolNow(tree, [], "site")).toBeNull()
    expect(orgToolNow(tree, [on("ops")], "site")).toBeNull()
  })

  test("it skips the own entry of the organization: the line is for 'Inherit'", () => {
    expect(orgToolNow(tree, [on("site"), off("docs")], "site")).toEqual({
      value: "off",
      from: "docs",
    })
  })
})
