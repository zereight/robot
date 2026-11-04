import { describe, expect, test } from "bun:test"
import {
  higherChannels,
  lowerChannels,
  parentChoices,
  parentRefusal,
  type TreeChannel,
  treeLevels,
  treeParents,
} from "./channelTree.ts"

// Spec 030, "Channel tree": at most 3 levels, no loop, an archived parent counts as none while it
// is archived, and a restore makes its sub-channels sub-channels again.

const ch = (id: string, parentId: string | null = null, archived = false): TreeChannel => ({
  id,
  parentId,
  archived,
})

// Product > Docs > Site, and Ops alone.
const tree = [ch("product"), ch("docs", "product"), ch("site", "docs"), ch("ops")]

describe("the tree as it is now", () => {
  test("each channel has its stored parent, and a level", () => {
    const parents = treeParents(tree)
    expect(Object.fromEntries(parents)).toEqual({
      product: null,
      docs: "product",
      site: "docs",
      ops: null,
    })
    expect(Object.fromEntries(treeLevels(parents))).toEqual({
      product: 1,
      docs: 2,
      site: 3,
      ops: 1,
    })
    expect(higherChannels(tree, "site")).toEqual(["docs", "product"])
    expect([...lowerChannels(tree, "product")].sort()).toEqual(["docs", "site"])
  })

  test("an archived parent counts as no parent; a restore puts the tree back", () => {
    const archived = [ch("product", null, true), ch("docs", "product"), ch("site", "docs")]
    const parents = treeParents(archived)
    expect(parents.get("docs")).toBeNull()
    expect(parents.get("site")).toBe("docs")
    expect(higherChannels(archived, "site")).toEqual(["docs"])
    // Restore: the stored field did not change, so "Docs" is under "Product" again.
    const restored = archived.map((c) => (c.id === "product" ? { ...c, archived: false } : c))
    expect(treeParents(restored).get("docs")).toBe("product")
  })

  test("a parent that does not exist counts as none (a deleted parent)", () => {
    expect(treeParents([ch("docs", "gone")]).get("docs")).toBeNull()
  })

  test("data that breaks the rules (two computers) still gives a tree with no loop", () => {
    // A loop of two: both count as top channels, and a channel under one of them stays under it.
    const loop = treeParents([ch("a", "b"), ch("b", "a"), ch("c", "a")])
    expect(loop.get("a")).toBeNull()
    expect(loop.get("b")).toBeNull()
    expect(loop.get("c")).toBe("a")
    // A fourth level: that channel counts as a top channel.
    const deep = treeParents([...tree, ch("deep", "site")])
    expect(deep.get("deep")).toBeNull()
    // The order of the data does not change the result.
    const reversed = treeParents([ch("c", "a"), ch("b", "a"), ch("a", "b")])
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(loop))
  })
})

describe("the rules of a new parent", () => {
  test("None is always allowed", () => {
    expect(parentRefusal(tree, "site", null)).toBeUndefined()
  })

  test("a channel cannot be its own parent or under one of its lower channels", () => {
    expect(parentRefusal(tree, "product", "product")).toBe("loop")
    expect(parentRefusal(tree, "product", "docs")).toBe("loop")
    expect(parentRefusal(tree, "product", "site")).toBe("loop")
  })

  test("the tree has at most 3 levels", () => {
    // A fourth channel under "Site".
    expect(parentRefusal(tree, "new", "site")).toBe("levels")
    expect(parentRefusal(tree, "new", "docs")).toBeUndefined()
    // "Docs" with "Site" under it takes two levels: under "Ops" is fine, under "Site"… is a loop.
    expect(parentRefusal(tree, "docs", "ops")).toBeUndefined()
    // "Product" takes three levels: it cannot go under any channel.
    expect(parentRefusal(tree, "product", "ops")).toBe("levels")
  })

  test("an archived or missing channel cannot be a parent", () => {
    expect(parentRefusal([...tree, ch("old", null, true)], "ops", "old")).toBe("gone")
    expect(parentRefusal(tree, "ops", "nope")).toBe("gone")
  })

  test("moving a channel to another place counts the tree without its old place", () => {
    // "Site" is under "Docs" now; it can go under "Product" (level 2), or under "Ops".
    expect(parentRefusal(tree, "site", "product")).toBeUndefined()
    expect(parentRefusal(tree, "site", "docs")).toBeUndefined()
  })

  test("the field lists every other channel that is not archived, with the reason", () => {
    const choices = parentChoices([...tree, ch("old", null, true)], "product")
    expect(choices).toEqual([
      { id: "docs", refusal: "loop" },
      { id: "site", refusal: "loop" },
      { id: "ops", refusal: "levels" },
    ])
    expect(parentChoices(tree, "ops")).toEqual([
      { id: "product", refusal: undefined },
      { id: "docs", refusal: undefined },
      { id: "site", refusal: "levels" },
    ])
  })
})
