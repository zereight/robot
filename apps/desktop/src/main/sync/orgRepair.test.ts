import { describe, expect, test } from "bun:test"
import { type DatabaseService, openDatabase } from "../services/Database.ts"
import type { OrgRepaired } from "../services/orgRepair.ts"
import { SyncEngine } from "./engine.ts"
import { parseOp } from "./wire.ts"

// The repair of the organization tree after a sync (spec 030, "Repair", 019). Two computers each
// change a parent field in a way that is right alone, and the two changes together make a loop or a
// fourth level. Two engines with a database each exchange real changes. Whatever the order is in
// which the changes cross, both computers end with the same tree.

interface Side {
  readonly id: string
  readonly db: DatabaseService
  readonly engine: SyncEngine
  /** What the engine told the caller that it repaired on this computer. */
  readonly repaired: OrgRepaired[]
  /** The clock of this computer, in ms. A test moves it. */
  clock: number
}

const side = (id: string, peer: string): Side => {
  const db = openDatabase(":memory:")
  db.run(
    "INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0)",
  )
  db.run(
    "INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at) VALUES (1, ?, ?, 'a', 'merge', 'live', 1)",
    peer,
    peer,
  )
  const repaired: OrgRepaired[] = []
  const made: Side = {
    id,
    db,
    repaired,
    clock: 1000,
    engine: new SyncEngine({
      db,
      self: id,
      selfName: () => id,
      peer: () => ({ id: peer, name: peer }),
      localServerId: () => "s",
      newWorkspace: () => "/tmp/robot-test-workspace",
      facesDir: "/tmp/robot-test-faces",
      removeSecret: () => {},
      onOrgRepair: (list) => repaired.push(...list),
      now: () => made.clock,
    }),
  }
  return made
}

const pair = () => [side("dev-a", "dev-b"), side("dev-b", "dev-a")] as const

/** Applies the changes that wait on `from` on `to` as one batch of the link. */
const batch = (from: Side, to: Side, sent: ReturnType<SyncEngine["pending"]>) => {
  const ops = sent.map((p) => parseOp(JSON.parse(JSON.stringify(p.op)), 10_000_000))
  expect(ops.every((op) => op !== undefined)).toBe(true)
  const result = to.engine.apply(
    ops.filter((op) => op !== undefined),
    { force: false, snapshot: false },
  )
  from.engine.ack(sent)
  return result
}

/** A whole sync: all that waits on `from` goes to `to` in one batch, and then `to` checks the tree. */
const ship = (from: Side, to: Side) => {
  from.engine.flush()
  const result = batch(from, to, from.engine.pending(1000, 50_000_000))
  result.touches.push(...to.engine.repairOrgs())
  return result
}

const settle = (a: Side, b: Side) => {
  for (let i = 0; i < 4; i++) {
    ship(a, b)
    ship(b, a)
  }
  expect(a.engine.hasPending() || b.engine.hasPending()).toBe(false)
}

const add = (to: Side, id: string, parent: string | null, createdAt: number) =>
  to.db.run(
    `INSERT INTO org_unit (id, server_id, name, name_key, parent_id, created_at, updated_at)
     VALUES (?, 's', ?, ?, ?, ?, ?)`,
    id,
    id,
    id,
    parent,
    createdAt,
    createdAt,
  )
const setParent = (on: Side, id: string, parent: string | null) =>
  on.db.run("UPDATE org_unit SET parent_id = ?, updated_at = ? WHERE id = ?", parent, on.clock, id)

const parents = (on: Side) =>
  Object.fromEntries(
    on.db
      .all<{ id: string; parent_id: string | null }>(
        "SELECT id, parent_id FROM org_unit ORDER BY id",
      )
      .map((r) => [r.id, r.parent_id]),
  )

/** Both computers hold the organizations, with the same ids and the same stamps. */
const start = (orgs: readonly [string, string | null][]) => {
  const [a, b] = pair()
  for (const [i, [id, parent]] of orgs.entries()) add(a, id, parent, 10 + i)
  settle(a, b)
  expect(parents(b)).toEqual(parents(a))
  return [a, b] as const
}

type Order = "a-first" | "b-first"
const orders: Order[] = ["a-first", "b-first"]
const cross = (a: Side, b: Side, order: Order) => {
  if (order === "a-first") {
    ship(a, b)
    ship(b, a)
  } else {
    ship(b, a)
    ship(a, b)
  }
  settle(a, b)
}

describe("a loop that two computers make", () => {
  for (const order of orders) {
    test(`the later parent change is cleared on both computers (${order})`, () => {
      const [a, b] = start([
        ["docs", null],
        ["site", null],
        ["ops", null],
      ])
      // Before they sync, computer A puts "Docs" under "Site", and computer B puts "Site" under
      // "Docs" a little later.
      a.clock = 2000
      setParent(a, "docs", "site")
      a.engine.flush()
      b.clock = 3000
      setParent(b, "site", "docs")
      b.engine.flush()
      cross(a, b, order)

      // The change of "Site" is later, so its field is cleared. The tree has no loop.
      for (const on of [a, b]) expect(parents(on)).toEqual({ docs: "site", ops: null, site: null })
      // Only the computer that found the break tells the caller, and it tells once.
      const told = [...a.repaired, ...b.repaired]
      expect(told.map((r) => [r.id, r.reason])).toEqual([["site", "loop"]])
    })
  }

  test("the computer that gets the change first finds the break; the cleared field goes back", () => {
    const [a, b] = start([
      ["docs", null],
      ["site", null],
    ])
    a.clock = 2000
    setParent(a, "docs", "site")
    a.engine.flush()
    b.clock = 3000
    setParent(b, "site", "docs")
    b.engine.flush()
    const result = ship(a, b)
    expect(result.touches.map((t) => `${t.kind}:${t.action}:${t.id}`)).toEqual([
      "orgunit:changed:docs",
      "orgunit:changed:site",
    ])
    expect(parents(b)).toEqual({ docs: "site", site: null })
    expect(b.repaired.map((r) => r.id)).toEqual(["site"])
    // The cleared field waits to go out like any change; A has nothing to repair when it gets it.
    expect(b.engine.hasPending()).toBe(true)
    ship(b, a)
    expect(parents(a)).toEqual({ docs: "site", site: null })
    expect(a.repaired).toEqual([])
  })

  for (const order of orders) {
    test(`the same time: the organization that was made later is cleared (${order})`, () => {
      const [a, b] = start([
        ["older", null],
        ["newer", null],
      ])
      a.clock = 5000
      b.clock = 5000
      setParent(a, "older", "newer")
      setParent(b, "newer", "older")
      a.engine.flush()
      b.engine.flush()
      cross(a, b, order)
      for (const on of [a, b]) expect(parents(on)).toEqual({ newer: null, older: "newer" })
    })
  }
})

describe("a fourth level that two computers make", () => {
  for (const order of orders) {
    test(`the organization with the later parent change loses its parent (${order})`, () => {
      const [a, b] = start([
        ["top", null],
        ["mid", "top"],
        ["low", null],
        ["extra", null],
      ])
      // A puts "Low" under "Mid" (a third level). B puts "Extra" under "Low" a little later: after
      // both changes, "Extra" would be on the fourth level.
      a.clock = 2000
      setParent(a, "low", "mid")
      a.engine.flush()
      b.clock = 3000
      setParent(b, "extra", "low")
      b.engine.flush()
      cross(a, b, order)
      for (const on of [a, b])
        expect(parents(on)).toEqual({ extra: null, low: "mid", mid: "top", top: null })
      expect([...a.repaired, ...b.repaired].map((r) => [r.id, r.reason])).toEqual([
        ["extra", "levels"],
      ])
    })
  }
})

describe("a tree that is right", () => {
  test("two changes that make a valid tree together: nothing is repaired", () => {
    const [a, b] = start([
      ["top", null],
      ["mid", null],
      ["low", null],
    ])
    a.clock = 2000
    setParent(a, "mid", "top")
    a.engine.flush()
    b.clock = 3000
    setParent(b, "low", "mid")
    b.engine.flush()
    cross(a, b, "a-first")
    for (const on of [a, b]) expect(parents(on)).toEqual({ low: "mid", mid: "top", top: null })
    expect([...a.repaired, ...b.repaired]).toEqual([])
  })
})
