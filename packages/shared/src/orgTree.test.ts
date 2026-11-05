import { describe, expect, test } from "bun:test"
import {
  type ChangeTime,
  higherOrgs,
  lowerOrgs,
  type OrgRepair,
  orgLevels,
  orgParent,
  orgParentChoices,
  orgParentRefusal,
  orgParents,
  orgRepairAfterImport,
  orgRepairAfterSync,
  type RepairOrg,
  type TreeOrg,
} from "./orgTree.ts"

// Spec 030, "Organization tree": at most 3 levels, no loop, no self parent, a parent that does not
// exist counts as none. An organization has no archive state.

const org = (id: string, parentId: string | null = null): TreeOrg => ({ id, parentId })

// Product > Docs > Site, and Ops alone.
const tree = [org("product"), org("docs", "product"), org("site", "docs"), org("ops")]

describe("the tree as it is now", () => {
  test("each organization has its stored parent, and a level", () => {
    const parents = orgParents(tree)
    expect(Object.fromEntries(parents)).toEqual({
      product: null,
      docs: "product",
      site: "docs",
      ops: null,
    })
    expect(Object.fromEntries(orgLevels(parents))).toEqual({
      product: 1,
      docs: 2,
      site: 3,
      ops: 1,
    })
    expect(higherOrgs(tree, "site")).toEqual(["docs", "product"])
    expect([...lowerOrgs(tree, "product")].sort()).toEqual(["docs", "site"])
    expect(orgParent(tree, "docs")).toBe("product")
    expect(orgParent(tree, "ops")).toBeNull()
  })

  test("a parent that does not exist counts as none (a deleted parent)", () => {
    expect(orgParents([org("docs", "gone")]).get("docs")).toBeNull()
  })

  test("data that breaks the rules (two computers) still gives a tree with no loop", () => {
    // A loop of two: both count as top organizations, and one under one of them stays under it.
    const loop = orgParents([org("a", "b"), org("b", "a"), org("c", "a")])
    expect(loop.get("a")).toBeNull()
    expect(loop.get("b")).toBeNull()
    expect(loop.get("c")).toBe("a")
    // A fourth level: that organization counts as a top organization.
    const deep = orgParents([...tree, org("deep", "site")])
    expect(deep.get("deep")).toBeNull()
    // The order of the data does not change the result.
    const reversed = orgParents([org("c", "a"), org("b", "a"), org("a", "b")])
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(loop))
    // An organization that is its own parent is a top organization.
    expect(orgParents([org("self", "self")]).get("self")).toBeNull()
  })
})

describe("the rules of a new parent (acceptance: Product, Docs, Site)", () => {
  test("None is always allowed", () => {
    expect(orgParentRefusal(tree, "site", null)).toBeUndefined()
  })

  test("an organization cannot be its own parent or under one of its lower organizations", () => {
    expect(orgParentRefusal(tree, "product", "product")).toBe("loop")
    expect(orgParentRefusal(tree, "product", "docs")).toBe("loop")
    expect(orgParentRefusal(tree, "product", "site")).toBe("loop")
  })

  test("the tree has at most 3 levels: a fourth organization under Site is refused", () => {
    expect(orgParentRefusal(tree, "new", "site")).toBe("levels")
    expect(orgParentRefusal(tree, "new", "docs")).toBeUndefined()
    // "Docs" with "Site" under it takes two levels: under "Ops" is fine.
    expect(orgParentRefusal(tree, "docs", "ops")).toBeUndefined()
    // "Product" takes three levels: it cannot go under any organization.
    expect(orgParentRefusal(tree, "product", "ops")).toBe("levels")
  })

  test("an organization that does not exist cannot be a parent", () => {
    expect(orgParentRefusal(tree, "ops", "nope")).toBe("gone")
  })

  test("moving an organization to another place counts the tree without its old place", () => {
    // "Site" is under "Docs" now; it can go under "Product" (level 2), or stay under "Docs".
    expect(orgParentRefusal(tree, "site", "product")).toBeUndefined()
    expect(orgParentRefusal(tree, "site", "docs")).toBeUndefined()
  })

  test("the field lists every other organization, with the reason", () => {
    expect(orgParentChoices(tree, "product")).toEqual([
      { id: "docs", refusal: "loop" },
      { id: "site", refusal: "loop" },
      { id: "ops", refusal: "levels" },
    ])
    expect(orgParentChoices(tree, "ops")).toEqual([
      { id: "product", refusal: undefined },
      { id: "docs", refusal: undefined },
      { id: "site", refusal: "levels" },
    ])
  })
})

// ------------------------------------------------------------------------------ repair

describe("the repair after an import (spec 030, Repair, case 1)", () => {
  const ro = (id: string, parentId: string | null = null, extra: Partial<RepairOrg> = {}) => ({
    id,
    parentId,
    createdAt: 1,
    ...extra,
  })

  test("a tree that is right needs no repair", () => {
    expect(orgRepairAfterImport([ro("p"), ro("d", "p"), ro("s", "d"), ro("o")])).toEqual([])
    expect(orgRepairAfterImport([])).toEqual([])
  })

  test("a fourth level: its field is cleared, and it is a top organization", () => {
    const orgs = [ro("product"), ro("docs", "product"), ro("site", "docs"), ro("wiki", "site")]
    expect(orgRepairAfterImport(orgs)).toEqual([{ id: "wiki", reason: "levels" }])
  })

  test("the check goes from the top down: the organizations under a cleared one count from their new level", () => {
    // Product > A > B > C > D > E > F: C is on level 4 and is cleared. D, E are on levels 2 and 3.
    // F is on level 4 again, so it is cleared too.
    const chain = [
      ro("p"),
      ro("a", "p"),
      ro("b", "a"),
      ro("c", "b"),
      ro("d", "c"),
      ro("e", "d"),
      ro("f", "e"),
    ]
    expect(orgRepairAfterImport(chain)).toEqual([
      { id: "c", reason: "levels" },
      { id: "f", reason: "levels" },
    ])
    // Two organizations on the fourth level of different branches are both cleared.
    const wide = [ro("p"), ro("a", "p"), ro("b", "a"), ro("x", "b"), ro("y", "b")]
    expect(orgRepairAfterImport(wide).map((r) => r.id)).toEqual(["x", "y"])
  })

  test("the same repair for any order of the organizations", () => {
    const orgs = [
      ro("p"),
      ro("a", "p"),
      ro("b", "a"),
      ro("c", "b"),
      ro("d", "c"),
      ro("lab", "d"),
      ro("z"),
    ]
    const result = (list: readonly RepairOrg[]) =>
      orgRepairAfterImport(list)
        .map((r) => r.id)
        .sort()
    expect(result(orgs)).toEqual(["c"])
    expect(result([...orgs].reverse())).toEqual(["c"])
    expect(result([...orgs.slice(3), ...orgs.slice(0, 3)])).toEqual(["c"])
    const cleared = orgs.map((o) => (o.id === "c" ? { ...o, parentId: null } : o))
    expect(orgRepairAfterImport(cleared)).toEqual([])
  })

  test("an import with a fourth level and a loop: both are repaired (acceptance)", () => {
    // A > B > C > D is a fourth level. X <-> Y is a loop.
    const orgs = [
      ro("a"),
      ro("b", "a"),
      ro("c", "b"),
      ro("d", "c"),
      ro("x", "y", { createdAt: 100 }),
      ro("y", "x", { createdAt: 200 }),
    ]
    expect(orgRepairAfterImport(orgs)).toEqual([
      { id: "y", reason: "loop" },
      { id: "d", reason: "levels" },
    ])
  })
})

describe("the repair after a sync (spec 030, Repair, case 2)", () => {
  const at = (l: number, n = "d1"): ChangeTime => ({ l, c: 0, n })
  const ro = (id: string, parentId: string | null, l: number, createdAt = 1): RepairOrg => ({
    id,
    parentId,
    createdAt,
    parentChanged: at(l),
  })

  test("a tree that is right needs no repair", () => {
    expect(orgRepairAfterSync([ro("p", null, 1), ro("d", "p", 2), ro("s", "d", 3)])).toEqual([])
  })

  test("a loop: the field of the organization with the later parent change is cleared", () => {
    // Computer 1 put "Docs" under "Site" (time 5). Computer 2 put "Site" under "Docs" (time 7).
    const loop = [ro("docs", "site", 5), ro("site", "docs", 7)]
    expect(orgRepairAfterSync(loop)).toEqual([{ id: "site", reason: "loop" }])
    expect(orgRepairAfterSync([ro("docs", "site", 8), ro("site", "docs", 7)])).toEqual([
      { id: "docs", reason: "loop" },
    ])
  })

  test("the same time: the organization that was made later; the same creation time: the later id", () => {
    expect(orgRepairAfterSync([ro("docs", "site", 5, 100), ro("site", "docs", 5, 200)])).toEqual([
      { id: "site", reason: "loop" },
    ])
    expect(orgRepairAfterSync([ro("docs", "site", 5, 300), ro("site", "docs", 5, 200)])).toEqual([
      { id: "docs", reason: "loop" },
    ])
    expect(orgRepairAfterSync([ro("a", "b", 5, 100), ro("b", "a", 5, 100)])).toEqual([
      { id: "b", reason: "loop" },
    ])
    // The counter decides before the creation time does: the later change has the larger counter.
    const first: RepairOrg = { ...ro("a", "b", 5, 1), parentChanged: { l: 5, c: 1, n: "d1" } }
    expect(orgRepairAfterSync([first, ro("b", "a", 5, 999)])).toEqual([{ id: "a", reason: "loop" }])
    // The computer that made a change does not make it later: the creation time decides.
    const other: RepairOrg = { ...ro("b", "a", 5, 999), parentChanged: { l: 5, c: 0, n: "d0" } }
    expect(orgRepairAfterSync([ro("a", "b", 5, 1), other])).toEqual([{ id: "b", reason: "loop" }])
  })

  test("an organization that is its own parent is a loop of one", () => {
    expect(orgRepairAfterSync([ro("a", "a", 1), ro("b", null, 1)])).toEqual([
      { id: "a", reason: "loop" },
    ])
  })

  test("a loop with organizations that hang from it: one field is cleared, no other is changed", () => {
    const data = [ro("a", "b", 1), ro("b", "a", 2), ro("c", "a", 1)]
    expect(orgRepairAfterSync(data)).toEqual([{ id: "b", reason: "loop" }])
  })

  test("a fourth level: the organization with the latest parent change on the line is cleared", () => {
    // P > A > B > C. The change of "C" (time 9) is the latest.
    const line = [ro("p", null, 1), ro("a", "p", 2), ro("b", "a", 3), ro("c", "b", 9)]
    expect(orgRepairAfterSync(line)).toEqual([{ id: "c", reason: "levels" }])
    // The change of "A" is the latest: "A" becomes a top organization, and A > B > C is 3 levels.
    const second = [ro("p", null, 1), ro("a", "p", 9), ro("b", "a", 3), ro("c", "b", 4)]
    expect(orgRepairAfterSync(second)).toEqual([{ id: "a", reason: "levels" }])
    const third = [ro("p", null, 1), ro("a", "p", 2), ro("b", "a", 9), ro("c", "b", 4)]
    expect(orgRepairAfterSync(third)).toEqual([{ id: "b", reason: "levels" }])
  })

  test("a deeper tree is repaired one break after the other, nearest to the top first", () => {
    const data = [
      ro("p", null, 1),
      ro("a", "p", 2),
      ro("b", "a", 3),
      ro("c", "b", 9),
      ro("d", "c", 20),
    ]
    expect(orgRepairAfterSync(data)).toEqual([{ id: "c", reason: "levels" }])
  })

  test("a parent that is not there is no break and no repair", () => {
    expect(orgRepairAfterSync([ro("a", "gone", 1)])).toEqual([])
  })

  test("two computers that get the two changes in a different order choose the same organization", () => {
    const base = [ro("docs", null, 1), ro("site", null, 1), ro("other", null, 1)]
    const change1 = (list: RepairOrg[]) =>
      list.map((o) => (o.id === "docs" ? ro("docs", "site", 5) : o))
    const change2 = (list: RepairOrg[]) =>
      list.map((o) => (o.id === "site" ? ro("site", "docs", 7) : o))
    const one = change2(change1(base))
    const two = change1(change2(base))
    expect(orgRepairAfterSync(one)).toEqual(orgRepairAfterSync(two))
    expect(orgRepairAfterSync(one)).toEqual([{ id: "site", reason: "loop" }])
    expect(orgRepairAfterSync([...one].reverse())).toEqual(orgRepairAfterSync(one))
  })
})

describe("the repair of a loop after an import (spec 030, Repair)", () => {
  const at = (l: number, c = 0, n = "d1"): ChangeTime => ({ l, c, n })
  const ro = (
    id: string,
    parentId: string | null,
    createdAt: number,
    parentChanged?: ChangeTime,
  ): RepairOrg => ({ id, parentId, createdAt, ...(parentChanged ? { parentChanged } : {}) })

  test("with no change time at all (an import): the organization made later, then the later id", () => {
    expect(orgRepairAfterImport([ro("a", "b", 100), ro("b", "a", 200)])).toEqual([
      { id: "b", reason: "loop" },
    ])
    expect(orgRepairAfterImport([ro("a", "b", 200), ro("b", "a", 100)])).toEqual([
      { id: "a", reason: "loop" },
    ])
    const same = [ro("m1", "m2", 100), ro("m2", "m3", 100), ro("m3", "m1", 100)]
    expect(orgRepairAfterImport(same)).toEqual([{ id: "m3", reason: "loop" }])
    expect(orgRepairAfterImport([...same].reverse())).toEqual([{ id: "m3", reason: "loop" }])
  })

  test("an organization with a change time is later than one with none", () => {
    expect(orgRepairAfterImport([ro("a", "b", 999), ro("b", "a", 1, at(1))])).toEqual([
      { id: "b", reason: "loop" },
    ])
  })

  test("a loop gets one repair, not one for each organization", () => {
    const ring = (ids: readonly string[]) =>
      ids.map((id, i) => ro(id, ids[(i + 1) % ids.length] as string, 1, at(i + 1)))
    const three = ring(["a", "b", "c"])
    expect(orgRepairAfterImport(three)).toEqual([{ id: "c", reason: "loop" }])
    expect(orgRepairAfterSync(three)).toEqual([{ id: "c", reason: "loop" }])
    // A loop of four: once it is broken, the line of four organizations is a fourth level, and the
    // check runs again (spec 030: one field for each break).
    expect(orgRepairAfterImport(ring(["a", "b", "c", "d"]))).toEqual([
      { id: "d", reason: "loop" },
      { id: "a", reason: "levels" },
    ])
  })

  test("a loop is broken first, and the fourth level that this makes is checked again", () => {
    // A <-> B is a loop. C is under A, and D is under C. B has the later change.
    // After "B" is cleared: B > A > C > D. "D" is on the fourth level.
    const data = [
      ro("a", "b", 1, at(1)),
      ro("b", "a", 1, at(5)),
      ro("c", "a", 1, at(2)),
      ro("d", "c", 1, at(3)),
    ]
    const expected: OrgRepair[] = [
      { id: "b", reason: "loop" },
      { id: "d", reason: "levels" },
    ]
    expect(orgRepairAfterSync(data)).toEqual(expected)
    expect(orgRepairAfterImport(data)).toEqual(expected)
  })
})

describe("the repair always ends in a tree that has the rules (spec 030, Repair)", () => {
  // A small generator with a fixed seed: the same cases on every run.
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const make = (next: () => number): RepairOrg[] => {
    const n = 2 + Math.floor(next() * 9)
    return Array.from({ length: n }, (_, i) => ({
      id: `o${i}`,
      parentId: next() < 0.8 ? `o${Math.floor(next() * n)}` : null,
      createdAt: Math.floor(next() * 4),
      parentChanged: {
        l: Math.floor(next() * 4),
        c: Math.floor(next() * 2),
        n: next() < 0.5 ? "a" : "b",
      },
    }))
  }
  const shuffle = <T>(list: readonly T[], next: () => number) => {
    const out = [...list]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[out[i], out[j]] = [out[j] as T, out[i] as T]
    }
    return out
  }
  const clear = (orgs: readonly RepairOrg[], ids: readonly string[]) =>
    orgs.map((o) => (ids.includes(o.id) ? { ...o, parentId: null } : o))
  /** The data reads as the tree as it is now: the tolerant reading set nothing aside. */
  const holds = (orgs: readonly RepairOrg[]) => {
    const parents = orgParents(orgs)
    return orgs.every((o) => (parents.get(o.id) ?? null) === o.parentId)
  }

  test("after a sync: a tree with no loop and at most 3 levels, the same for any order", () => {
    const next = random(7)
    for (let i = 0; i < 300; i++) {
      const orgs = make(next)
      const ids = orgRepairAfterSync(orgs).map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(holds(clear(orgs, ids))).toBe(true)
      expect(orgRepairAfterSync(clear(orgs, ids))).toEqual([])
      const again = orgRepairAfterSync(shuffle(orgs, next))
      expect(again.map((r) => r.id).sort()).toEqual([...ids].sort())
    }
  })

  test("after an import: the same", () => {
    const next = random(11)
    for (let i = 0; i < 300; i++) {
      const orgs = make(next)
      const ids = orgRepairAfterImport(orgs).map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(holds(clear(orgs, ids))).toBe(true)
      expect(orgRepairAfterImport(clear(orgs, ids))).toEqual([])
      const again = orgRepairAfterImport(shuffle(orgs, next))
      expect(again.map((r) => r.id).sort()).toEqual([...ids].sort())
    }
  })
})
