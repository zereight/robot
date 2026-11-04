import { describe, expect, test } from "bun:test"
import {
  type AgentState,
  buildChart,
  type ChartModel,
  type OrgAgent,
  type OrgChannel,
  type OrgHandoff,
  type OrgSnapshot,
} from "@robot/shared"
import { buildOrgList } from "./list.ts"

const agent = (
  id: string,
  extra: Partial<Omit<OrgAgent, "id">> & { state?: AgentState } = {},
): OrgAgent => ({
  id,
  name: id,
  role: "",
  face: { shape: 0, hue: 0 },
  state: "idle",
  task: null,
  ...extra,
})
const channel = (
  id: string,
  members: readonly string[],
  extra: Partial<Omit<OrgChannel, "id" | "memberIds">> = {},
): OrgChannel => ({ id, name: id, createdAt: 1, leadId: null, memberIds: members, ...extra })
const handoff = (from: string, to: string, count = 1, newest = 1): OrgHandoff => ({
  from,
  to,
  count,
  newest,
})
const snapshot = (parts: Partial<OrgSnapshot>): OrgSnapshot => ({
  mainAgentId: null,
  agents: [],
  channels: [],
  handoffs: [],
  ...parts,
})
const listOf = (parts: Partial<OrgSnapshot>) => buildOrgList(buildChart(snapshot(parts)))

describe("the list of the org chart on the phone", () => {
  test("no agent: the list is empty and has nothing else", () => {
    const list = listOf({})
    expect(list.empty).toBe(true)
    expect(list.root).toEqual({ kind: "you" })
    expect(list.blocks).toEqual([])
    expect(list.handoffs).toEqual([])
    expect(list.handoffsCapped).toBe(false)
  })

  test("the root is You when no agent is the main agent", () => {
    const list = listOf({ agents: [agent("Ada")] })
    expect(list.empty).toBe(false)
    expect(list.root).toEqual({ kind: "you" })
  })

  test("the root is the main agent, with its state and task, and it keeps a copy in its channel", () => {
    const list = listOf({
      mainAgentId: "Ada",
      agents: [
        agent("Ada", {
          role: "Planner",
          state: "working",
          task: { label: "Plan", state: "running" },
        }),
        agent("Bo"),
      ],
      channels: [channel("Docs", ["Ada", "Bo"])],
    })
    expect(list.root).toMatchObject({
      kind: "main",
      agent: { agentId: "Ada", name: "Ada", role: "Planner", state: "working", label: "Plan" },
    })
    // The main agent is a member of "Docs", so the block has its copy too.
    expect(list.blocks[0]?.rows.map((r) => r.name)).toEqual(["Ada", "Bo"])
  })

  test('one block for each channel in the order of the page, and "No channel" is last', () => {
    const list = listOf({
      agents: [agent("a"), agent("b"), agent("c"), agent("z")],
      channels: [
        channel("zeta", ["a"]),
        channel("Alpha", ["b"], { createdAt: 5 }),
        channel("alpha", ["c"], { createdAt: 2 }),
      ],
    })
    // Without case, and the older channel first when the names are the same.
    expect(list.blocks.map((b) => [b.key, b.name, b.channelId])).toEqual([
      ["c:alpha", "alpha", "alpha"],
      ["c:Alpha", "Alpha", "Alpha"],
      ["c:zeta", "zeta", "zeta"],
      ["c:none", "", null],
    ])
    expect(list.blocks.at(-1)?.rows.map((r) => r.name)).toEqual(["z"])
  })

  test("a channel with no member that is not archived has no block", () => {
    const list = listOf({
      agents: [agent("a")],
      channels: [channel("Empty", ["gone"]), channel("Real", ["a"])],
    })
    expect(list.blocks.map((b) => b.name)).toEqual(["Real"])
  })

  test("the header gives the number of members and the counts in the order of the page", () => {
    const list = listOf({
      agents: [
        agent("a", { state: "offline" }),
        agent("b", { state: "idle" }),
        agent("c", { state: "working", task: { label: "x", state: "running" } }),
        agent("d", { state: "idle" }),
        agent("e", { state: "waiting", task: { label: "y", state: "waiting" } }),
      ],
      channels: [channel("Docs", ["a", "b", "c", "d", "e"])],
    })
    const docs = list.blocks[0]
    expect(docs?.memberCount).toBe(5)
    expect(docs?.counts).toEqual([
      { state: "working", count: 1 },
      { state: "waiting", count: 1 },
      { state: "idle", count: 2 },
      { state: "offline", count: 1 },
    ])
  })

  test("a state that no member has is not in the counts", () => {
    const list = listOf({
      agents: [agent("a"), agent("b")],
      channels: [channel("Docs", ["a", "b"])],
    })
    expect(list.blocks[0]?.counts).toEqual([{ state: "idle", count: 2 }])
  })

  test("the lead is first and has the mark; the others follow by name without case", () => {
    const list = listOf({
      agents: [agent("bo"), agent("Cy"), agent("Ada"), agent("Zed")],
      channels: [channel("Docs", ["bo", "Cy", "Ada", "Zed"], { leadId: "Zed" })],
    })
    const rows = list.blocks[0]?.rows ?? []
    expect(rows.map((r) => [r.name, r.isLead])).toEqual([
      ["Zed", true],
      ["Ada", false],
      ["bo", false],
      ["Cy", false],
    ])
  })

  test("a lead that is archived counts as no lead", () => {
    const list = listOf({
      agents: [agent("a"), agent("b")],
      channels: [channel("Docs", ["a", "b"], { leadId: "gone" })],
    })
    expect(list.blocks[0]?.rows.map((r) => r.isLead)).toEqual([false, false])
  })

  test("the label shows for an agent that works or waits, and for no other", () => {
    const list = listOf({
      agents: [
        agent("a", {
          state: "working",
          task: { label: "Draft the release notes", state: "running" },
        }),
        agent("b", {
          state: "waiting",
          task: { label: "Delete the old folder", state: "waiting" },
        }),
        agent("c", { state: "idle" }),
        agent("d", { state: "offline" }),
      ],
      channels: [channel("Docs", ["a", "b", "c", "d"])],
    })
    expect(list.blocks[0]?.rows.map((r) => [r.name, r.state, r.label])).toEqual([
      ["a", "working", "Draft the release notes"],
      ["b", "waiting", "Delete the old folder"],
      ["c", "idle", null],
      ["d", "offline", null],
    ])
  })

  test("a label of 100 characters shows 90 characters and the sign, and nothing more of the task", () => {
    const list = listOf({
      agents: [
        agent("a", { state: "working", task: { label: "x".repeat(100), state: "running" } }),
      ],
      channels: [channel("Docs", ["a"])],
    })
    const label = list.blocks[0]?.rows[0]?.label ?? ""
    expect([...label]).toHaveLength(90)
    expect(label.endsWith("…")).toBe(true)
  })

  test('a channel of 15 members has 12 rows and 3 behind "+3 more", in the order of the page', () => {
    const names = Array.from({ length: 15 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`)
    const list = listOf({
      agents: names.map((n) => agent(n)),
      // The lead is the last by name: it is still the first row.
      channels: [channel("Big", names, { leadId: "m15" })],
    })
    const big = list.blocks[0]
    expect(big?.memberCount).toBe(15)
    expect(big?.rows).toHaveLength(12)
    expect(big?.rows.map((r) => r.name)).toEqual(["m15", ...names.slice(0, 11)])
    expect(big?.more.map((m) => m.name)).toEqual(["m12", "m13", "m14"])
    // The counts cover every member, also those behind the row.
    expect(big?.counts).toEqual([{ state: "idle", count: 15 }])
  })

  test('12 members have no "+n more" row', () => {
    const names = Array.from({ length: 12 }, (_, i) => `m${i}`)
    const list = listOf({
      agents: names.map((n) => agent(n)),
      channels: [channel("Twelve", names)],
    })
    expect(list.blocks[0]?.rows).toHaveLength(12)
    expect(list.blocks[0]?.more).toEqual([])
  })

  test('a row behind "+n more" has a face, a name and a state', () => {
    const names = Array.from({ length: 13 }, (_, i) => `m${String(i).padStart(2, "0")}`)
    const list = listOf({
      agents: names.map((n, i) =>
        agent(n, { face: { shape: 2, hue: i }, state: n === "m12" ? "offline" : "idle" }),
      ),
      channels: [channel("Big", names)],
    })
    expect(list.blocks[0]?.more).toEqual([
      {
        key: "c:Big/more/m12",
        agentId: "m12",
        name: "m12",
        face: { shape: 2, hue: 12 },
        state: "offline",
      },
    ])
  })

  test("a server that sends a long node list gets the same cut of 12, with the lead first", () => {
    const base = buildChart(
      snapshot({
        agents: [agent("a"), agent("b")],
        channels: [channel("Docs", ["a", "b"], { leadId: "b" })],
      }),
    )
    const first = base.channels[0]
    if (!first) throw new Error("no channel")
    const node = (i: number, isLead = false) => ({
      ...(first.nodes[0] as NonNullable<(typeof first.nodes)[0]>),
      key: `c:Docs/n${i}`,
      agentId: `n${i}`,
      name: `n${i}`,
      isLead,
    })
    const nodes = Array.from({ length: 14 }, (_, i) => node(i, i === 13))
    const model: ChartModel = { ...base, channels: [{ ...first, nodes, more: [] }] }
    const list = buildOrgList(model)
    expect(list.blocks[0]?.rows).toHaveLength(12)
    expect(list.blocks[0]?.rows[0]?.name).toBe("n13")
    expect(list.blocks[0]?.more.map((m) => m.agentId)).toEqual(["n11", "n12"])
  })

  test("an agent in two channels has a row in each block, with its own key", () => {
    const list = listOf({
      agents: [
        agent("Ada", { state: "working", task: { label: "T", state: "running" } }),
        agent("Bo"),
      ],
      channels: [channel("Docs", ["Ada", "Bo"]), channel("Ops", ["Ada"])],
    })
    const copies = list.blocks.flatMap((b) => b.rows.filter((r) => r.agentId === "Ada"))
    expect(copies.map((r) => r.key)).toEqual(["c:Docs/Ada", "c:Ops/Ada"])
    // Both copies show the same state and task.
    expect(copies.map((r) => [r.state, r.label])).toEqual([
      ["working", "T"],
      ["working", "T"],
    ])
    expect(new Set(list.blocks.flatMap((b) => b.rows.map((r) => r.key))).size).toBe(3)
  })

  test("the role line comes with the row", () => {
    const list = listOf({
      agents: [agent("Ada", { role: "Writes the release notes and checks every link in them" })],
      channels: [channel("Docs", ["Ada"])],
    })
    expect(list.blocks[0]?.rows[0]?.role).toBe(
      "Writes the release notes and checks every link in them",
    )
  })

  test("hand-offs: one row for each line, the busiest first, a tie by the newest", () => {
    const list = listOf({
      agents: [agent("Ada"), agent("Bo"), agent("Cy")],
      channels: [channel("Docs", ["Ada", "Bo", "Cy"])],
      handoffs: [
        handoff("Ada", "Bo", 3, 10),
        handoff("Bo", "Ada", 1, 99),
        handoff("Cy", "Bo", 3, 20),
        handoff("Ada", "Cy", 7, 5),
      ],
    })
    expect(list.handoffs.map((h) => [h.from, h.to, h.count])).toEqual([
      ["Ada", "Cy", 7],
      ["Cy", "Bo", 3],
      ["Ada", "Bo", 3],
      ["Bo", "Ada", 1],
    ])
    expect(list.handoffsCapped).toBe(false)
  })

  test("both directions are two rows", () => {
    const list = listOf({
      agents: [agent("Ada"), agent("Bo")],
      channels: [channel("Docs", ["Ada", "Bo"])],
      handoffs: [handoff("Ada", "Bo", 2), handoff("Bo", "Ada", 4)],
    })
    expect(list.handoffs.map((h) => `${h.from}>${h.to}:${h.count}`)).toEqual([
      "Bo>Ada:4",
      "Ada>Bo:2",
    ])
  })

  test("no hand-off: no row and no cap line", () => {
    const list = listOf({ agents: [agent("a")], channels: [channel("Docs", ["a"])] })
    expect(list.handoffs).toEqual([])
    expect(list.handoffsCapped).toBe(false)
  })

  test("41 pairs: 40 rows, the busiest, and the cap line", () => {
    const agents = Array.from({ length: 82 }, (_, i) => agent(`a${String(i).padStart(2, "0")}`))
    const handoffs = Array.from({ length: 41 }, (_, i) =>
      handoff(
        `a${String(i * 2).padStart(2, "0")}`,
        `a${String(i * 2 + 1).padStart(2, "0")}`,
        i + 1,
      ),
    )
    // Many small channels, so that every agent has a node that is drawn.
    const channels = Array.from({ length: 41 }, (_, i) =>
      channel(`c${String(i).padStart(2, "0")}`, [
        `a${String(i * 2).padStart(2, "0")}`,
        `a${String(i * 2 + 1).padStart(2, "0")}`,
      ]),
    )
    const list = listOf({ agents, channels, handoffs })
    expect(list.handoffs).toHaveLength(40)
    expect(list.handoffs[0]?.count).toBe(41)
    // The pair with the number 1 is the one that is left out.
    expect(list.handoffs.at(-1)?.count).toBe(2)
    expect(list.handoffsCapped).toBe(true)
  })

  test("exactly 40 pairs: all 40 rows, and no cap line", () => {
    const agents = Array.from({ length: 80 }, (_, i) => agent(`a${String(i).padStart(2, "0")}`))
    const handoffs = Array.from({ length: 40 }, (_, i) =>
      handoff(
        `a${String(i * 2).padStart(2, "0")}`,
        `a${String(i * 2 + 1).padStart(2, "0")}`,
        i + 1,
      ),
    )
    const channels = Array.from({ length: 40 }, (_, i) =>
      channel(`c${String(i).padStart(2, "0")}`, [
        `a${String(i * 2).padStart(2, "0")}`,
        `a${String(i * 2 + 1).padStart(2, "0")}`,
      ]),
    )
    const list = listOf({ agents, channels, handoffs })
    expect(list.handoffs).toHaveLength(40)
    expect(list.handoffsCapped).toBe(false)
  })

  test("a hand-off of an agent that has no node on the chart is not in the list", () => {
    // Ada is the 13th member of a block, so her node is not drawn and she has no home node.
    const names = Array.from({ length: 12 }, (_, i) => `a${String(i).padStart(2, "0")}`)
    const list = listOf({
      agents: [...names, "zz-last"].map((n) => agent(n)),
      channels: [channel("Big", [...names, "zz-last"])],
      handoffs: [handoff("a00", "zz-last", 5), handoff("a00", "a01", 2)],
    })
    expect(list.handoffs.map((h) => [h.from, h.to])).toEqual([["a00", "a01"]])
  })

  test("a server that sends more than 40 hand-off lines is cut at 40 here too, and the line shows", () => {
    const base = buildChart(
      snapshot({
        agents: [agent("a"), agent("b")],
        channels: [channel("Docs", ["a", "b"])],
        handoffs: [handoff("a", "b", 1)],
      }),
    )
    const line = base.lines.find((l) => l.kind === "handoff")
    if (!line) throw new Error("no hand-off line")
    const lines = Array.from({ length: 45 }, (_, i) => ({
      ...line,
      id: `h:${i}`,
      count: i === 44 ? 100 : 1,
      fromName: `f${i}`,
      toName: `t${i}`,
    }))
    const list = buildOrgList({ ...base, lines, handoffsCapped: false })
    expect(list.handoffs).toHaveLength(40)
    // The busiest line was last in the model, and it is first here.
    expect(list.handoffs[0]).toEqual({ key: "h:44", from: "f44", to: "t44", count: 100 })
    expect(list.handoffsCapped).toBe(true)
  })

  test("lines of the chart that are not hand-offs are not rows", () => {
    const parts = {
      agents: [agent("a"), agent("b")],
      channels: [channel("Docs", ["a", "b"], { leadId: "a" })],
    }
    // The model has structure lines and a lead line. None of them is a row.
    expect(buildChart(snapshot(parts)).lines.length).toBeGreaterThan(0)
    expect(listOf(parts).handoffs).toEqual([])
  })
})
