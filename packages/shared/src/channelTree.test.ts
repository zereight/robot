import { describe, expect, test } from "bun:test"
import {
  type ChangeTime,
  higherChannels,
  lowerChannels,
  parentChoices,
  parentRefusal,
  type RepairChannel,
  repairAfterRestore,
  repairAfterSync,
  type TreeChannel,
  type TreeRepair,
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

// ------------------------------------------------------------------------------ repair

describe("the repair after a restore (spec 030, Repair, case 1)", () => {
  const rc = (id: string, parentId: string | null = null, extra: Partial<RepairChannel> = {}) => ({
    id,
    parentId,
    createdAt: 1,
    ...extra,
  })

  test("a tree that is right needs no repair", () => {
    expect(repairAfterRestore([rc("p"), rc("d", "p"), rc("s", "d"), rc("o")])).toEqual([])
    expect(repairAfterRestore([])).toEqual([])
  })

  test("a restore that puts a channel on the fourth level: its field is cleared, it is a top channel", () => {
    // "Product" was archived. "Docs" > "Site" > "Wiki" is a tree of its own while it is archived.
    // After the restore: Product > Docs > Site > Wiki. "Wiki" would be on the fourth level.
    const channels = [rc("product"), rc("docs", "product"), rc("site", "docs"), rc("wiki", "site")]
    expect(repairAfterRestore(channels)).toEqual([{ id: "wiki", reason: "levels" }])
    // While "Product" is archived the same data has no break: "Docs" is a top channel.
    const archived = channels.map((c) => (c.id === "product" ? { ...c, archived: true } : c))
    expect(repairAfterRestore(archived)).toEqual([])
  })

  test("the check goes from the top down: the channels under a cleared one count from their new level", () => {
    // Product > A > B > C > D > E > F: C is on level 4 and is cleared. D, E are on levels 2 and 3.
    // F is on level 4 again, so it is cleared too.
    const chain = [
      rc("p"),
      rc("a", "p"),
      rc("b", "a"),
      rc("c", "b"),
      rc("d", "c"),
      rc("e", "d"),
      rc("f", "e"),
    ]
    expect(repairAfterRestore(chain)).toEqual([
      { id: "c", reason: "levels" },
      { id: "f", reason: "levels" },
    ])
    // Two channels on the fourth level of different branches are both cleared.
    const wide = [rc("p"), rc("a", "p"), rc("b", "a"), rc("x", "b"), rc("y", "b")]
    expect(repairAfterRestore(wide).map((r) => r.id)).toEqual(["x", "y"])
  })

  test("the repaired data has the rules of the tree: the same tree on any order of the channels", () => {
    const channels = [
      rc("p"),
      rc("a", "p"),
      rc("b", "a"),
      rc("c", "b"),
      rc("d", "c"),
      rc("lab", "d"),
      rc("z"),
    ]
    const result = (list: readonly RepairChannel[]) =>
      repairAfterRestore(list)
        .map((r) => r.id)
        .sort()
    expect(result(channels)).toEqual(["c"])
    expect(result([...channels].reverse())).toEqual(["c"])
    expect(result([...channels.slice(3), ...channels.slice(0, 3)])).toEqual(["c"])
    const cleared = channels.map((c) => (c.id === "c" ? { ...c, parentId: null } : c))
    expect(repairAfterRestore(cleared)).toEqual([])
  })

  test("an archived parent counts as no parent, so a channel under it is a top channel", () => {
    const channels = [
      rc("old", null, { archived: true }),
      rc("a", "old"),
      rc("b", "a"),
      rc("c", "b"),
    ]
    // "A" is a top channel while "Old" is archived: A > B > C is 3 levels.
    expect(repairAfterRestore(channels)).toEqual([])
  })

  test("a loop that a restore closes is broken like a loop after a sync", () => {
    // "A" was archived with the parent "X". While it was archived, "X" was put under "B", and "B" was
    // under "A". The restore makes the loop A > X > B > A. The change of "X" is the latest.
    const loop = [
      rc("a", "x", { parentChanged: { l: 1, c: 0, n: "d1" } }),
      rc("x", "b", { parentChanged: { l: 9, c: 0, n: "d1" } }),
      rc("b", "a", { parentChanged: { l: 2, c: 0, n: "d1" } }),
    ]
    expect(repairAfterRestore(loop)).toEqual([{ id: "x", reason: "loop" }])
  })
})

describe("the repair after a sync (spec 030, Repair, case 2)", () => {
  const at = (l: number, n = "d1"): ChangeTime => ({ l, c: 0, n })
  const rc = (id: string, parentId: string | null, l: number, createdAt = 1): RepairChannel => ({
    id,
    parentId,
    createdAt,
    parentChanged: at(l),
  })

  test("a tree that is right needs no repair", () => {
    expect(repairAfterSync([rc("p", null, 1), rc("d", "p", 2), rc("s", "d", 3)])).toEqual([])
  })

  test("a loop: the field of the channel with the later parent change is cleared", () => {
    // Computer 1 put "Docs" under "Site" (time 5). Computer 2 put "Site" under "Docs" (time 7).
    const loop = [rc("docs", "site", 5), rc("site", "docs", 7)]
    expect(repairAfterSync(loop)).toEqual([{ id: "site", reason: "loop" }])
    // The other way round: the later change is the one of "Docs".
    expect(repairAfterSync([rc("docs", "site", 8), rc("site", "docs", 7)])).toEqual([
      { id: "docs", reason: "loop" },
    ])
  })

  test("the same time: the channel that was made later; the same creation time: the later id", () => {
    expect(repairAfterSync([rc("docs", "site", 5, 100), rc("site", "docs", 5, 200)])).toEqual([
      { id: "site", reason: "loop" },
    ])
    expect(repairAfterSync([rc("docs", "site", 5, 300), rc("site", "docs", 5, 200)])).toEqual([
      { id: "docs", reason: "loop" },
    ])
    expect(repairAfterSync([rc("a", "b", 5, 100), rc("b", "a", 5, 100)])).toEqual([
      { id: "b", reason: "loop" },
    ])
    // The counter decides before the creation time does: the later change has the larger counter.
    const first: RepairChannel = { ...rc("a", "b", 5, 1), parentChanged: { l: 5, c: 1, n: "d1" } }
    expect(repairAfterSync([first, rc("b", "a", 5, 999)])).toEqual([{ id: "a", reason: "loop" }])
    // The computer that made a change does not make it later: the creation time decides.
    const other: RepairChannel = { ...rc("b", "a", 5, 999), parentChanged: { l: 5, c: 0, n: "d0" } }
    expect(repairAfterSync([rc("a", "b", 5, 1), other])).toEqual([{ id: "b", reason: "loop" }])
  })

  test("a channel that is its own parent is a loop of one", () => {
    expect(repairAfterSync([rc("a", "a", 1), rc("b", null, 1)])).toEqual([
      { id: "a", reason: "loop" },
    ])
  })

  test("a loop with channels that hang from it: only one field is cleared, and no other is changed", () => {
    // A > B > A is a loop. C is under A. "B" has the later change: it becomes a top channel with
    // A under it, and C under A (3 levels).
    const data = [rc("a", "b", 1), rc("b", "a", 2), rc("c", "a", 1)]
    expect(repairAfterSync(data)).toEqual([{ id: "b", reason: "loop" }])
  })

  test("a fourth level: the channel with the latest parent change on the line is cleared", () => {
    // P > A > B > C. The change of "C" (time 9) is the latest.
    const line = [rc("p", null, 1), rc("a", "p", 2), rc("b", "a", 3), rc("c", "b", 9)]
    expect(repairAfterSync(line)).toEqual([{ id: "c", reason: "levels" }])
    // The change of "A" is the latest: "A" becomes a top channel, and A > B > C is 3 levels.
    const second = [rc("p", null, 1), rc("a", "p", 9), rc("b", "a", 3), rc("c", "b", 4)]
    expect(repairAfterSync(second)).toEqual([{ id: "a", reason: "levels" }])
    // The change of "B" is the latest.
    const third = [rc("p", null, 1), rc("a", "p", 2), rc("b", "a", 9), rc("c", "b", 4)]
    expect(repairAfterSync(third)).toEqual([{ id: "b", reason: "levels" }])
  })

  test("a deeper tree is repaired one break after the other, nearest to the top first", () => {
    // P > A > B > C > D. "C" is on level 4 and "D" on level 5. The latest change on the line of
    // "C" is "C" itself: after it is cleared, C > D has 2 levels and nothing else is left.
    const data = [
      rc("p", null, 1),
      rc("a", "p", 2),
      rc("b", "a", 3),
      rc("c", "b", 9),
      rc("d", "c", 20),
    ]
    expect(repairAfterSync(data)).toEqual([{ id: "c", reason: "levels" }])
  })

  test("a parent that is archived or not there is no break and no repair", () => {
    const data = [
      rc("a", "gone", 1),
      rc("b", "arch", 1),
      { ...rc("arch", null, 1), archived: true },
    ]
    expect(repairAfterSync(data)).toEqual([])
  })

  test("two computers that get the two changes in a different order choose the same channel", () => {
    // Both computers hold the same stamps, so both hold the same data after the changes arrived,
    // whatever the order was. The result does not depend on the order of the list either.
    const base = [rc("docs", null, 1), rc("site", null, 1), rc("other", null, 1)]
    const change1 = (list: RepairChannel[]) =>
      list.map((c) => (c.id === "docs" ? rc("docs", "site", 5) : c))
    const change2 = (list: RepairChannel[]) =>
      list.map((c) => (c.id === "site" ? rc("site", "docs", 7) : c))
    const one = change2(change1(base))
    const two = change1(change2(base))
    expect(repairAfterSync(one)).toEqual(repairAfterSync(two))
    expect(repairAfterSync(one)).toEqual([{ id: "site", reason: "loop" }])
    expect(repairAfterSync([...one].reverse())).toEqual(repairAfterSync(one))
  })
})

describe("the repair always ends in a tree that has the rules (spec 030, Repair)", () => {
  // A small generator with a fixed seed: the same cases on every run.
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const make = (next: () => number): RepairChannel[] => {
    const n = 2 + Math.floor(next() * 9)
    return Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      parentId: next() < 0.8 ? `c${Math.floor(next() * n)}` : null,
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
  const clear = (channels: readonly RepairChannel[], ids: readonly string[]) =>
    channels.map((c) => (ids.includes(c.id) ? { ...c, parentId: null } : c))
  const holds = (channels: readonly RepairChannel[]) => {
    // The data reads as the tree as it is now: no field was set aside by the tolerant reading.
    const parents = treeParents(channels)
    return channels.every(
      (c) =>
        (parents.get(c.id) ?? null) === c.parentId || !channels.some((p) => p.id === c.parentId),
    )
  }

  test("after a sync: a tree with no loop and at most 3 levels, the same for any order, nothing else changed", () => {
    const next = random(7)
    for (let i = 0; i < 300; i++) {
      const channels = make(next)
      const repairs = repairAfterSync(channels)
      const ids = repairs.map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(holds(clear(channels, ids))).toBe(true)
      expect(repairAfterSync(clear(channels, ids))).toEqual([])
      const again = repairAfterSync(shuffle(channels, next))
      expect(again.map((r) => r.id).sort()).toEqual([...ids].sort())
    }
  })

  test("after a restore: the same", () => {
    const next = random(11)
    for (let i = 0; i < 300; i++) {
      const channels = make(next)
      const ids = repairAfterRestore(channels).map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(holds(clear(channels, ids))).toBe(true)
      expect(repairAfterRestore(clear(channels, ids))).toEqual([])
      const again = repairAfterRestore(shuffle(channels, next))
      expect(again.map((r) => r.id).sort()).toEqual([...ids].sort())
    }
  })
})

// ------------------------------------------------------------------------------ refined text

// Spec 030, "Repair": a break can come from a sync, from a restore or from an import. A loop is
// broken at the channel with the latest parent change among the channels of the loop; a restore or
// an import uses the changes that the fields carry. Ties: the channel made later, then the later
// id. More than one break: one field for each break, nearest the top first, and a new check.
describe("the repair of a loop after a restore or an import (spec 030, Repair)", () => {
  const at = (l: number, c = 0, n = "d1"): ChangeTime => ({ l, c, n })
  const rc = (
    id: string,
    parentId: string | null,
    createdAt: number,
    parentChanged?: ChangeTime,
  ): RepairChannel => ({ id, parentId, createdAt, ...(parentChanged ? { parentChanged } : {}) })

  test("the channel with the latest parent change among the channels of the loop is cleared", () => {
    // The oldest channel holds the latest change: the creation time does not decide.
    const loop = [
      rc("a", "b", 300, at(5)),
      rc("b", "c", 200, at(6)),
      rc("c", "a", 100, at(9)),
      rc("other", null, 400),
    ]
    expect(repairAfterRestore(loop)).toEqual([{ id: "c", reason: "loop" }])
    // The same for a sync, and for any order of the list.
    expect(repairAfterSync(loop)).toEqual([{ id: "c", reason: "loop" }])
    expect(repairAfterRestore([...loop].reverse())).toEqual([{ id: "c", reason: "loop" }])
  })

  test("the computer that made the change does not make it later", () => {
    const loop = [rc("a", "b", 100, at(5, 0, "z")), rc("b", "a", 200, at(5, 0, "a"))]
    // The same time and counter: the channel made later.
    expect(repairAfterRestore(loop)).toEqual([{ id: "b", reason: "loop" }])
    // The counter is part of the time.
    expect(repairAfterRestore([rc("a", "b", 100, at(5, 1)), rc("b", "a", 200, at(5, 0))])).toEqual([
      { id: "a", reason: "loop" },
    ])
  })

  test("with no change time at all (an import): the channel made later, then the later id", () => {
    expect(repairAfterRestore([rc("a", "b", 100), rc("b", "a", 200)])).toEqual([
      { id: "b", reason: "loop" },
    ])
    expect(repairAfterRestore([rc("a", "b", 200), rc("b", "a", 100)])).toEqual([
      { id: "a", reason: "loop" },
    ])
    // Made at the same time: the later id, whatever the order of the list.
    const same = [rc("m1", "m2", 100), rc("m2", "m3", 100), rc("m3", "m1", 100)]
    expect(repairAfterRestore(same)).toEqual([{ id: "m3", reason: "loop" }])
    expect(repairAfterRestore([...same].reverse())).toEqual([{ id: "m3", reason: "loop" }])
  })

  test("a channel with a change time is later than one with none", () => {
    const loop = [rc("a", "b", 999), rc("b", "a", 1, at(1))]
    expect(repairAfterRestore(loop)).toEqual([{ id: "b", reason: "loop" }])
  })

  test("a loop of one channel (its own parent) is broken", () => {
    expect(repairAfterRestore([rc("a", "a", 1), rc("b", null, 1)])).toEqual([
      { id: "a", reason: "loop" },
    ])
  })

  test("a loop gets one repair, not one for each channel", () => {
    const ring = (ids: readonly string[]) =>
      ids.map((id, i) => rc(id, ids[(i + 1) % ids.length] as string, 1, at(i + 1)))
    const three = ring(["a", "b", "c"])
    expect(repairAfterRestore(three)).toEqual([{ id: "c", reason: "loop" }])
    expect(repairAfterSync(three)).toEqual([{ id: "c", reason: "loop" }])
    const cleared = three.map((c) => (c.id === "c" ? { ...c, parentId: null } : c))
    expect(repairAfterRestore(cleared)).toEqual([])
    // A loop of four: once the loop is broken, the line of four channels is a fourth level, and the
    // check runs again (spec 030: one field for each break).
    const four = ring(["a", "b", "c", "d"])
    expect(repairAfterRestore(four)).toEqual([
      { id: "d", reason: "loop" },
      { id: "a", reason: "levels" },
    ])
  })

  describe('acceptance: "A restore that closes a loop"', () => {
    // "Docs" is under "Wiki", and "Site" is under "Docs". "Docs" is archived. "Wiki" is put under
    // "Site": allowed, because "Docs" counts as no channel now. Then "Docs" is restored.
    const make = (docsArchived: boolean): RepairChannel[] => [
      { ...rc("wiki", "site", 10, at(30)), archived: false },
      { ...rc("docs", "wiki", 20, at(10)), archived: docsArchived },
      { ...rc("site", "docs", 30, at(20)), archived: false },
    ]

    test("while Docs is archived, Wiki can go under Site, and nothing is broken", () => {
      const channels = make(true).map((c) => (c.id === "wiki" ? { ...c, parentId: null } : c))
      // The rules of the tree let "Wiki" go under "Site": "Docs" counts as no channel.
      expect(parentRefusal(channels, "wiki", "site")).toBeUndefined()
      expect(repairAfterRestore(make(true))).toEqual([])
      expect(Object.fromEntries(treeParents(make(true)))).toMatchObject({
        wiki: "site",
        site: null,
        docs: "wiki",
      })
    })

    test("the restore works, the field of Wiki is cleared, and the tree is Wiki > Docs > Site", () => {
      const repairs = repairAfterRestore(make(false))
      expect(repairs).toEqual([{ id: "wiki", reason: "loop" }])
      const repaired = make(false).map((c) => (c.id === "wiki" ? { ...c, parentId: null } : c))
      const parents = treeParents(repaired)
      expect(Object.fromEntries(parents)).toEqual({ wiki: null, docs: "wiki", site: "docs" })
      expect(Object.fromEntries(treeLevels(parents))).toEqual({ wiki: 1, docs: 2, site: 3 })
      expect(repairAfterRestore(repaired)).toEqual([])
    })
  })

  describe('acceptance: "Docs" under "Product", "Site" under "Docs", "Wiki" under "Site"', () => {
    const make = (productArchived: boolean): RepairChannel[] => [
      { ...rc("product", null, 1), archived: productArchived },
      rc("docs", "product", 2),
      rc("site", "docs", 3),
      rc("wiki", "site", 4),
    ]

    test("while Product is archived, Wiki is on the third level and nothing is broken", () => {
      const channels = make(true)
      expect(repairAfterRestore(channels)).toEqual([])
      const levels = treeLevels(treeParents(channels))
      expect(levels.get("docs")).toBe(1)
      expect(levels.get("wiki")).toBe(3)
    })

    test("the restore works, and the field of Wiki is cleared", () => {
      expect(repairAfterRestore(make(false))).toEqual([{ id: "wiki", reason: "levels" }])
    })
  })
})

describe("more than one break (spec 030, Repair)", () => {
  const at = (l: number): ChangeTime => ({ l, c: 0, n: "d1" })
  const rc = (
    id: string,
    parentId: string | null,
    l: number | undefined,
    createdAt = 1,
  ): RepairChannel => ({
    id,
    parentId,
    createdAt,
    ...(l === undefined ? {} : { parentChanged: at(l) }),
  })
  const applyAll = (channels: readonly RepairChannel[], repairs: readonly { id: string }[]) =>
    channels.map((c) => (repairs.some((r) => r.id === c.id) ? { ...c, parentId: null } : c))

  test("a loop is broken first, and the fourth level that this makes is checked again", () => {
    // A <-> B is a loop. C is under A, and D is under C. B has the later change.
    // After "B" is cleared: B > A > C > D. "D" is on the fourth level.
    const data = [
      rc("a", "b", 1),
      rc("b", "a", 5),
      rc("c", "a", 2),
      rc("d", "c", 3),
      rc("lone", null, undefined),
    ]
    const expected: TreeRepair[] = [
      { id: "b", reason: "loop" },
      { id: "d", reason: "levels" },
    ]
    expect(repairAfterSync(data)).toEqual(expected)
    expect(repairAfterRestore(data)).toEqual(expected)
    // When "A" has the later change, "A" is cleared, and the tree is right: one break only.
    const other = data.map((c) => (c.id === "a" ? { ...c, parentChanged: at(9) } : c))
    expect(repairAfterSync(other)).toEqual([{ id: "a", reason: "loop" }])
    expect(repairAfterRestore(other)).toEqual([{ id: "a", reason: "loop" }])
  })

  test("two loops are two repairs, one field for each", () => {
    const data = [
      rc("a", "b", 1),
      rc("b", "a", 2),
      rc("x", "y", 3),
      rc("y", "z", 4),
      rc("z", "x", 5),
    ]
    for (const repair of [repairAfterSync, repairAfterRestore]) {
      const repairs = repair(data)
      expect(repairs.map((r) => r.reason)).toEqual(["loop", "loop"])
      expect(repairs.map((r) => r.id).sort()).toEqual(["b", "z"])
      expect(repair(applyAll(data, repairs))).toEqual([])
    }
  })

  test("after a sync, the break nearest the top goes first, and the check runs again", () => {
    // P > A > B > C > D > E. "C" is on level 4, "D" on 5, "E" on 6. The latest change of the line
    // P, A, B, C is the one of "A": it becomes a top channel. A > B > C > D > E has "D" on level 4.
    // The latest change of the line A, B, C, D is the one of "B". B > C > D > E is 4 levels:
    // "E" is on level 4, and the line B, C, D, E has the latest change at "C". Then C > D > E.
    const data = [
      rc("p", null, 1),
      rc("a", "p", 20),
      rc("b", "a", 15),
      rc("c", "b", 10),
      rc("d", "c", 5),
      rc("e", "d", 30),
    ]
    const repairs = repairAfterSync(data)
    // Each field that is cleared was on the line of the channel that was too deep at that time.
    expect(repairs).toEqual([
      { id: "a", reason: "levels" },
      { id: "b", reason: "levels" },
      { id: "e", reason: "levels" },
    ])
    expect(repairAfterSync(applyAll(data, repairs))).toEqual([])
  })

  test("after a restore, the check goes from the top down and clears each fourth level", () => {
    const chain = ["p", "a", "b", "c", "d", "e", "f", "g"].map((id, i, all) =>
      rc(id, i === 0 ? null : (all[i - 1] as string), undefined),
    )
    // P A B | C D E | F G: "C" and "F" are cleared, and the tree is three groups of three.
    const repairs = repairAfterRestore(chain)
    expect(repairs).toEqual([
      { id: "c", reason: "levels" },
      { id: "f", reason: "levels" },
    ])
    const levels = treeLevels(treeParents(applyAll(chain, repairs)))
    expect(Math.max(...levels.values())).toBe(3)
  })

  test("a break in one branch does not touch another branch", () => {
    const data = [
      rc("p", null, 1),
      rc("a", "p", 2),
      rc("b", "a", 3),
      rc("c", "b", 4),
      rc("q", null, 1),
      rc("r", "q", 2),
      rc("s", "r", 3),
    ]
    expect(repairAfterSync(data).map((r) => r.id)).toEqual(["c"])
    expect(repairAfterRestore(data).map((r) => r.id)).toEqual(["c"])
  })

  test("the repairs are in the same order for any order of the channels", () => {
    const data = [
      rc("a", "b", 1),
      rc("b", "a", 5),
      rc("c", "a", 2),
      rc("d", "c", 3),
      rc("x", "y", 3),
      rc("y", "x", 4),
      rc("p", null, 1),
      rc("q", "p", 2),
      rc("r", "q", 3),
      rc("s", "r", 4),
    ]
    for (const repair of [repairAfterSync, repairAfterRestore]) {
      const want = repair(data)
      expect(want.length).toBeGreaterThan(2)
      expect(repair([...data].reverse())).toEqual(want)
      expect(repair([...data.slice(5), ...data.slice(0, 5)])).toEqual(want)
    }
  })
})
