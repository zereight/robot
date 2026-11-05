import { describe, expect, test } from "bun:test"
import {
  deepestOrg,
  deepestOrgIndex,
  ORG_PREFIX_MAX,
  orgNameMatches,
  orgPrefixText,
  shownName,
} from "./orgPrefix.ts"

const org = (id: string, name: string, memberIds: string[], parentId: string | null = null) => ({
  id,
  name,
  memberIds,
  parentId,
})

describe("the deepest organization (spec 036 Concepts, spec 030 One line)", () => {
  test("an agent in no organization has none", () => {
    expect(deepestOrg([], "ada")).toBeNull()
    expect(deepestOrg([org("d", "Docs", ["bo"])], "ada")).toBeNull()
  })

  test("an agent in one organization gets it", () => {
    expect(deepestOrg([org("d", "Docs", ["ada"])], "ada")?.id).toBe("d")
  })

  test("Ada in Docs (under Product) and in Product: Docs; leave Docs: Product; leave Product: none", () => {
    const product = org("p", "Product", ["ada"])
    const docs = org("d", "Docs", ["ada"], "p")
    expect(deepestOrg([product, docs], "ada")?.id).toBe("d")
    expect(deepestOrg([product, { ...docs, memberIds: [] }], "ada")?.id).toBe("p")
    expect(
      deepestOrg(
        [
          { ...product, memberIds: [] },
          { ...docs, memberIds: [] },
        ],
        "ada",
      ),
    ).toBeNull()
  })

  test("on one line of three levels: the lowest one, whatever the order of the list", () => {
    const product = org("p", "Product", ["ada"])
    const docs = org("d", "Docs", ["ada"], "p")
    const site = org("s", "Site", ["ada"], "d")
    expect(deepestOrg([product, docs, site], "ada")?.id).toBe("s")
    expect(deepestOrg([site, docs, product], "ada")?.id).toBe("s")
    // "Product" and "Site", with "Docs" between them but not a member.
    expect(deepestOrg([product, { ...docs, memberIds: [] }, site], "ada")?.id).toBe("s")
    // "Docs" and "Site".
    expect(deepestOrg([{ ...product, memberIds: [] }, docs, site], "ada")?.id).toBe("s")
  })

  test("depth decides before the name: a lower organization wins over an earlier name", () => {
    const alpha = org("a", "Alpha", ["ada"])
    const beta = org("b", "Beta", [])
    const zed = org("z", "Zed", ["ada"], "b")
    expect(deepestOrg([alpha, beta, zed], "ada")?.id).toBe("z")
  })

  test("not on one line (before the rule is built): a tie goes to the first name, ignoring case", () => {
    const product = org("p", "Product", [])
    const docs = org("d", "docs", ["ada"], "p")
    const ops = org("o", "Ops", ["ada"], "p")
    expect(deepestOrg([product, ops, docs], "ada")?.id).toBe("d")
    expect(deepestOrg([product, docs, ops], "ada")?.id).toBe("d")
    // Two top organizations of the same depth.
    expect(deepestOrg([org("x", "Zoo", ["ada"]), org("y", "ant", ["ada"])], "ada")?.id).toBe("y")
  })

  test("equal names (ignoring case and spaces at the ends) go to the lower id", () => {
    const a = org("b-2", "Docs", ["ada"])
    const b = org("b-1", " DOCS ", ["ada"])
    expect(deepestOrg([a, b], "ada")?.id).toBe("b-1")
    expect(deepestOrg([b, a], "ada")?.id).toBe("b-1")
  })

  test("the tree as it is now counts: a parent that is gone, or a loop, makes a top organization", () => {
    expect(deepestOrg([org("d", "Docs", ["ada"], "gone")], "ada")?.id).toBe("d")
    const a = org("a", "A", ["ada"], "b")
    const b = org("b", "B", ["ada"], "a")
    // Both sit on the loop and count as top organizations: the first name wins.
    expect(deepestOrg([b, a], "ada")?.id).toBe("a")
  })

  test("the index gives the same answer as the function, for every member", () => {
    const orgs = [
      org("p", "Product", ["ada", "bo"]),
      org("d", "Docs", ["ada"], "p"),
      org("o", "Ops", ["cy"]),
    ]
    const index = deepestOrgIndex(orgs)
    expect([...index.keys()].sort()).toEqual(["ada", "bo", "cy"])
    for (const id of ["ada", "bo", "cy", "none"]) {
      expect(index.get(id)?.id).toBe(deepestOrg(orgs, id)?.id)
    }
  })
})

describe("the prefix text (spec 036 Concepts)", () => {
  test("a name of 16 characters or fewer shows whole", () => {
    expect(ORG_PREFIX_MAX).toBe(16)
    expect(orgPrefixText("Docs")).toBe("Docs")
    expect(orgPrefixText("a".repeat(16))).toBe("a".repeat(16))
  })

  test("a longer name is cut at 16 characters and ends with an ellipsis", () => {
    expect(orgPrefixText("Research and Development Group")).toBe("Research and Dev…")
    expect(orgPrefixText("a".repeat(17))).toBe(`${"a".repeat(16)}…`)
  })

  test("characters count as characters, not as code units", () => {
    expect(orgPrefixText("😀".repeat(16))).toBe("😀".repeat(16))
    expect(orgPrefixText("😀".repeat(17))).toBe(`${"😀".repeat(16)}…`)
    expect(orgPrefixText("문서팀".repeat(6))).toBe(`${"문서팀".repeat(5)}문…`)
  })
})

describe("the shown name (spec 036 Concepts)", () => {
  test("an organization and the switch on: prefix, name, note and accessible name", () => {
    expect(shownName("Ada", "Docs", true)).toEqual({
      prefix: "[Docs]",
      organization: "Docs",
      name: "Ada",
      text: "[Docs] Ada",
      label: "Ada, Docs",
    })
  })

  test("a long organization name is cut in the prefix and whole in the label", () => {
    const shown = shownName("Ada", "Research and Development Group", true)
    expect(shown.prefix).toBe("[Research and Dev…]")
    expect(shown.text).toBe("[Research and Dev…] Ada")
    expect(shown.organization).toBe("Research and Development Group")
    expect(shown.label).toBe("Ada, Research and Development Group")
  })

  test("no organization, or the switch off: the stored name only", () => {
    const plain = { prefix: null, organization: null, name: "Ada", text: "Ada", label: "Ada" }
    expect(shownName("Ada", null, true)).toEqual(plain)
    expect(shownName("Ada", undefined, true)).toEqual(plain)
    expect(shownName("Ada", "", true)).toEqual(plain)
    expect(shownName("Ada", "Docs", false)).toEqual(plain)
  })
})

describe("the match against the organization name (spec 036 Rules)", () => {
  test("the text matches a part of the whole name, ignoring case", () => {
    expect(orgNameMatches("Docs", "doc")).toBe(true)
    expect(orgNameMatches("Research and Development Group", "development")).toBe(true)
    // The part after the cut still matches: the whole name counts, not the prefix text.
    expect(orgNameMatches("Research and Development Group", "group")).toBe(true)
    expect(orgNameMatches("Docs", "ops")).toBe(false)
  })

  test("spaces at the ends of the text do not count; an empty text matches nothing here", () => {
    expect(orgNameMatches("Docs", "  docs ")).toBe(true)
    expect(orgNameMatches("Docs", "")).toBe(false)
    expect(orgNameMatches("Docs", "   ")).toBe(false)
  })

  test("no organization matches nothing", () => {
    expect(orgNameMatches(null, "doc")).toBe(false)
    expect(orgNameMatches(undefined, "doc")).toBe(false)
  })
})
