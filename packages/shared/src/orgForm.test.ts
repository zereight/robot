import { describe, expect, test } from "bun:test"
import {
  agentOrgNames,
  orgDeleteLowerCount,
  orgParentOptions,
  orgPatchOf,
  orgPickerEntries,
  orgPickerValues,
  orgToolSwitch,
} from "./orgForm.ts"

const org = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId })

// Product > Docs > Site: the three levels of spec 030.
const tree = [
  org("o-site", "Site", "o-docs"),
  org("o-docs", "docs", "o-product"),
  org("o-product", "Product"),
  org("o-ops", "Ops"),
]

describe("orgParentOptions", () => {
  test("lists the other organizations by name (ignoring case) with the reason when the tree refuses", () => {
    const options = orgParentOptions(tree, "o-product")
    expect(options.map((o) => o.name)).toEqual(["docs", "Ops", "Site"])
    // "Docs" and "Site" are sub-organizations of "Product": a loop. "Product" with its two levels
    // is 3 levels tall, so it cannot go under "Ops" either.
    expect(options.map((o) => o.refusal)).toEqual(["loop", "levels", "loop"])
  })

  test("a fourth level is refused with the reason 'levels'", () => {
    // A new organization (not in the list) under "Site" would be on level 4.
    const options = orgParentOptions(tree, "o-new")
    const byName = Object.fromEntries(options.map((o) => [o.name, o.refusal]))
    expect(byName).toEqual({ docs: undefined, Ops: undefined, Product: undefined, Site: "levels" })
  })

  test("an organization with lower organizations cannot go under a deep one", () => {
    // "Ops" has no sub-organization, so it can go under "docs" (level 3). "Product" cannot.
    const withOpsSub = [...tree, org("o-ops-sub", "Ops sub", "o-ops")]
    const byName = Object.fromEntries(
      orgParentOptions(withOpsSub, "o-ops").map((o) => [o.name, o.refusal]),
    )
    expect(byName.docs).toBe("levels")
    expect(byName.Product).toBeUndefined()
  })

  test("never lists the organization itself", () => {
    expect(orgParentOptions(tree, "o-ops").some((o) => o.id === "o-ops")).toBe(false)
  })

  test("a tie of names goes by id, so the order is the same on every run", () => {
    const options = orgParentOptions([org("b", "Same"), org("a", "same"), org("me", "Me")], "me")
    expect(options.map((o) => o.id)).toEqual(["a", "b"])
  })
})

describe("orgDeleteLowerCount", () => {
  test("counts the lower organizations at any depth, and none for a leaf", () => {
    expect(orgDeleteLowerCount(tree, "o-product")).toBe(2)
    expect(orgDeleteLowerCount(tree, "o-docs")).toBe(1)
    expect(orgDeleteLowerCount(tree, "o-site")).toBe(0)
    expect(orgDeleteLowerCount(tree, "o-ops")).toBe(0)
  })
})

describe("orgPatchOf", () => {
  const was = {
    name: "Docs",
    memberIds: ["a", "b"],
    leadId: "a" as string | null,
    parentId: "p" as string | null,
  }

  test("an unchanged form gives an empty patch", () => {
    expect(orgPatchOf(was, { ...was })).toEqual({})
  })

  test("sends only what changed, and the trimmed name", () => {
    expect(orgPatchOf(was, { ...was, name: "  Docs 2 " })).toEqual({ name: "Docs 2" })
    expect(orgPatchOf(was, { ...was, parentId: null })).toEqual({ parentId: null })
    expect(orgPatchOf(was, { ...was, leadId: null })).toEqual({ leadId: null })
    expect(orgPatchOf(was, { ...was, memberIds: ["a", "b", "c"] })).toEqual({
      memberIds: ["a", "b", "c"],
    })
  })

  test("a name that differs only by spaces is not a change", () => {
    expect(orgPatchOf(was, { ...was, name: " Docs " })).toEqual({})
  })

  test("a lead that is not a member is sent as no lead", () => {
    expect(orgPatchOf(was, { ...was, memberIds: ["b"] })).toEqual({
      memberIds: ["b"],
      leadId: null,
    })
  })
})

describe("orgPickerEntries", () => {
  const exists = (id: string) => id !== "gone"
  const values = (...pairs: [string, "on" | "off"][]) => new Map(pairs)

  // Spec 030, "Tools": the picker of a skill or a connection shows "Inherit", "On" or "Off" for
  // each organization. "Inherit" is no entry in the list.
  test("'On' and 'Off' are entries, and an organization with 'Inherit' leaves the list", () => {
    expect(
      orgPickerEntries([{ id: "a", value: "on" }], values(["b", "on"], ["c", "off"]), exists),
    ).toEqual([
      { id: "b", value: "on" },
      { id: "c", value: "off" },
    ])
  })

  test("a value changes in place: 'Off' to 'On', and 'On' to 'Off'", () => {
    expect(orgPickerEntries([{ id: "a", value: "off" }], values(["a", "on"]), exists)).toEqual([
      { id: "a", value: "on" },
    ])
    expect(orgPickerEntries([{ id: "a", value: "on" }], values(["a", "off"]), exists)).toEqual([
      { id: "a", value: "off" },
    ])
  })

  test("an organization that is gone is left out", () => {
    expect(
      orgPickerEntries(
        [{ id: "gone", value: "off" }],
        values(["gone", "on"], ["a", "off"]),
        exists,
      ),
    ).toEqual([{ id: "a", value: "off" }])
  })

  test("keeps the order of the old list, then the new ones", () => {
    expect(
      orgPickerEntries(
        [
          { id: "x", value: "on" },
          { id: "y", value: "off" },
        ],
        values(["x", "on"], ["y", "off"], ["z", "on"]),
        exists,
      ),
    ).toEqual([
      { id: "x", value: "on" },
      { id: "y", value: "off" },
      { id: "z", value: "on" },
    ])
  })
})

describe("orgPickerValues", () => {
  test("is the start of the picker: the values of the organizations that are still there", () => {
    const list = [
      { id: "a", value: "on" as const },
      { id: "gone", value: "off" as const },
      { id: "b", value: "off" as const },
    ]
    expect([...orgPickerValues(list, (id) => id !== "gone")]).toEqual([
      ["a", "on"],
      ["b", "off"],
    ])
  })
})

describe("orgToolSwitch", () => {
  test("a tool for 'All agents' shows 'On' and cannot change", () => {
    expect(orgToolSwitch({ choice: "inherit", all: true }, false)).toEqual({
      value: "on",
      disabled: true,
    })
  })

  test("a linked computer reads the rows and changes none", () => {
    expect(orgToolSwitch({ choice: "on", all: false }, true)).toEqual({
      value: "on",
      disabled: true,
    })
    expect(orgToolSwitch({ choice: "inherit", all: false }, true).disabled).toBe(true)
  })

  test("this computer can change a row", () => {
    expect(orgToolSwitch({ choice: "inherit", all: false }, false)).toEqual({
      value: "inherit",
      disabled: false,
    })
  })

  test("'Off' (kept by data from later steps) shows as no value of the two", () => {
    expect(orgToolSwitch({ choice: "off", all: false }, false).value).toBe("off")
  })
})

describe("agentOrgNames", () => {
  test("joins the names of the organizations that give a tool", () => {
    expect(
      agentOrgNames({
        kind: "skill",
        id: "s",
        name: "Release notes",
        organizations: [
          { id: "1", name: "Product" },
          { id: "2", name: "Docs" },
        ],
      }),
    ).toBe("Product, Docs")
  })
})
