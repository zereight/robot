import { describe, expect, test } from "bun:test"
import { type DatabaseService, openDatabase } from "../services/Database.ts"
import { SyncEngine } from "./engine.ts"
import { parseOp } from "./wire.ts"

// The switch "Main agent" syncs with the agent (spec 002, 019). At most one agent on a server is
// the main agent. Two computers can each turn the switch on for another agent while they are apart.
// Each change is right alone, and together they make two main agents. The change that was made
// later wins on both computers, whatever the order is in which the changes cross.

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

/** A whole sync: records what waits on `from`, applies it on `to`, and then checks the switch. */
const ship = (from: Side, to: Side) => {
  from.engine.flush()
  const result = batch(from, to, from.engine.pending(1000, 50_000_000))
  result.touches.push(...to.engine.repairMain())
  return result
}

const settle = (a: Side, b: Side) => {
  for (let i = 0; i < 4; i++) {
    ship(a, b)
    ship(b, a)
  }
  expect(a.engine.hasPending() || b.engine.hasPending()).toBe(false)
}

const add = (to: Side, id: string, createdAt: number) =>
  to.db.run(
    `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
       workspace, section, created_at, updated_at)
     VALUES (?, 's', ?, ?, '', '', 0, 0, '/tmp/robot-test-workspace', 'agents', ?, ?)`,
    id,
    id,
    id,
    createdAt,
    createdAt,
  )

/** What the service does: the old main agent loses the flag in the same step. */
const setMain = (on: Side, id: string, value: boolean) => {
  on.db.transaction(() => {
    if (value) on.db.run("UPDATE agent SET is_main = 0 WHERE is_main = 1 AND id != ?", id)
    on.db.run(
      "UPDATE agent SET is_main = ?, updated_at = ? WHERE id = ?",
      value ? 1 : 0,
      on.clock,
      id,
    )
  })
}

const flags = (on: Side) =>
  Object.fromEntries(
    on.db
      .all<{ id: string; is_main: number }>("SELECT id, is_main FROM agent ORDER BY id")
      .map((r) => [r.id, r.is_main === 1]),
  )

/** Both computers hold the agents, with the same ids and the same stamps. */
const start = (ids: readonly string[]) => {
  const [a, b] = pair()
  for (const [i, id] of ids.entries()) add(a, id, 10 + i)
  settle(a, b)
  expect(flags(b)).toEqual(flags(a))
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

describe("the main agent syncs as a field", () => {
  test("the flag goes to the other computer, and the old main agent loses it there in the same sync", () => {
    const [a, b] = start(["ada", "bo"])
    a.clock = 2000
    setMain(a, "ada", true)
    settle(a, b)
    expect(flags(b)).toEqual({ ada: true, bo: false })
    a.clock = 3000
    setMain(a, "bo", true)
    settle(a, b)
    expect(flags(a)).toEqual({ ada: false, bo: true })
    expect(flags(b)).toEqual({ ada: false, bo: true })
  })

  test("an agent that arrives with the flag, and no other main agent here, is the main agent here", () => {
    const [a, b] = pair()
    add(a, "ada", 10)
    a.clock = 2000
    setMain(a, "ada", true)
    settle(a, b)
    expect(flags(b)).toEqual({ ada: true })
  })
})

describe("two main agents that two computers make", () => {
  for (const order of orders) {
    test(`the later change wins on both computers (${order})`, () => {
      const [a, b] = start(["ada", "bo", "cy"])
      // Before they sync, computer A turns the switch on for "ada", and computer B turns it on for
      // "bo" a little later.
      a.clock = 2000
      setMain(a, "ada", true)
      a.engine.flush()
      b.clock = 3000
      setMain(b, "bo", true)
      b.engine.flush()
      cross(a, b, order)
      for (const on of [a, b]) expect(flags(on)).toEqual({ ada: false, bo: true, cy: false })
    })

    test(`the same pair of changes, the other way round: A is later (${order})`, () => {
      const [a, b] = start(["ada", "bo", "cy"])
      b.clock = 2000
      setMain(b, "bo", true)
      b.engine.flush()
      a.clock = 3000
      setMain(a, "ada", true)
      a.engine.flush()
      cross(a, b, order)
      for (const on of [a, b]) expect(flags(on)).toEqual({ ada: true, bo: false, cy: false })
    })
  }

  test("the computer that gets the change first finds the break and tells the window", () => {
    const [a, b] = start(["ada", "bo"])
    a.clock = 2000
    setMain(a, "ada", true)
    a.engine.flush()
    b.clock = 3000
    setMain(b, "bo", true)
    b.engine.flush()
    const result = ship(a, b)
    // B holds "bo" with the later change, so "ada" loses the flag here. It is a change like any
    // other: it waits to go out, and A finds nothing to repair when it gets it.
    expect(result.touches.map((t) => `${t.kind}:${t.action}:${t.id}`)).toContain(
      "agent:changed:ada",
    )
    expect(flags(b)).toEqual({ ada: false, bo: true })
    expect(b.engine.hasPending()).toBe(true)
    ship(b, a)
    expect(flags(a)).toEqual({ ada: false, bo: true })
  })

  test("a check on data that is right changes nothing and sends nothing", () => {
    const [a, b] = start(["ada", "bo"])
    a.clock = 2000
    setMain(a, "ada", true)
    settle(a, b)
    expect(a.engine.repairMain()).toEqual([])
    expect(b.engine.repairMain()).toEqual([])
    expect(a.engine.hasPending() || b.engine.hasPending()).toBe(false)
    expect(flags(b)).toEqual({ ada: true, bo: false })
  })

  test("one computer turns the switch off and the other turns it on for another agent: the later change wins", () => {
    const [a, b] = start(["ada", "bo"])
    a.clock = 2000
    setMain(a, "ada", true)
    settle(a, b)
    a.clock = 3000
    setMain(a, "ada", false)
    a.engine.flush()
    b.clock = 4000
    setMain(b, "bo", true)
    b.engine.flush()
    cross(a, b, "a-first")
    for (const on of [a, b]) expect(flags(on)).toEqual({ ada: false, bo: true })
  })
})
