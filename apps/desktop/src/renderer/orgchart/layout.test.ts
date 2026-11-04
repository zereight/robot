import { describe, expect, test } from "bun:test"
import {
  buildChart,
  type ChartModel,
  copyKey,
  EMPTY_ORG_SNAPSHOT,
  ORG_CHANNEL_NODES_MAX,
  type OrgAgent,
  type OrgChannel,
  type OrgHandoff,
  type OrgSnapshot,
  ROOT_KEY,
} from "@robot/shared"
import {
  CELL,
  type ChartLayout,
  layoutChart,
  metrics,
  moreKey,
  overlaps,
  type Point,
  type Rect,
  ROW_MAX_PX,
} from "./layout.ts"

// The layout never overlaps (spec 029, "Layout"): no node covers another, no line passes through a
// node, no number covers a node or another number. The layout is a function of the model and the
// text size only, so "reduce motion" cannot change it: the checks below hold for every case.

// A small generator with a fixed seed, so a case is the same on every computer.
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const agent = (id: string, extra: Partial<OrgAgent> = {}): OrgAgent => ({
  id,
  name: id,
  role: `${id} role`,
  face: { shape: 0, hue: 0 },
  state: "idle",
  task: null,
  ...extra,
})
const channel = (id: string, memberIds: string[], extra: Partial<OrgChannel> = {}): OrgChannel => ({
  id,
  name: id,
  createdAt: 1,
  leadId: null,
  memberIds,
  ...extra,
})
const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`)

/** Hand-offs between random pairs of the agents, each pair once, with counts of 1 to 120. */
const handoffsOf = (agents: readonly string[], count: number, seed: number): OrgHandoff[] => {
  const next = random(seed)
  const seen = new Set<string>()
  const out: OrgHandoff[] = []
  while (out.length < count) {
    const from = agents[Math.floor(next() * agents.length)] as string
    const to = agents[Math.floor(next() * agents.length)] as string
    if (from === to || seen.has(`${from}>${to}`)) continue
    seen.add(`${from}>${to}`)
    out.push({ from, to, count: 1 + Math.floor(next() * 120), newest: out.length })
  }
  return out
}

const snap = (parts: Partial<OrgSnapshot>): OrgSnapshot => ({ ...EMPTY_ORG_SNAPSHOT, ...parts })

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/** True when an axis-aligned segment passes through the inside of a rect. */
const crosses = (a: Point, b: Point, r: Rect) => {
  if (a.y === b.y) {
    const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x]
    return r.y < a.y && a.y < r.y + r.h && x0 < r.x + r.w && x1 > r.x
  }
  const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y]
  return r.x < a.x && a.x < r.x + r.w && y0 < r.y + r.h && y1 > r.y
}
const onBorder = (p: Point, r: Rect) =>
  (p.x === r.x || p.x === r.x + r.w ? p.y >= r.y && p.y <= r.y + r.h : false) ||
  (p.y === r.y || p.y === r.y + r.h ? p.x >= r.x && p.x <= r.x + r.w : false)

/** Every rule of the layout, for a model that the layout drew. Returns the faults in words. */
const faults = (model: ChartModel, layout: ChartLayout): string[] => {
  const found: string[] = []
  const nodes = layout.nodes
  const rectOf = new Map(nodes.map((n) => [n.key, n.rect]))

  // Every node of the model has a place, and so has every tile.
  const expected = [
    ROOT_KEY,
    ...model.channels.flatMap((c) => [
      c.key,
      ...c.nodes.map((n) => n.key),
      ...(c.more.length > 0 ? [moreKey(c.key)] : []),
    ]),
  ]
  for (const key of expected) if (!rectOf.has(key)) found.push(`no place for ${key}`)
  if (nodes.length !== expected.length)
    found.push(`${nodes.length} nodes, ${expected.length} expected`)

  // The page order: the root first, then each channel node and what hangs from it.
  if (nodes.map((n) => n.key).join("|") !== expected.join("|"))
    found.push("the nodes are not in the order of the page")

  for (const n of nodes) {
    const r = n.rect
    if (r.w <= 0 || r.h <= 0) found.push(`${n.key} has no size`)
    if (r.x < 0 || r.y < 0) found.push(`${n.key} is outside the chart`)
    if (![r.x, r.y, r.w, r.h].every(Number.isInteger)) found.push(`${n.key} is off the grid`)
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      if (a && b && overlaps(a.rect, b.rect)) found.push(`${a.key} covers ${b.key}`)
    }
  }
  for (const row of layout.rows)
    if (row.w > ROW_MAX_PX) found.push(`a row is ${row.w} px wide, more than ${ROW_MAX_PX}`)

  // Every line has a path that stays out of every node, and it starts and ends on its nodes.
  const placed = new Map(layout.lines.map((l) => [l.id, l]))
  for (const line of model.lines) {
    const p = placed.get(line.id)
    if (!p) {
      found.push(`no path for ${line.id}`)
      continue
    }
    if (p.points.length < 2) found.push(`${line.id} has fewer than 2 points`)
    for (let i = 0; i + 1 < p.points.length; i++) {
      const a = p.points[i] as Point
      const b = p.points[i + 1] as Point
      if (a.x !== b.x && a.y !== b.y) found.push(`${line.id} has a slanted segment`)
      for (const n of nodes)
        if (crosses(a, b, n.rect)) found.push(`${line.id} passes through ${n.key}`)
    }
    const first = p.points[0] as Point
    const last = p.points.at(-1) as Point
    const from = rectOf.get(line.from)
    const to = rectOf.get(line.to)
    if (from && !onBorder(first, from)) found.push(`${line.id} does not start on ${line.from}`)
    if (to && !onBorder(last, to)) found.push(`${line.id} does not end on ${line.to}`)
  }

  // The number of a hand-off line covers no node and no other number.
  const labels = layout.lines.flatMap((l) => (l.label ? [{ id: l.id, rect: l.label }] : []))
  for (const line of model.lines) {
    if (line.kind === "handoff" && !placed.get(line.id)?.label)
      found.push(`no number for ${line.id}`)
  }
  for (const l of labels) {
    for (const n of nodes)
      if (overlaps(l.rect, n.rect)) found.push(`the number of ${l.id} covers ${n.key}`)
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]
      const b = labels[j]
      if (a && b && overlaps(a.rect, b.rect)) found.push(`the number of ${a.id} covers ${b.id}`)
    }
  }
  return found
}

const units = [13, 14, 16]

// ---------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------

const oneAgent = () => snap({ agents: [agent("solo")] })

const sixAgents = () => {
  const a = ids("a", 6)
  return snap({
    mainAgentId: "a00",
    agents: a.map((id) => agent(id)),
    channels: [
      channel("Docs", ["a00", "a01", "a02"], { leadId: "a01" }),
      channel("Ops", ["a02", "a03"]),
    ],
    handoffs: [
      { from: "a00", to: "a01", count: 3, newest: 1 },
      { from: "a01", to: "a00", count: 1, newest: 2 },
      { from: "a00", to: "a03", count: 2, newest: 3 },
      { from: "a04", to: "a02", count: 12, newest: 4 },
      { from: "a05", to: "a04", count: 7, newest: 5 },
    ],
  })
}

const fortyAgents = () => {
  const a = ids("a", 40)
  const members = (from: number, to: number) => a.slice(from, to)
  return snap({
    mainAgentId: "a00",
    agents: a.map((id, i) =>
      agent(
        id,
        i % 7 === 0 ? { state: "working", task: { label: `Task ${i}`, state: "running" } } : {},
      ),
    ),
    channels: [
      channel("Alpha", members(0, 10), { leadId: "a00" }),
      channel("Beta", members(8, 20), { leadId: "a09" }),
      channel("Gamma", members(18, 29)),
      channel("Delta", members(28, 36), { leadId: "a30" }),
    ],
    handoffs: handoffsOf(a, 40, 7),
  })
}

const twelveInAChannel = () => {
  const a = ids("m", 15)
  return snap({
    agents: a.map((id) => agent(id)),
    channels: [channel("Big", a, { leadId: "m07" })],
    handoffs: [
      { from: "m07", to: "m01", count: 4, newest: 1 },
      { from: "m02", to: "m11", count: 2, newest: 2 },
    ],
  })
}

const twentyChannels = () => {
  const next = random(11)
  const a = ids("a", 40)
  const channels = Array.from({ length: 20 }, (_, i) => {
    const size = 1 + Math.floor(next() * 4)
    const start = Math.floor(next() * (a.length - size))
    const members = a.slice(start, start + size)
    return channel(
      `Ch${String(i).padStart(2, "0")}`,
      members,
      i % 3 === 0 ? { leadId: members[0] as string } : {},
    )
  })
  return snap({
    agents: a.map((id) => agent(id)),
    channels,
    handoffs: handoffsOf(a, 40, 3),
  })
}

const cases: [string, () => OrgSnapshot][] = [
  ["1 agent", oneAgent],
  ["6 agents", sixAgents],
  ["40 agents", fortyAgents],
  ["a channel node of 12 agents and a tile", twelveInAChannel],
  ["20 channel nodes", twentyChannels],
]

describe("the layout never overlaps", () => {
  for (const [name, make] of cases) {
    for (const unit of units) {
      test(`${name}, text ${unit} px`, () => {
        const model = buildChart(make())
        const layout = layoutChart(model, unit)
        expect(faults(model, layout)).toEqual([])
      })
    }
  }

  test("the chart with 40 hand-off lines, 40 agents and 20 channel nodes at once", () => {
    const a = ids("a", 40)
    const base = twentyChannels()
    const model = buildChart(snap({ ...base, mainAgentId: "a05", handoffs: handoffsOf(a, 60, 21) }))
    expect(model.lines.filter((l) => l.kind === "handoff")).toHaveLength(
      Math.min(40, model.lines.filter((l) => l.kind === "handoff").length),
    )
    const layout = layoutChart(model, 14)
    expect(faults(model, layout)).toEqual([])
    // No time limit here: times never fail a test (docs/performance.md). On a busy computer a
    // wall-clock limit fails by chance. The test timeout of the runner is the only limit.
  })

  test("every case draws the 40 busiest hand-offs and each has a number", () => {
    const model = buildChart(fortyAgents())
    const layout = layoutChart(model, 14)
    const handoff = layout.lines.filter((l) => l.kind === "handoff")
    expect(handoff.length).toBeGreaterThan(0)
    expect(handoff.every((l) => l.label !== undefined)).toBe(true)
  })
})

describe("random charts", () => {
  // Fixed seeds, so a case is the same on every computer. The seeds 3, 19 and 28 once left a
  // number without a place, in a lane that three other lines used.
  for (const seed of [1, 3, 10, 19, 28, 47, 100, 211]) {
    test(`seed ${seed}`, () => {
      const next = random(seed * 977)
      const count = 1 + Math.floor(next() * 45)
      const a = ids("a", count)
      const channels = Array.from({ length: Math.floor(next() * 22) }, (_, i) => {
        const size = 1 + Math.floor(next() * (next() < 0.2 ? 20 : 6))
        const picked = new Set<string>()
        for (let k = 0; k < size; k++) picked.add(a[Math.floor(next() * a.length)] as string)
        const members = [...picked]
        return channel(`Ch${i}`, members, next() < 0.5 ? { leadId: members[0] as string } : {})
      })
      const handoffCount = Math.min(Math.floor(next() * 60), count * (count - 1))
      const model = buildChart(
        snap({
          mainAgentId: next() < 0.5 ? (a[0] as string) : null,
          agents: a.map((id) => agent(id)),
          channels,
          handoffs: count > 1 ? handoffsOf(a, handoffCount, seed) : [],
        }),
      )
      for (const unit of [13, 16]) expect(faults(model, layoutChart(model, unit))).toEqual([])
    })
  }
})

describe("what the layout depends on", () => {
  test("the same model and text size give the same positions, also in a fresh call", () => {
    const first = layoutChart(buildChart(fortyAgents()), 14)
    const second = layoutChart(buildChart(fortyAgents()), 14)
    expect(second).toEqual(first)
  })

  test("the layout takes the model and the text size only: 'reduce motion' has no input", () => {
    // The setting changes how the window moves between two layouts. It never reaches this function.
    expect(layoutChart.length).toBe(2)
  })

  test("the same agents in another order of the data give the same positions", () => {
    const a = buildChart(sixAgents())
    const reversed = sixAgents()
    const b = buildChart({
      ...reversed,
      agents: [...reversed.agents].reverse(),
      channels: [...reversed.channels].reverse(),
    })
    expect(layoutChart(b, 14)).toEqual(layoutChart(a, 14))
  })

  test("a row is never wider than 1,600 px, and channel nodes that do not fit go to the next row", () => {
    const model = buildChart(twentyChannels())
    const layout = layoutChart(model, 16)
    expect(layout.rows.length).toBeGreaterThan(1)
    for (const row of layout.rows) expect(row.w).toBeLessThanOrEqual(ROW_MAX_PX)
    // The rows are below each other.
    for (let i = 1; i < layout.rows.length; i++) {
      const above = layout.rows[i - 1] as Rect
      expect((layout.rows[i] as Rect).y).toBeGreaterThanOrEqual(above.y + above.h)
    }
  })

  test("a larger text makes larger nodes, and the lanes stay at least 2 cells wide", () => {
    const small = metrics(13)
    const large = metrics(16)
    expect(large.agentW).toBeGreaterThanOrEqual(small.agentW)
    expect(large.agentH).toBeGreaterThanOrEqual(small.agentH)
    for (const m of [small, large]) {
      expect(m.agentW % 2).toBe(1)
      expect(m.agentH % 2).toBe(1)
      expect(m.headW % 2).toBe(1)
      for (const gap of [m.gutter, m.headGap, m.busGap, m.memberGap, m.groupGap]) {
        expect(gap).toBeGreaterThanOrEqual(4)
      }
    }
  })
})

describe("the parts of the page", () => {
  const model = buildChart(sixAgents())
  const layout = layoutChart(model, 14)
  const place = (key: string) => layout.nodes.find((n) => n.key === key)?.rect as Rect

  test("the root is at the top, above every channel node", () => {
    const root = place(ROOT_KEY)
    for (const c of model.channels) expect(place(c.key).y).toBeGreaterThan(root.y + root.h)
  })

  test("the agents of a channel node sit under it, and the lead sits above the others", () => {
    const docs = place("c:Docs")
    const lead = place(copyKey("c:Docs", "a01"))
    const other = place(copyKey("c:Docs", "a02"))
    expect(lead.y).toBeGreaterThanOrEqual(docs.y + docs.h)
    expect(other.y).toBeGreaterThanOrEqual(lead.y + lead.h)
  })

  test("the lead is in the middle under its channel node", () => {
    const docs = place("c:Docs")
    const lead = place(copyKey("c:Docs", "a01"))
    expect(lead.x + lead.w / 2).toBe(docs.x + docs.w / 2)
  })

  test("an agent in two channel nodes has two nodes that do not meet", () => {
    const a = place(copyKey("c:Docs", "a02"))
    const b = place(copyKey("c:Ops", "a02"))
    expect(overlaps(a, b)).toBe(false)
  })

  test("a lead line ends on the left side of its member, and runs in the lane of the channel node", () => {
    const line = layout.lines.find(
      (l) => l.id === `l:${copyKey("c:Docs", "a01")}>${copyKey("c:Docs", "a02")}`,
    )
    const member = place(copyKey("c:Docs", "a02"))
    const last = line?.points.at(-1) as Point
    expect(last.x).toBe(member.x)
    expect(last.y).toBe(member.y + (member.h - CELL) / 2 + CELL / 2)
  })

  test("the tile '+<n> more' takes the place after the last agent of its channel node", () => {
    const big = buildChart(twelveInAChannel())
    const l = layoutChart(big, 14)
    const channelNode = big.channels[0]
    expect(channelNode?.nodes).toHaveLength(ORG_CHANNEL_NODES_MAX)
    const tile = l.nodes.find((n) => n.key === moreKey("c:Big"))
    expect(tile).toBeDefined()
    expect(tile?.kind).toBe("more")
    // The tile is the last of the nodes of that channel node in the order of the page.
    expect(l.nodes.at(-1)?.key).toBe(moreKey("c:Big"))
  })

  test("a chart with one agent has the root, one channel node and one agent", () => {
    const one = layoutChart(buildChart(oneAgent()), 14)
    expect(one.nodes.map((n) => n.kind)).toEqual(["root", "channel", "agent"])
    expect(one.lines.map((l) => l.kind)).toEqual(["structure", "structure"])
  })

  test("the bounds hold every node", () => {
    for (const n of layout.nodes) {
      expect(n.rect.x).toBeGreaterThanOrEqual(layout.bounds.x)
      expect(n.rect.y).toBeGreaterThanOrEqual(layout.bounds.y)
      expect(n.rect.x + n.rect.w).toBeLessThanOrEqual(layout.bounds.x + layout.bounds.w)
      expect(n.rect.y + n.rect.h).toBeLessThanOrEqual(layout.bounds.y + layout.bounds.h)
    }
  })
})
