import { type ChartLineKind, type ChartModel, type ChartOrg, ROOT_KEY } from "@robot/shared"

// The positions of the org chart (spec 029, "Layout"). The window computes them from the model of
// the chart and the size of the text. The result does not depend on an animation, on the setting
// "reduce motion", on the order of events or on the computer: the same model and the same text
// size give the same positions.
//
// Everything sits on a grid of CELL px. A node is a whole number of cells, and the gaps between
// nodes are at least 4 cells, so every node has a free lane of at least 2 cells on each side. The
// lines run in those lanes: the lead lines run in the gutters of their own organization node, and every
// other line is routed around the nodes on the grid (a search of the shortest path with a small
// price for each bend). So no line passes through a node, and the numbers on the lines sit where
// they cover no node and no other number.

/** The size of one grid cell, in px at zoom 100%. */
export const CELL = 16
/** A row of organization nodes is at most this wide at zoom 100% (spec 029). */
export const ROW_MAX_PX = 1600

export interface Point {
  readonly x: number
  readonly y: number
}
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type PlacedKind = "root" | "org" | "agent" | "more"

export interface PlacedNode {
  /** The key of the node in the model. The tile "+<n> more" has the key `<organization>/+more`. */
  readonly key: string
  readonly kind: PlacedKind
  readonly rect: Rect
  /** The key of the organization node that holds an agent node or a tile. */
  readonly parent: string | null
}

export interface PlacedLine {
  readonly id: string
  readonly kind: ChartLineKind
  /** The corners of the line, in px. Every segment is horizontal or vertical. */
  readonly points: readonly Point[]
  /** The place of the number of a hand-off line. */
  readonly label?: Rect
}

export interface ChartLayout {
  readonly nodes: readonly PlacedNode[]
  readonly lines: readonly PlacedLine[]
  /** The box around all nodes. The view fits to it. */
  readonly bounds: Rect
  /** The box of each row of organization nodes, for the limit of the width of a row. */
  readonly rows: readonly Rect[]
}

export const moreKey = (orgKey: string) => `${orgKey}/+more`

/** The sizes of the parts, in cells, for a text size. `unit` is the size of the root text in px. */
export const metrics = (unit: number) => {
  const cells = (px: number) => Math.ceil(px / CELL)
  // A node has an odd number of cells on each side, so the middle of a side is the middle of a cell.
  const odd = (n: number) => (n % 2 === 0 ? n + 1 : n)
  // An odd number of cells, kept even so that it adds to an odd one and the sum stays odd.
  const even = (n: number) => (n % 2 === 1 ? n + 1 : n)
  return {
    agentW: odd(cells(15.5 * unit)),
    agentH: odd(cells(6.8 * unit)),
    headW: odd(cells(21 * unit)),
    // The name, the counts and the outcome of the node (spec 029, "Organization node"): three lines.
    headH: odd(cells(6.4 * unit)),
    /** One more line, for the goal of an organization that has one (spec 030, "Goal"). It is an
     * even number of cells, so that an odd header plus a goal line stays odd: the middle of a side
     * of an organization node must be the middle of a cell (see "ports"). */
    goalH: even(cells(1.9 * unit)),
    /** The lane between two columns, and at the left and right of a organization node. */
    gutter: 4,
    /** From the header of a organization node to its lead or its first row. */
    headGap: 4,
    /** From the lead to the first row of the others. */
    busGap: 4,
    /** Between two rows of agent nodes. */
    memberGap: 4,
    /** Between two organization nodes in a row. */
    groupGap: 6,
    /** Between two rows of organization nodes. */
    rowGap: 7,
    /** From the root to the first row. */
    rootGap: 7,
    /** Free space around the chart, for lines that run along the edge. */
    margin: 6,
    /** The label of a hand-off line, in px. */
    labelH: Math.ceil(1.45 * unit * 0.85 + 0.3 * unit),
    labelDigitW: 0.58 * unit,
    labelPad: 0.9 * unit,
  }
}
type Metrics = ReturnType<typeof metrics>

// ---------------------------------------------------------------------------------------------
// Placing the nodes
// ---------------------------------------------------------------------------------------------

/** A box on the grid, in cells. */
interface Box {
  readonly key: string
  readonly kind: PlacedKind
  readonly parent: string | null
  x: number
  y: number
  readonly w: number
  readonly h: number
}

interface Group {
  readonly org: ChartOrg
  readonly w: number
  readonly h: number
  /** Boxes relative to the group, in cells. */
  readonly boxes: readonly Box[]
  /** The cell row of the bus between the lead (or the header) and the first row, relative. */
  readonly busY: number
  readonly leadKey: string | null
  /** The key and the column of each member in the grid. */
  readonly members: readonly { key: string; col: number }[]
  readonly columnX: readonly number[]
}

const placeGroup = (org: ChartOrg, m: Metrics, rowMaxCells: number): Group => {
  const lead = org.leadKey ? org.nodes.find((n) => n.key === org.leadKey) : undefined
  const others = org.nodes.filter((n) => n !== lead)
  const slots = others.length + (org.more.length > 0 ? 1 : 0)
  const widest = Math.max(1, Math.floor((rowMaxCells - m.gutter) / (m.agentW + m.gutter)))
  // A small team stands in one or two columns, so that a chart of a few agents is not wide and
  // "Fit to view" keeps the text large enough to read. A full organization node (12 and the tile) has 4.
  const cols = Math.min(widest, slots <= 2 ? 1 : slots <= 6 ? 2 : slots <= 12 ? 3 : 4)
  const gridW = m.gutter + cols * (m.agentW + m.gutter)
  let w = Math.max(gridW, m.headW + 2)
  // An odd width puts the middle of the header and of the lead on the middle of a cell.
  if (w % 2 === 0) w += 1

  // An organization with a goal takes one more line, for the goal (spec 030, "Goal"). The height
  // stays an odd number of cells: the ports of a node sit in the middle of a side, and the middle
  // of an odd span is the middle of a cell. `goalH` is even, so an odd `headH` plus it is odd.
  const headH = org.goal === null ? m.headH : m.headH + m.goalH
  const boxes: Box[] = [
    {
      key: org.key,
      kind: "org",
      parent: null,
      x: (w - m.headW) / 2,
      y: 0,
      w: m.headW,
      h: headH,
    },
  ]
  let y = headH + m.headGap
  let busY = headH + 2
  if (lead) {
    boxes.push({
      key: lead.key,
      kind: "agent",
      parent: org.key,
      x: (w - m.agentW) / 2,
      y,
      w: m.agentW,
      h: m.agentH,
    })
    busY = y + m.agentH + 2
    y += m.agentH + m.busGap
  }
  const columnX = Array.from({ length: cols }, (_, c) => m.gutter + c * (m.agentW + m.gutter))
  const members: { key: string; col: number }[] = []
  const slotted = [
    ...others.map((n) => ({ key: n.key, kind: "agent" as const })),
    ...(org.more.length > 0 ? [{ key: moreKey(org.key), kind: "more" as const }] : []),
  ]
  slotted.forEach((s, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    boxes.push({
      key: s.key,
      kind: s.kind,
      parent: org.key,
      x: columnX[col] as number,
      y: y + row * (m.agentH + m.memberGap),
      w: m.agentW,
      h: m.agentH,
    })
    if (s.kind === "agent") members.push({ key: s.key, col })
  })
  const rows = Math.ceil(slotted.length / cols)
  const h = rows > 0 ? y + rows * m.agentH + (rows - 1) * m.memberGap : y - m.busGap + 0
  return { org, w, h, boxes, busY, leadKey: lead?.key ?? null, members, columnX }
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

type Side = "top" | "right" | "bottom" | "left"
const SIDES: readonly Side[] = ["top", "right", "bottom", "left"]
const DIRS = [
  { dx: 0, dy: -1 }, // up
  { dx: 1, dy: 0 }, // right
  { dx: 0, dy: 1 }, // down
  { dx: -1, dy: 0 }, // left
] as const
/** The direction that leaves a side. */
const OUT: Record<Side, number> = { top: 0, right: 1, bottom: 2, left: 3 }

class MinHeap {
  readonly #f: number[] = []
  readonly #s: number[] = []
  readonly #seq: number[] = []
  #n = 0
  get size() {
    return this.#f.length
  }
  #less(a: number, b: number) {
    return (
      (this.#f[a] as number) < (this.#f[b] as number) ||
      ((this.#f[a] as number) === (this.#f[b] as number) &&
        (this.#seq[a] as number) < (this.#seq[b] as number))
    )
  }
  #swap(a: number, b: number) {
    for (const arr of [this.#f, this.#s, this.#seq]) {
      const t = arr[a] as number
      arr[a] = arr[b] as number
      arr[b] = t
    }
  }
  push(f: number, state: number) {
    this.#f.push(f)
    this.#s.push(state)
    this.#seq.push(this.#n++)
    let i = this.#f.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.#less(i, p)) break
      this.#swap(i, p)
      i = p
    }
  }
  pop(): number {
    const top = this.#s[0] as number
    const last = this.#f.length - 1
    this.#swap(0, last)
    this.#f.pop()
    this.#s.pop()
    this.#seq.pop()
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let s = i
      if (l < this.#f.length && this.#less(l, s)) s = l
      if (r < this.#f.length && this.#less(r, s)) s = r
      if (s === i) break
      this.#swap(i, s)
      i = s
    }
    return top
  }
}

interface Port {
  readonly side: Side
  /** The cell next to the middle of the side. */
  readonly cell: number
  /** Where the line meets the border of the node, in px. */
  readonly border: Point
}

class Grid {
  readonly w: number
  readonly h: number
  readonly blocked: Uint8Array
  /** How many hand-off lines use a cell. */
  readonly handoffUse: Uint8Array
  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.blocked = new Uint8Array(w * h)
    this.handoffUse = new Uint8Array(w * h)
  }
  index(x: number, y: number) {
    return y * this.w + x
  }
  /** Blocks the cells of a box and the ring of one cell around it. */
  block(box: Box) {
    for (let y = Math.max(0, box.y - 1); y <= Math.min(this.h - 1, box.y + box.h); y++) {
      for (let x = Math.max(0, box.x - 1); x <= Math.min(this.w - 1, box.x + box.w); x++) {
        this.blocked[this.index(x, y)] = 1
      }
    }
  }
  /**
   * The places where a line can leave or enter a node: the middle of a side, and when `spread` is
   * set also a place to each side of the middle (4 cells on the top and the bottom, 2 on the left
   * and the right). A node whose lines all use the middle of a side would put them on one lane;
   * the two other places give the lines of one node more lanes, so that their numbers fit side by
   * side.
   */
  ports(box: Box, sides: readonly Side[] = SIDES, spread = false): Port[] {
    const out: Port[] = []
    const cx = box.x + (box.w - 1) / 2
    const cy = box.y + (box.h - 1) / 2
    for (const side of sides) {
      const reach = side === "top" || side === "bottom" ? 4 : 2
      const shifts = spread ? [0, -reach, reach] : [0]
      for (const k of shifts) {
        if (side === "top" || side === "bottom") {
          const x = cx + k
          const y = side === "top" ? box.y - 1 : box.y + box.h
          out.push({
            side,
            cell: this.index(x, y),
            border: { x: (x + 0.5) * CELL, y: (side === "top" ? box.y : box.y + box.h) * CELL },
          })
        } else {
          const y = cy + k
          const x = side === "left" ? box.x - 1 : box.x + box.w
          out.push({
            side,
            cell: this.index(x, y),
            border: { x: (side === "left" ? box.x : box.x + box.w) * CELL, y: (y + 0.5) * CELL },
          })
        }
      }
    }
    return out
  }
  center(cell: number): Point {
    return { x: ((cell % this.w) + 0.5) * CELL, y: (Math.floor(cell / this.w) + 0.5) * CELL }
  }
}

const BEND = 2
const REUSE_COST = 1.5

/**
 * The shortest paths, around every node, from the ports of one node to the ports of the others
 * (the lines of the root go down to the organization nodes). One search finds all of them, and the
 * paths share their first part, so they merge into trunks like the branches of a tree.
 */
const searchTree = (
  grid: Grid,
  from: readonly Port[],
  to: readonly Port[],
  step: (next: number) => number = () => 1,
) => {
  const n = grid.w * grid.h
  const g = new Float64Array(n * 4).fill(Number.POSITIVE_INFINITY)
  const parent = new Int32Array(n * 4).fill(-1)
  const goals = new Set(to.map((p) => p.cell))
  const reached = new Map<number, number>()
  const heap = new MinHeap()
  const freed: number[] = []
  for (const p of [...from, ...to]) {
    if (grid.blocked[p.cell]) {
      grid.blocked[p.cell] = 0
      freed.push(p.cell)
    }
  }
  for (const p of from) {
    const s = p.cell * 4 + OUT[p.side]
    g[s] = 0
    heap.push(0, s)
  }
  while (heap.size > 0 && reached.size < goals.size) {
    const state = heap.pop()
    const cell = state >> 2
    const dir = state & 3
    const here = g[state] as number
    if (goals.has(cell) && !reached.has(cell)) reached.set(cell, state)
    expand(grid, g, parent, heap, state, cell, dir, here, step, 0)
  }
  for (const c of freed) grid.blocked[c] = 1
  const paths = new Map<number, number[]>()
  for (const [cell, state] of reached) {
    const cells: number[] = []
    for (let s = state; s >= 0; s = parent[s] as number) cells.push(s >> 2)
    paths.set(cell, cells.reverse())
  }
  return paths
}

/** Tries the four moves from a state, and puts the cheaper ones in the queue. */
const expand = (
  grid: Grid,
  g: Float64Array,
  parent: Int32Array,
  heap: MinHeap,
  state: number,
  cell: number,
  dir: number,
  here: number,
  step: (next: number) => number,
  heuristicFactor: number,
  heuristic?: (cell: number) => number,
) => {
  const x = cell % grid.w
  const y = Math.floor(cell / grid.w)
  for (let d = 0; d < 4; d++) {
    // A line never turns back on itself.
    if (d === (dir + 2) % 4) continue
    const nx = x + (DIRS[d] as { dx: number }).dx
    const ny = y + (DIRS[d] as { dy: number }).dy
    if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue
    const next = grid.index(nx, ny)
    if (grid.blocked[next]) continue
    const cost = here + step(next) + (d === dir ? 0 : BEND)
    const s = next * 4 + d
    if (cost < (g[s] as number)) {
      g[s] = cost
      parent[s] = state
      heap.push(cost + (heuristic ? heuristic(next) * heuristicFactor : 0), s)
    }
  }
}

/**
 * The shortest path of cells between a port of one node and a port of another, around every node.
 * A hand-off line pays for a cell that a hand-off line uses already, so the two ways between two
 * nodes, and lines that cross the same lane, take other lanes when there are some.
 */
const search = (grid: Grid, from: readonly Port[], to: readonly Port[]): number[] | undefined => {
  const n = grid.w * grid.h
  const g = new Float64Array(n * 4).fill(Number.POSITIVE_INFINITY)
  const parent = new Int32Array(n * 4).fill(-1)
  const goals = new Set(to.map((p) => p.cell))
  const goalCells = [...goals].map((c) => ({ x: c % grid.w, y: Math.floor(c / grid.w) }))
  const heap = new MinHeap()
  const heuristic = (cell: number) => {
    const x = cell % grid.w
    const y = Math.floor(cell / grid.w)
    let best = Number.POSITIVE_INFINITY
    for (const t of goalCells) best = Math.min(best, Math.abs(t.x - x) + Math.abs(t.y - y))
    return best
  }
  // The cells of the ports are free for this one line.
  const freed: number[] = []
  for (const p of [...from, ...to]) {
    if (grid.blocked[p.cell]) {
      grid.blocked[p.cell] = 0
      freed.push(p.cell)
    }
  }
  for (const p of from) {
    const s = p.cell * 4 + OUT[p.side]
    g[s] = 0
    heap.push(heuristic(p.cell), s)
  }
  let found = -1
  while (heap.size > 0) {
    const state = heap.pop()
    const cell = state >> 2
    if (goals.has(cell)) {
      found = state
      break
    }
    expand(
      grid,
      g,
      parent,
      heap,
      state,
      cell,
      state & 3,
      g[state] as number,
      (next) => 1 + REUSE_COST * (grid.handoffUse[next] as number),
      1,
      heuristic,
    )
  }
  for (const c of freed) grid.blocked[c] = 1
  if (found < 0) return undefined
  const cells: number[] = []
  for (let s = found; s >= 0; s = parent[s] as number) cells.push(s >> 2)
  cells.reverse()
  for (const c of cells) grid.handoffUse[c] = Math.min(255, (grid.handoffUse[c] as number) + 1)
  return cells
}

/** Drops repeated points and the middle point of three points on one line. */
const simplify = (points: readonly Point[]): Point[] => {
  const out: Point[] = []
  for (const p of points) {
    const last = out.at(-1)
    if (last && last.x === p.x && last.y === p.y) continue
    out.push(p)
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1] as Point
    const b = out[i] as Point
    const c = out[i + 1] as Point
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------------------------

const px = (c: number) => c * CELL

/** Places the nodes and the lines of a chart for a text size (`unit`, the root text in px). */
export const layoutChart = (model: ChartModel, unit: number): ChartLayout => {
  const m = metrics(unit)
  const rowMaxCells = Math.floor(ROW_MAX_PX / CELL)
  const groups = model.orgs.map((c) => placeGroup(c, m, rowMaxCells))

  // A block is a organization node with the blocks of its sub-organizations (spec 030) in rows under it, one
  // level lower. The top blocks sit in rows under the root. Rows go left to right, then the next
  // row, and a row is at most 1,600 px wide, also a row of sub-organizations.
  interface Row {
    readonly blocks: { block: Block; x: number }[]
    w: number
    h: number
  }
  interface Block {
    readonly group: Group
    /** The rows of the sub-organization blocks, relative to the block. */
    readonly rows: readonly { row: Row; x: number; y: number }[]
    /** Where the group sits in the block. */
    readonly gx: number
    readonly w: number
    readonly h: number
  }
  const packRows = (blocks: readonly Block[]): Row[] => {
    const rows: Row[] = []
    let current: Row | undefined
    for (const block of blocks) {
      if (
        !current ||
        (current.blocks.length > 0 && current.w + m.groupGap + block.w > rowMaxCells)
      ) {
        current = { blocks: [], w: 0, h: 0 }
        rows.push(current)
      }
      const x = current.blocks.length === 0 ? 0 : current.w + m.groupGap
      current.blocks.push({ block, x })
      current.w = x + block.w
      current.h = Math.max(current.h, block.h)
    }
    return rows
  }
  const children = new Map<string | null, Group[]>()
  for (const group of groups) {
    const up = group.org.parentKey
    children.set(up, [...(children.get(up) ?? []), group])
  }
  const blockOf = (group: Group): Block => {
    const rows = packRows((children.get(group.org.key) ?? []).map(blockOf))
    const rowsW = Math.max(0, ...rows.map((r) => r.w))
    const w = Math.max(group.w, rowsW)
    let y = group.h
    const placedRows = rows.map((row) => {
      y += m.rowGap
      const at = { row, x: Math.floor((w - row.w) / 2), y }
      y += row.h
      return at
    })
    return { group, rows: placedRows, gx: Math.floor((w - group.w) / 2), w, h: y }
  }
  const rows = packRows((children.get(null) ?? []).map(blockOf))
  const chartW = Math.max(m.agentW, ...rows.map((r) => r.w))

  // Absolute boxes in cells, with the margin around, in the order of the page: a organization node,
  // what hangs from it, then the blocks of its sub-organizations.
  const boxes: Box[] = []
  const root: Box = {
    key: ROOT_KEY,
    kind: "root",
    parent: null,
    x: m.margin + Math.floor((chartW - m.agentW) / 2),
    y: m.margin,
    w: m.agentW,
    h: m.agentH,
  }
  boxes.push(root)
  const placed: { group: Group; x: number; y: number }[] = []
  const rowRects: Rect[] = []
  const placeRow = (row: Row, x0: number, y0: number) => {
    rowRects.push({ x: px(x0), y: px(y0), w: px(row.w), h: px(row.h) })
    for (const { block, x } of row.blocks) placeBlock(block, x0 + x, y0)
  }
  const placeBlock = (block: Block, x0: number, y0: number) => {
    const gx = x0 + block.gx
    placed.push({ group: block.group, x: gx, y: y0 })
    for (const b of block.group.boxes) boxes.push({ ...b, x: gx + b.x, y: y0 + b.y })
    for (const r of block.rows) placeRow(r.row, x0 + r.x, y0 + r.y)
  }
  let y = m.margin + m.agentH + m.rootGap
  for (const row of rows) {
    placeRow(row, m.margin + Math.floor((chartW - row.w) / 2), y)
    y += row.h + m.rowGap
  }
  const totalW = chartW + 2 * m.margin
  const totalH = (rows.length > 0 ? y - m.rowGap : m.margin + m.agentH) + m.margin

  const byKey = new Map(boxes.map((b) => [b.key, b]))
  const grid = new Grid(totalW, totalH)
  for (const b of boxes) grid.block(b)
  const boxOf = (key: string) => byKey.get(key) as Box

  const lines = new Map<string, Point[]>()

  // Lead lines and the lines from a organization node to its members run in the lanes of the organization node.
  for (const { group, x, y: gy } of placed) {
    const header = boxOf(group.org.key)
    const busY = px(gy + group.busY) + CELL / 2
    const hx = px(header.x + (header.w - 1) / 2) + CELL / 2
    const hb = px(header.y + header.h)
    const toMember = (from: Point, key: string, col: number): Point[] => {
      const node = boxOf(key)
      // The lane left of the column of the member.
      const trunk = px(x + (group.columnX[col] as number) - 2) + CELL / 2
      const mid = px(node.y + (node.h - 1) / 2) + CELL / 2
      return simplify([
        from,
        { x: from.x, y: busY },
        { x: trunk, y: busY },
        { x: trunk, y: mid },
        { x: px(node.x), y: mid },
      ])
    }
    if (group.leadKey) {
      const lead = boxOf(group.leadKey)
      lines.set(`s:${group.org.key}>${group.leadKey}`, [
        { x: hx, y: hb },
        { x: hx, y: px(lead.y) },
      ])
      const from = { x: px(lead.x + (lead.w - 1) / 2) + CELL / 2, y: px(lead.y + lead.h) }
      for (const member of group.members) {
        lines.set(`l:${group.leadKey}>${member.key}`, toMember(from, member.key, member.col))
      }
    } else {
      for (const member of group.members) {
        lines.set(
          `s:${group.org.key}>${member.key}`,
          toMember({ x: hx, y: hb }, member.key, member.col),
        )
      }
    }
  }

  // The lines of the root: down to the top of a organization node. One search finds them all, and they
  // share their first part, so they merge into trunks.
  const rootLines = model.lines.filter((l) => l.kind === "structure" && l.from === ROOT_KEY)
  if (rootLines.length > 0) {
    const from = grid.ports(boxOf(ROOT_KEY), ["bottom"])
    const targets = rootLines.map((l) => ({
      line: l,
      port: (grid.ports(boxOf(l.to), ["top"]) as Port[])[0] as Port,
    }))
    const paths = searchTree(
      grid,
      from,
      targets.map((t) => t.port),
    )
    for (const { line, port } of targets) {
      const cells = paths.get(port.cell)
      if (cells) lines.set(line.id, route(grid, from, [port], cells))
    }
  }

  // The lines from a organization node to the organization nodes of its sub-organizations (spec 029, 030): from
  // a side of the header down to the top of each sub-organization node. The lines of one parent share
  // their first part. They keep off the lanes of the lead lines where they can.
  const laneUse = new Uint8Array(grid.w * grid.h)
  for (const [id, points] of lines) {
    if (!id.startsWith("l:") && !id.startsWith("s:")) continue
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as Point
      const b = points[i] as Point
      const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / (CELL / 2)
      for (let k = 0; k <= steps; k++) {
        const t = steps === 0 ? 0 : k / steps
        const cx = Math.floor((a.x + (b.x - a.x) * t) / CELL)
        const cy = Math.floor((a.y + (b.y - a.y) * t) / CELL)
        if (cx >= 0 && cy >= 0 && cx < grid.w && cy < grid.h) laneUse[grid.index(cx, cy)] = 1
      }
    }
  }
  const subLines = model.lines.filter(
    (l) =>
      l.kind === "structure" &&
      byKey.get(l.from)?.kind === "org" &&
      byKey.get(l.to)?.kind === "org",
  )
  const byParent = new Map<string, typeof subLines>()
  for (const l of subLines) byParent.set(l.from, [...(byParent.get(l.from) ?? []), l])
  for (const [parentKey, list] of byParent) {
    const from = grid.ports(boxOf(parentKey), ["left", "right"])
    const targets = list.map((l) => ({
      line: l,
      port: (grid.ports(boxOf(l.to), ["top"]) as Port[])[0] as Port,
    }))
    const paths = searchTree(
      grid,
      from,
      targets.map((t) => t.port),
      (next) => 1 + 4 * (laneUse[next] as number),
    )
    for (const { line, port } of targets) {
      const cells = paths.get(port.cell)
      if (cells) lines.set(line.id, route(grid, from, [port], cells))
    }
  }

  // Hand-off lines: from any side of the sender to any side of the receiver.
  const handoffs = model.lines.filter((l) => l.kind === "handoff")
  const nodeRects = boxes.map((b) => ({ x: px(b.x), y: px(b.y), w: px(b.w), h: px(b.h) }))
  const routed: { id: string; cells: number[]; w: number }[] = []
  for (const line of handoffs) {
    const a = boxOf(line.from)
    const b = boxOf(line.to)
    const from = grid.ports(a, SIDES, true)
    const to = grid.ports(b, SIDES, true)
    const cells = search(grid, from, to)
    if (!cells) continue
    lines.set(line.id, route(grid, from, to, cells))
    const digits = String(line.count ?? 0).length
    routed.push({ id: line.id, cells, w: Math.ceil(digits * m.labelDigitW + m.labelPad) })
  }
  // The numbers: a short line has the fewest places for its number, so it chooses first.
  const labels = new Map<string, Rect>()
  const taken: Rect[] = []
  for (const r of [...routed].sort((a, b) => a.cells.length - b.cells.length)) {
    const spot = labelSpot(r.cells, grid, r.w, m.labelH, nodeRects, taken)
    if (spot) {
      labels.set(r.id, spot)
      taken.push(spot)
    }
  }

  const placedLines: PlacedLine[] = []
  for (const line of model.lines) {
    const points = lines.get(line.id)
    if (!points) continue
    const label = labels.get(line.id)
    placedLines.push({ id: line.id, kind: line.kind, points, ...(label ? { label } : {}) })
  }

  const placedNodes: PlacedNode[] = boxes.map((b) => ({
    key: b.key,
    kind: b.kind,
    parent: b.parent,
    rect: { x: px(b.x), y: px(b.y), w: px(b.w), h: px(b.h) },
  }))
  // The page order: the root, then each organization node followed by its agents and its tile.
  const bounds = union(placedNodes.map((n) => n.rect))
  return { nodes: placedNodes, lines: placedLines, bounds, rows: rowRects }
}

/** The corners of a routed line, from the border of the first node to the border of the second. */
const route = (
  grid: Grid,
  from: readonly Port[],
  to: readonly Port[],
  cells: number[],
): Point[] => {
  const first = cells[0] as number
  const last = cells[cells.length - 1] as number
  const a = from.find((p) => p.cell === first) as Port
  const b = to.find((p) => p.cell === last) as Port
  return simplify([a.border, ...cells.map((c) => grid.center(c)), b.border])
}

const union = (rects: readonly Rect[]): Rect => {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** True when two rects share area. A shared edge does not count. */
export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Where the number of a hand-off line goes: on the line, near its middle, where it covers no node
 * and no other number. The first free place counts from the middle outward.
 */
const labelSpot = (
  cells: readonly number[],
  grid: Grid,
  w: number,
  h: number,
  nodes: readonly Rect[],
  taken: readonly Rect[],
): Rect | undefined => {
  const middle = Math.floor(cells.length / 2)
  const order = cells
    .map((_, i) => i)
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b)
  const margin = 2
  // A lane between two nodes is 4 cells wide, and the centre of a cell is not always the middle of
  // the lane, and a crossing line may have its number there. So after the places on the line come
  // the places around it: half a cell, one cell, and so on, up to 4 cells away. The nearest free
  // place wins. In a lane that three other lines use, the number of a fourth line sits next to it.
  const rings = [0, 0.5, 1, 1.5, 2, 3, 4].map((k) => k * CELL)
  const free = (rect: Rect) => {
    const grown = { x: rect.x - margin, y: rect.y - margin, w: w + 2 * margin, h: h + 2 * margin }
    return !nodes.some((n) => overlaps(grown, n)) && !taken.some((t) => overlaps(grown, t))
  }
  for (const r of rings) {
    const shifts =
      r === 0
        ? [{ dx: 0, dy: 0 }]
        : [
            { dx: r, dy: 0 },
            { dx: -r, dy: 0 },
            { dx: 0, dy: r },
            { dx: 0, dy: -r },
            { dx: r, dy: r },
            { dx: -r, dy: r },
            { dx: r, dy: -r },
            { dx: -r, dy: -r },
          ]
    for (const s of shifts) {
      for (const i of order) {
        const c = grid.center(cells[i] as number)
        const rect = { x: c.x + s.dx - w / 2, y: c.y + s.dy - h / 2, w, h }
        if (free(rect)) return rect
      }
    }
  }
  return undefined
}
