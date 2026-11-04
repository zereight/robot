import { describe, expect, test } from "bun:test"
import { type DatabaseService, openDatabase } from "../services/Database.ts"
import { SyncEngine } from "./engine.ts"
import { parseOp } from "./wire.ts"

// The repair of the channel tree after a sync (spec 030, "Repair", 019). Two computers each make a
// change of a parent field that is right alone, and the two together make a loop or a fourth level.
// Two engines with a database each exchange real changes. Whatever the order is in which the
// changes cross, both computers end with the same tree and one muted line.

interface Side {
  readonly id: string
  readonly db: DatabaseService
  readonly engine: SyncEngine
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
  const made: Side = {
    id,
    db,
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
      now: () => made.clock,
    }),
  }
  return made
}

const pair = () => [side("dev-a", "dev-b"), side("dev-b", "dev-a")] as const

/** Applies some of the changes that wait on `from` on `to` as one batch of the link. */
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

/**
 * A whole sync: records what waits on `from`, applies all of it on `to` in one batch, and then
 * checks the tree, as the sync service does when no more batches come (spec 030, "Repair").
 */
const ship = (from: Side, to: Side) => {
  from.engine.flush()
  const result = batch(from, to, from.engine.pending(1000, 50_000_000))
  result.touches.push(...to.engine.repairTree())
  return result
}

/** The changes cross until nothing is left to send. */
const settle = (a: Side, b: Side) => {
  for (let i = 0; i < 4; i++) {
    ship(a, b)
    ship(b, a)
  }
  expect(a.engine.hasPending() || b.engine.hasPending()).toBe(false)
}

const add = (to: Side, id: string, parent: string | null, createdAt: number) =>
  to.db.run(
    `INSERT INTO channel (id, server_id, name, name_key, topic, parent_channel_id, created_at, updated_at)
     VALUES (?, 's', ?, ?, '', ?, ?, ?)`,
    id,
    id,
    id,
    parent,
    createdAt,
    createdAt,
  )
const setParent = (on: Side, id: string, parent: string | null) =>
  on.db.run(
    "UPDATE channel SET parent_channel_id = ?, updated_at = ? WHERE id = ?",
    parent,
    on.clock,
    id,
  )

const parents = (on: Side) =>
  Object.fromEntries(
    on.db
      .all<{ id: string; parent_channel_id: string | null }>(
        "SELECT id, parent_channel_id FROM channel ORDER BY id",
      )
      .map((r) => [r.id, r.parent_channel_id]),
  )
const lines = (on: Side, channelId: string) =>
  on.db
    .all<{ id: string; parts: string }>(
      "SELECT id, parts FROM channel_message WHERE channel_id = ? ORDER BY id",
      channelId,
    )
    .map((r) => ({ id: r.id, parts: JSON.parse(r.parts) as unknown }))

/** Both computers hold the channels, with the same ids and the same stamps. */
const start = (channels: readonly [string, string | null][]) => {
  const [a, b] = pair()
  for (const [i, [id, parent]] of channels.entries()) add(a, id, parent, 10 + i)
  settle(a, b)
  expect(parents(b)).toEqual(parents(a))
  return [a, b] as const
}

type Order = "a-first" | "b-first"
const orders: Order[] = ["a-first", "b-first"]
/** The changes of the two computers cross in this order, one by one, and then to the end. */
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
    test(`the later parent change is cleared on both computers, with one muted line (${order})`, () => {
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
      for (const on of [a, b]) {
        expect(parents(on)).toEqual({ docs: "site", ops: null, site: null })
        expect(lines(on, "site")).toHaveLength(1)
        expect(lines(on, "site")[0]?.parts).toEqual([
          { kind: "note", note: "tree_repaired", why: "loop" },
        ])
        expect(lines(on, "docs")).toEqual([])
        expect(lines(on, "ops")).toEqual([])
      }
      // Both computers hold the same line (the same row), whichever of them found the break.
      expect(lines(a, "site")[0]?.id).toBe(lines(b, "site")[0]?.id as string)
    })
  }

  test("the computer that gets the change first finds the break, and tells the window", () => {
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
    expect(result.touches.map((t) => `${t.kind}:${t.action}:${t.id.slice(0, 4)}`)).toEqual([
      "channel:changed:docs",
      "channel:changed:site",
      `cmessage:added:${lines(b, "site")[0]?.id.slice(0, 4)}`,
    ])
    expect(parents(b)).toEqual({ docs: "site", site: null })
    // The cleared field waits to go out like any change; A has nothing to repair when it gets it.
    expect(b.engine.hasPending()).toBe(true)
    const back = ship(b, a)
    expect(back.touches.some((t) => t.kind === "cmessage" && t.action === "added")).toBe(true)
    expect(parents(a)).toEqual({ docs: "site", site: null })
    expect(lines(a, "site")).toHaveLength(1)
  })

  for (const order of orders) {
    test(`the same time: the channel that was made later is cleared (${order})`, () => {
      // Both changes carry the same time and the same counter.
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

  for (const order of orders) {
    test(`a change that waits for its stamp keeps the time it was made (${order})`, () => {
      const [a, b] = start([
        ["docs", null],
        ["site", null],
      ])
      // A made its change at 2000 and has not recorded it yet. The change of B is later, so
      // B's change must win: the stamp of A's change must not rise above the stamp of B's.
      a.clock = 2000
      setParent(a, "docs", "site")
      b.clock = 3000
      setParent(b, "site", "docs")
      b.engine.flush()
      cross(a, b, order)
      for (const on of [a, b]) expect(parents(on)).toEqual({ docs: "site", site: null })
    })
  }
})

describe("a fourth level that two computers make", () => {
  for (const order of orders) {
    for (const [later, cleared] of [
      ["b", "c"],
      ["a", "b"],
    ] as const) {
      test(`P > A > B > C: the channel of the later change is cleared, change ${later} later (${order})`, () => {
        // "A" is under "P" for both. Computer A puts "B" under "A"; computer B puts "C" under "B".
        const [a, b] = start([
          ["p", null],
          ["a", "p"],
          ["b", null],
          ["c", null],
        ])
        a.clock = later === "a" ? 3000 : 2000
        b.clock = later === "b" ? 3000 : 2000
        setParent(a, "b", "a")
        setParent(b, "c", "b")
        a.engine.flush()
        b.engine.flush()
        cross(a, b, order)
        const want = { a: "p", b: "a", c: "b", p: null, [cleared]: null }
        for (const on of [a, b]) {
          expect(parents(on)).toEqual(want)
          expect(lines(on, cleared)).toHaveLength(1)
          expect(lines(on, cleared)[0]?.parts).toEqual([
            { kind: "note", note: "tree_repaired", why: "levels" },
          ])
        }
      })
    }
  }

  test("a tree that is right gets no line, and a change of another field repairs nothing", () => {
    const [a, b] = start([
      ["p", null],
      ["a", "p"],
      ["b", "a"],
    ])
    a.clock = 2000
    a.db.run("UPDATE channel SET topic = 'New' WHERE id = 'b'")
    settle(a, b)
    for (const on of [a, b]) {
      expect(parents(on)).toEqual({ a: "p", b: "a", p: null })
      expect(on.db.all("SELECT id FROM channel_message")).toEqual([])
    }
  })
})

describe('a set of changes that crosses in two batches (spec 030, Repair, "When it runs")', () => {
  /**
   * Computer A makes one consistent edit set: it moves "Y" to the top, then puts "X" under "Y".
   * A later edit of "Y" (a new topic) moves the change of "Y" behind the change of "X" in the log,
   * so the two batches split between them.
   */
  const editSet = () => {
    const [a, b] = start([
      ["x", null],
      ["y", "x"],
      ["z", null],
    ])
    a.clock = 2000
    setParent(a, "y", null)
    a.engine.flush()
    a.clock = 2100
    setParent(a, "x", "y")
    a.engine.flush()
    a.clock = 2200
    a.db.run("UPDATE channel SET topic = 'Renamed' WHERE id = 'y'")
    a.engine.flush()
    const sent = a.engine.pending(1000, 50_000_000)
    expect(sent.map((p) => p.id)).toEqual(["x", "y"])
    return { a, b, first: sent.slice(0, 1), second: sent.slice(1) }
  }
  const want = { x: "y", y: null, z: null }

  test("the first batch alone makes a loop; the apply does not repair it, and the second batch removes it", () => {
    const { a, b, first, second } = editSet()
    const one = batch(a, b, first)
    // Half of the set is a loop (X under Y, and Y under X). Nothing is repaired in the middle.
    expect(parents(b)).toEqual({ x: "y", y: "x", z: null })
    expect(one.touches.every((t) => t.kind === "channel")).toBe(true)
    expect(b.db.all("SELECT id FROM channel_message")).toEqual([])
    expect(b.engine.hasPending()).toBe(false)

    batch(a, b, second)
    expect(parents(b)).toEqual(want)
    // The sync has applied all that it has: the tree is right, and the check finds nothing.
    expect(b.engine.repairTree()).toEqual([])
    expect(b.db.all("SELECT id FROM channel_message")).toEqual([])
    expect(b.engine.hasPending()).toBe(false)
    expect(parents(a)).toEqual(want)
  })

  test("a check after the whole set repairs nothing, and the other computer gets nothing back", () => {
    const { a, b, first, second } = editSet()
    batch(a, b, first)
    batch(a, b, second)
    settle(a, b)
    for (const on of [a, b]) {
      expect(parents(on)).toEqual(want)
      for (const id of ["x", "y", "z"]) expect(lines(on, id)).toEqual([])
    }
  })

  test("the same changes in one batch: the same result", () => {
    const { a, b } = editSet()
    ship(a, b)
    expect(parents(b)).toEqual(want)
    for (const id of ["x", "y", "z"]) expect(lines(b, id)).toEqual([])
  })

  test("a set that does end in a break is repaired when the check runs, once", () => {
    // Only the first half comes (the second change is a real clash that never arrives): the loop
    // stays, and the check at the end repairs it.
    const { a, b, first } = editSet()
    batch(a, b, first)
    expect(parents(b)).toEqual({ x: "y", y: "x", z: null })
    const made = b.engine.repairTree()
    expect(made.map((t) => t.kind)).toEqual(["channel", "cmessage"])
    expect(made.length).toBe(2)
    expect(parents(b)).toEqual({ x: null, y: "x", z: null })
    expect(lines(b, "x")).toHaveLength(1)
    // A second check finds nothing.
    expect(b.engine.repairTree()).toEqual([])
    expect(lines(b, "x")).toHaveLength(1)
  })
})
