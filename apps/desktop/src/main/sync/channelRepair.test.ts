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

/** Records what waits on `from` and applies it on `to`, as the link does. */
const ship = (from: Side, to: Side) => {
  from.engine.flush()
  const sent = from.engine.pending(1000, 50_000_000)
  const ops = sent.map((p) => parseOp(JSON.parse(JSON.stringify(p.op)), 10_000_000))
  expect(ops.every((op) => op !== undefined)).toBe(true)
  const result = to.engine.apply(
    ops.filter((op) => op !== undefined),
    { force: false, snapshot: false },
  )
  from.engine.ack(sent)
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
