import { describe, expect, test } from "bun:test"
import { type DatabaseService, openDatabase } from "../services/Database.ts"
import type { LineRepaired, OrgRepaired } from "../services/orgRepair.ts"
import { SyncEngine } from "./engine.ts"
import { parseOp } from "./wire.ts"

// The repair of a line of organizations after a sync (spec 030, "One line", "Repair", 019). Two
// computers each add the same agent to an organization, or one moves an organization while the
// other adds a member: each change is right alone, and together they put the agent in two
// organizations that are not on one line. Two engines with a database each exchange real changes.
// Whatever the order is in which the changes cross, both computers end with the same members.

interface Side {
  readonly id: string
  readonly db: DatabaseService
  readonly engine: SyncEngine
  /** What the engine told the caller that it repaired on this computer. */
  readonly repaired: OrgRepaired[]
  /** What the engine told the caller that it removed from a line on this computer. */
  readonly lines: LineRepaired[]
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
  const lines: LineRepaired[] = []
  const made: Side = {
    id,
    db,
    repaired,
    lines,
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
      onLineRepair: (list) => lines.push(...list),
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

const agent = (to: Side, id: string) =>
  to.db.run(
    `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
      workspace, section, created_at, updated_at) VALUES (?, 's', ?, ?, '', '', 0, 0, ?, '', 1, 1)`,
    id,
    id.toUpperCase(),
    id,
    `/tmp/robot-test-workspace/${id}`,
  )
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
const join = (on: Side, org: string, agentId: string, lead = false) => {
  const next = on.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM org_member WHERE org_id = ?",
    org,
  )?.n
  on.db.run(
    "INSERT INTO org_member (org_id, agent_id, position) VALUES (?, ?, ?)",
    org,
    agentId,
    next ?? 0,
  )
  if (lead) on.db.run("UPDATE org_unit SET lead_agent_id = ? WHERE id = ?", agentId, org)
  on.db.run("UPDATE org_unit SET updated_at = ? WHERE id = ?", on.clock, org)
}
const setParent = (on: Side, id: string, parent: string | null) =>
  on.db.run("UPDATE org_unit SET parent_id = ?, updated_at = ? WHERE id = ?", parent, on.clock, id)

const members = (on: Side) =>
  Object.fromEntries(
    on.db
      .all<{ id: string }>("SELECT id FROM org_unit ORDER BY id")
      .map((o) => [
        o.id,
        on.db
          .all<{ agent_id: string }>(
            "SELECT agent_id FROM org_member WHERE org_id = ? ORDER BY agent_id",
            o.id,
          )
          .map((m) => m.agent_id),
      ]),
  )
const leads = (on: Side) =>
  Object.fromEntries(
    on.db
      .all<{ id: string; lead_agent_id: string | null }>(
        "SELECT id, lead_agent_id FROM org_unit ORDER BY id",
      )
      .map((r) => [r.id, r.lead_agent_id]),
  )

/** Both computers hold the agents and the organizations, with the same ids and the same stamps. */
const start = (orgs: readonly [string, string | null][], agents: readonly string[] = ["a"]) => {
  const [a, b] = pair()
  for (const id of agents) agent(a, id)
  for (const [i, [id, parent]] of orgs.entries()) add(a, id, parent, 10 + i)
  settle(a, b)
  expect(members(b)).toEqual(members(a))
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

describe("the same agent in two organizations that are not on one line", () => {
  for (const order of orders) {
    test(`the agent stays where it was added first, on both computers (${order})`, () => {
      const [a, b] = start([
        ["docs", null],
        ["ops", null],
      ])
      a.clock = 2000
      join(a, "docs", "a")
      a.engine.flush()
      b.clock = 3000
      join(b, "ops", "a")
      b.engine.flush()
      cross(a, b, order)

      for (const on of [a, b]) expect(members(on)).toEqual({ docs: ["a"], ops: [] })
      // Only the computer that found the break tells the caller, and it tells once.
      const told = [...a.lines, ...b.lines]
      expect(told).toEqual([
        {
          orgId: "ops",
          orgName: "ops",
          agentId: "a",
          agentName: "A",
          otherId: "docs",
          otherName: "docs",
        },
      ])
    })
  }

  test("the other computer finds nothing to repair when it gets the removal", () => {
    const [a, b] = start([
      ["docs", null],
      ["ops", null],
    ])
    a.clock = 2000
    join(a, "docs", "a")
    a.engine.flush()
    b.clock = 3000
    join(b, "ops", "a")
    b.engine.flush()
    ship(a, b)
    expect(members(b)).toEqual({ docs: ["a"], ops: [] })
    expect(b.lines).toHaveLength(1)
    expect(b.engine.hasPending()).toBe(true)
    ship(b, a)
    expect(members(a)).toEqual({ docs: ["a"], ops: [] })
    expect(a.lines).toEqual([])
    settle(a, b)
    expect(a.lines).toEqual([])
    expect(b.lines).toHaveLength(1)
  })

  test("the lead that is removed is no longer the lead", () => {
    const [a, b] = start([
      ["docs", null],
      ["ops", null],
    ])
    a.clock = 2000
    join(a, "docs", "a")
    a.engine.flush()
    b.clock = 3000
    join(b, "ops", "a", true)
    b.engine.flush()
    cross(a, b, "a-first")
    for (const on of [a, b]) {
      expect(members(on)).toEqual({ docs: ["a"], ops: [] })
      expect(leads(on)).toEqual({ docs: null, ops: null })
    }
  })

  test("the same time: the organization that was made later loses the agent", () => {
    const [a, b] = start([
      ["older", null],
      ["newer", null],
    ])
    a.clock = 5000
    b.clock = 5000
    join(a, "older", "a")
    join(b, "newer", "a")
    a.engine.flush()
    b.engine.flush()
    cross(a, b, "b-first")
    for (const on of [a, b]) expect(members(on)).toEqual({ newer: [], older: ["a"] })
  })
})

describe("a parent change that splits a line", () => {
  for (const order of orders) {
    test(`one computer moves an organization while the other adds a member (${order})`, () => {
      // "Docs" is under "Product"; the agent is in "Product". B moves "Docs" under "Ops" (a top
      // organization), and A adds the agent to "Docs": alone, each change is right.
      const [a, b] = start([
        ["product", null],
        ["docs", "product"],
        ["ops", null],
      ])
      a.clock = 1500
      join(a, "product", "a")
      a.engine.flush()
      settle(a, b)
      a.clock = 2000
      join(a, "docs", "a")
      a.engine.flush()
      b.clock = 3000
      setParent(b, "docs", "ops")
      b.engine.flush()
      cross(a, b, order)
      // The member change of "Docs" is the later one: the agent leaves "Docs".
      for (const on of [a, b]) expect(members(on)).toEqual({ docs: [], ops: [], product: ["a"] })
    })
  }
})

describe("a line that is right", () => {
  test("members on one line are never touched", () => {
    const [a, b] = start(
      [
        ["product", null],
        ["docs", "product"],
        ["ops", null],
      ],
      ["a", "b"],
    )
    a.clock = 2000
    join(a, "product", "a")
    join(a, "docs", "a")
    a.engine.flush()
    b.clock = 3000
    join(b, "ops", "b")
    b.engine.flush()
    cross(a, b, "a-first")
    expect([...a.lines, ...b.lines]).toEqual([])
    for (const on of [a, b])
      expect(members(on)).toEqual({ docs: ["a"], ops: ["b"], product: ["a"] })
  })
})
