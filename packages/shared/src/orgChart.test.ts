import { describe, expect, test } from "bun:test"
import {
  buildChart,
  chartOrder,
  copyKey,
  countList,
  cutLabel,
  EMPTY_ORG_SNAPSHOT,
  findAgent,
  litBy,
  NO_CHANNEL_KEY,
  ORG_CHANNEL_NODES_MAX,
  ORG_HANDOFF_LINES_MAX,
  ORG_LABEL_MAX,
  type OrgAgent,
  type OrgChannel,
  type OrgHandoff,
  type OrgSnapshot,
  ROOT_KEY,
} from "./orgChart.ts"

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
const handoff = (from: string, to: string, count = 1, newest = 1): OrgHandoff => ({
  from,
  to,
  count,
  newest,
})
const snap = (parts: Partial<OrgSnapshot>): OrgSnapshot => ({ ...EMPTY_ORG_SNAPSHOT, ...parts })
const keys = (list: readonly { key: string }[]) => list.map((n) => n.key)
const ZERO = { working: 0, waiting: 0, idle: 0, offline: 0 }

describe("the empty chart", () => {
  test("a profile with no agent has no canvas", () => {
    const model = buildChart(EMPTY_ORG_SNAPSHOT)
    expect(model.empty).toBe(true)
    expect(model.channels).toEqual([])
    expect(model.lines).toEqual([])
  })
})

describe("the root and the node 'No channel'", () => {
  test("three agents in no channel: the root is You and 'No channel' holds them by name", () => {
    const model = buildChart(snap({ agents: [agent("cy"), agent("Ann"), agent("bo")] }))
    expect(model.empty).toBe(false)
    expect(model.root).toBeNull()
    expect(model.channels).toHaveLength(1)
    const none = model.channels[0]
    expect(none?.key).toBe(NO_CHANNEL_KEY)
    expect(none?.channelId).toBeNull()
    expect(none?.nodes.map((n) => n.name)).toEqual(["Ann", "bo", "cy"])
    expect(none?.memberCount).toBe(3)
  })

  test("with a main agent the root is that agent and its copy shows in 'No channel'", () => {
    const model = buildChart(
      snap({ mainAgentId: "bo", agents: [agent("ann"), agent("bo"), agent("cy")] }),
    )
    expect(model.root?.agentId).toBe("bo")
    expect(model.root?.key).toBe(ROOT_KEY)
    expect(model.channels[0]?.nodes.map((n) => n.agentId)).toEqual(["ann", "bo", "cy"])
  })

  test("an archived main agent (not in the snapshot) leaves the root as You", () => {
    const model = buildChart(snap({ mainAgentId: "gone", agents: [agent("ann")] }))
    expect(model.root).toBeNull()
  })

  test("with every agent in a channel, there is no node 'No channel'", () => {
    const model = buildChart(
      snap({ agents: [agent("a"), agent("b")], channels: [channel("Docs", ["a", "b"])] }),
    )
    expect(keys(model.channels)).toEqual(["c:Docs"])
  })

  test("an agent that is in no channel goes to 'No channel', last", () => {
    const model = buildChart(
      snap({ agents: [agent("a"), agent("b")], channels: [channel("Zed", ["a"])] }),
    )
    expect(keys(model.channels)).toEqual(["c:Zed", NO_CHANNEL_KEY])
    expect(model.channels[1]?.nodes.map((n) => n.agentId)).toEqual(["b"])
  })
})

describe("channel nodes", () => {
  test("the order is by name without case, the older first on a tie, 'No channel' last", () => {
    const model = buildChart(
      snap({
        agents: [agent("a"), agent("b"), agent("c"), agent("d"), agent("e")],
        channels: [
          channel("zeta", ["a"]),
          channel("Alpha", ["b"], { createdAt: 5 }),
          channel("alpha", ["c"], { createdAt: 2 }),
          channel("Beta", ["d"]),
        ],
      }),
    )
    // "alpha" and "Alpha" tie by name: the one made at 2 comes first.
    expect(model.channels.map((c) => c.channelId)).toEqual(["alpha", "Alpha", "Beta", "zeta", null])
  })

  test("a channel without a member that is not archived has no node", () => {
    const model = buildChart(
      snap({ agents: [agent("a")], channels: [channel("Ghosts", ["x", "y"])] }),
    )
    expect(model.channels.map((c) => c.channelId)).toEqual([null])
  })

  test("a channel shows the number of members and the counts by state, in the set order", () => {
    const model = buildChart(
      snap({
        agents: [
          agent("a", { state: "idle" }),
          agent("b", { state: "working" }),
          agent("c", { state: "waiting" }),
          agent("d", { state: "working" }),
          agent("e", { state: "offline" }),
          agent("f", { state: "idle" }),
        ],
        channels: [channel("Docs", ["a", "b", "c", "d", "e", "f"])],
      }),
    )
    const docs = model.channels[0]
    expect(docs?.memberCount).toBe(6)
    expect(countList(docs?.counts ?? ZERO)).toEqual([
      { state: "working", count: 2 },
      { state: "waiting", count: 1 },
      { state: "idle", count: 2 },
      { state: "offline", count: 1 },
    ])
  })

  test("a state that no member has is left out of the counts", () => {
    const model = buildChart(snap({ agents: [agent("a", { state: "idle" })] }))
    expect(countList(model.channels[0]?.counts ?? ZERO)).toEqual([{ state: "idle", count: 1 }])
  })
})

describe("the lead", () => {
  const docs = snap({
    agents: [agent("A"), agent("B"), agent("C")],
    channels: [channel("Docs", ["C", "B", "A"], { leadId: "A" })],
  })

  test("the lead is first, with the mark; the others follow by name", () => {
    const [docsNode] = buildChart(docs).channels
    expect(docsNode?.nodes.map((n) => [n.agentId, n.isLead])).toEqual([
      ["A", true],
      ["B", false],
      ["C", false],
    ])
    expect(docsNode?.leadKey).toBe(copyKey("c:Docs", "A"))
    expect(docsNode?.memberCount).toBe(3)
  })

  test("a lead that is not the first by name still comes first", () => {
    const model = buildChart(
      snap({
        agents: [agent("A"), agent("B"), agent("C")],
        channels: [channel("Docs", ["A", "B", "C"], { leadId: "C" })],
      }),
    )
    expect(model.channels[0]?.nodes.map((n) => n.agentId)).toEqual(["C", "A", "B"])
  })

  test("a lead line goes from the lead to each other member; the channel hangs from the lead", () => {
    const model = buildChart(docs)
    const a = copyKey("c:Docs", "A")
    expect(model.lines.filter((l) => l.kind === "lead").map((l) => [l.from, l.to])).toEqual([
      [a, copyKey("c:Docs", "B")],
      [a, copyKey("c:Docs", "C")],
    ])
    expect(model.lines.filter((l) => l.kind === "structure").map((l) => [l.from, l.to])).toEqual([
      [ROOT_KEY, "c:Docs"],
      ["c:Docs", a],
    ])
  })

  test("with no lead there is no mark and no lead line; the channel hangs from its members", () => {
    const model = buildChart(
      snap({ ...docs, channels: [channel("Docs", ["A", "B", "C"], { leadId: null })] }),
    )
    expect(model.lines.filter((l) => l.kind === "lead")).toEqual([])
    expect(model.channels[0]?.nodes.some((n) => n.isLead)).toBe(false)
    expect(model.lines.filter((l) => l.kind === "structure").map((l) => l.to)).toEqual([
      "c:Docs",
      copyKey("c:Docs", "A"),
      copyKey("c:Docs", "B"),
      copyKey("c:Docs", "C"),
    ])
  })

  test("a lead that is archived counts as no lead", () => {
    // The archived lead is not in the agent list, so it is not a member that counts.
    const model = buildChart(
      snap({
        agents: [agent("B"), agent("C")],
        channels: [channel("Docs", ["A", "B", "C"], { leadId: "A" })],
      }),
    )
    expect(model.channels[0]?.leadKey).toBeNull()
    expect(model.channels[0]?.memberCount).toBe(2)
    expect(model.lines.filter((l) => l.kind === "lead")).toEqual([])
  })
})

describe("copies", () => {
  const two = snap({
    agents: [agent("A"), agent("B"), agent("C")],
    channels: [channel("Docs", ["A", "B"]), channel("Ops", ["B", "C"])],
  })

  test("an agent in two channels has a node in each, and each names the other", () => {
    const model = buildChart(two)
    const copies = model.channels.flatMap((c) => c.nodes).filter((n) => n.agentId === "B")
    expect(copies.map((n) => n.key)).toEqual([copyKey("c:Docs", "B"), copyKey("c:Ops", "B")])
    expect(copies.map((n) => n.alsoIn)).toEqual([["Ops"], ["Docs"]])
  })

  test("pointing at a copy lights both copies and its lines, and dims the rest", () => {
    const model = buildChart(two)
    const { nodes } = litBy(model, copyKey("c:Docs", "B"))
    expect(nodes.has(copyKey("c:Docs", "B"))).toBe(true)
    expect(nodes.has(copyKey("c:Ops", "B"))).toBe(true)
    // The channel node of the copy is at the end of its structure line.
    expect(nodes.has("c:Docs")).toBe(true)
    expect(nodes.has(copyKey("c:Ops", "C"))).toBe(false)
    expect(nodes.has(copyKey("c:Docs", "A"))).toBe(false)
  })

  test("the main agent has its copy in the channel nodes where it is a member", () => {
    const model = buildChart({ ...two, mainAgentId: "B" })
    expect(model.root?.agentId).toBe("B")
    expect(model.root?.alsoIn).toEqual(["Docs", "Ops"])
    expect(litBy(model, ROOT_KEY).nodes.has(copyKey("c:Ops", "B"))).toBe(true)
  })
})

describe("the cap of 12 nodes", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, "0")}`)

  test("a channel node of 15 members draws 12 and lists 3 behind the tile", () => {
    const ids = many(15)
    const model = buildChart(
      snap({ agents: ids.map((id) => agent(id)), channels: [channel("Big", ids)] }),
    )
    const big = model.channels[0]
    expect(big?.nodes).toHaveLength(ORG_CHANNEL_NODES_MAX)
    expect(big?.more.map((m) => m.agentId)).toEqual(["m12", "m13", "m14"])
    expect(big?.memberCount).toBe(15)
  })

  test("the lead is among the 12 even when it comes last by name", () => {
    const ids = many(15)
    const model = buildChart(
      snap({
        agents: ids.map((id) => agent(id)),
        channels: [channel("Big", ids, { leadId: "m14" })],
      }),
    )
    const big = model.channels[0]
    expect(big?.nodes[0]?.agentId).toBe("m14")
    expect(big?.more).toHaveLength(3)
    expect(big?.nodes.some((n) => n.agentId === "m14")).toBe(true)
  })

  test("a member that is not drawn has no line", () => {
    const ids = many(14)
    const model = buildChart(
      snap({
        agents: ids.map((id) => agent(id)),
        channels: [channel("Big", ids, { leadId: "m00" })],
      }),
    )
    const ends = new Set(model.lines.flatMap((l) => [l.from, l.to]))
    expect(ends.has(copyKey("c:Big", "m12"))).toBe(false)
    expect(ends.has(copyKey("c:Big", "m13"))).toBe(false)
    expect(model.lines.filter((l) => l.kind === "lead")).toHaveLength(ORG_CHANNEL_NODES_MAX - 1)
  })

  test("12 members draw no tile", () => {
    const ids = many(12)
    const model = buildChart(
      snap({ agents: ids.map((id) => agent(id)), channels: [channel("Ok", ids)] }),
    )
    expect(model.channels[0]?.more).toEqual([])
  })
})

describe("live state", () => {
  test("a working agent shows the label of its task, cut at 90 characters", () => {
    const long = "x".repeat(100)
    const model = buildChart(
      snap({
        agents: [
          agent("a", {
            state: "working",
            task: { label: "Draft the release notes", state: "running" },
          }),
          agent("b", { state: "working", task: { label: long, state: "running" } }),
          agent("c", { state: "waiting", task: { label: "Approve", state: "waiting" } }),
          agent("d"),
        ],
      }),
    )
    const nodes = model.channels[0]?.nodes ?? []
    expect(nodes[0]?.label).toBe("Draft the release notes")
    expect(nodes[1]?.label).toHaveLength(ORG_LABEL_MAX)
    expect(nodes[1]?.label?.endsWith("…")).toBe(true)
    expect(nodes[2]).toMatchObject({ state: "waiting", label: "Approve" })
    expect(nodes[3]?.label).toBeNull()
  })

  test("cutLabel keeps a short label, joins white space and counts the sign for a cut", () => {
    expect(cutLabel("Fix  the\nbug")).toBe("Fix the bug")
    expect(cutLabel("a".repeat(90))).toBe("a".repeat(90))
    expect(cutLabel("a".repeat(91))).toBe(`${"a".repeat(89)}…`)
    // A character outside the base plane is one character, not two.
    expect([...cutLabel("😀".repeat(95))]).toHaveLength(90)
  })
})

describe("hand-off lines", () => {
  const trio = snap({
    agents: [agent("A"), agent("B"), agent("C")],
    channels: [channel("Docs", ["A", "B"]), channel("Ops", ["B", "C"])],
  })
  const lines = (s: OrgSnapshot) => buildChart(s).lines.filter((l) => l.kind === "handoff")

  test("a line goes from the home node of the sender to the home node of the receiver", () => {
    const found = lines({ ...trio, handoffs: [handoff("A", "B", 3)] })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      from: copyKey("c:Docs", "A"),
      // B is in Docs and Ops. Its home node is the copy in the first channel node.
      to: copyKey("c:Docs", "B"),
      count: 3,
      fromName: "A",
      toName: "B",
    })
  })

  test("for the main agent the home node is the root", () => {
    const found = lines({ ...trio, mainAgentId: "A", handoffs: [handoff("A", "C", 2)] })
    expect(found[0]?.from).toBe(ROOT_KEY)
    expect(found[0]?.to).toBe(copyKey("c:Ops", "C"))
  })

  test("two agents that handed work to each other make two lines, one for each way", () => {
    const found = lines({ ...trio, handoffs: [handoff("A", "C", 3), handoff("C", "A", 1)] })
    expect(found.map((l) => [l.fromName, l.toName, l.count])).toEqual([
      ["A", "C", 3],
      ["C", "A", 1],
    ])
  })

  test("a hand-off to an agent that is archived (not in the snapshot) makes no line", () => {
    expect(lines({ ...trio, handoffs: [handoff("A", "gone")] })).toEqual([])
    expect(lines({ ...trio, handoffs: [handoff("gone", "A")] })).toEqual([])
  })

  test("a hand-off from an agent to itself, and a count of 0, make no line", () => {
    expect(lines({ ...trio, handoffs: [handoff("A", "A", 2), handoff("A", "B", 0)] })).toEqual([])
  })

  test("a hand-off from or to an agent whose home node is not drawn is not drawn", () => {
    const ids = Array.from({ length: 14 }, (_, i) => `m${String(i).padStart(2, "0")}`)
    const s = snap({
      agents: ids.map((id) => agent(id)),
      channels: [channel("Big", ids)],
      handoffs: [handoff("m00", "m13", 2), handoff("m12", "m01", 2), handoff("m00", "m01", 2)],
    })
    const found = lines(s)
    expect(found.map((l) => `${l.fromName}>${l.toName}`)).toEqual(["m00>m01"])
  })

  test("the node counts the agents on each side of its hand-offs", () => {
    const s = {
      ...trio,
      handoffs: [handoff("A", "B"), handoff("A", "C"), handoff("C", "A"), handoff("B", "A")],
    }
    const model = buildChart(s)
    const a = model.channels[0]?.nodes.find((n) => n.agentId === "A")
    expect(a?.handedTo).toBe(2)
    expect(a?.gotFrom).toBe(2)
    const c = model.channels[1]?.nodes.find((n) => n.agentId === "C")
    expect(c?.handedTo).toBe(1)
    expect(c?.gotFrom).toBe(1)
  })

  test("more than 40 lines: the 40 busiest are drawn, the newest first on a tie, and the chart says so", () => {
    // 41 pairs. Pair i hands i + 1 tasks, except pair 1, which ties with pair 0 on one task.
    const ids = Array.from({ length: 82 }, (_, i) => `a${String(i).padStart(2, "0")}`)
    const handoffs: OrgHandoff[] = Array.from({ length: 41 }, (_, i) =>
      handoff(ids[2 * i] as string, ids[2 * i + 1] as string, i === 1 ? 1 : i + 1, 100 + i),
    )
    // Pair 0 has count 1 and newest 100; pair 1 has count 1 and newest 101. Pair 0 goes.
    const chans = Array.from({ length: 82 }, (_, i) => channel(`c${i}`, [ids[i] as string]))
    const model = buildChart(
      snap({ agents: ids.map((id) => agent(id)), channels: chans, handoffs }),
    )
    const drawn = model.lines.filter((l) => l.kind === "handoff")
    expect(drawn).toHaveLength(ORG_HANDOFF_LINES_MAX)
    expect(model.handoffsCapped).toBe(true)
    const names = drawn.map((l) => l.fromName)
    expect(names).not.toContain("a00")
    expect(names).toContain("a02")
    // The busiest line is first.
    expect(drawn[0]?.count).toBe(41)
  })

  test("exactly 40 lines are not marked as cut", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `a${String(i).padStart(2, "0")}`)
    const handoffs = Array.from({ length: 40 }, (_, i) =>
      handoff(ids[2 * i] as string, ids[2 * i + 1] as string),
    )
    const chans = Array.from({ length: 80 }, (_, i) => channel(`c${i}`, [ids[i] as string]))
    const model = buildChart(
      snap({ agents: ids.map((id) => agent(id)), channels: chans, handoffs }),
    )
    expect(model.lines.filter((l) => l.kind === "handoff")).toHaveLength(40)
    expect(model.handoffsCapped).toBe(false)
  })
})

describe("reading the chart", () => {
  const model = buildChart(
    snap({
      agents: [agent("A"), agent("B")],
      channels: [channel("Docs", ["A", "B"], { leadId: "A" })],
      handoffs: [handoff("A", "B", 2)],
    }),
  )

  test("the page order is the root, then each channel node followed by its agents", () => {
    expect(chartOrder(model)).toEqual([
      ROOT_KEY,
      "c:Docs",
      copyKey("c:Docs", "A"),
      copyKey("c:Docs", "B"),
    ])
  })

  test("pointing at a node lights its lines and the nodes at their other ends", () => {
    const lit = litBy(model, copyKey("c:Docs", "B"))
    expect([...lit.nodes].sort()).toEqual([copyKey("c:Docs", "A"), copyKey("c:Docs", "B")].sort())
    // The lead line and the hand-off line end at B.
    expect(lit.lines.size).toBe(2)
    const root = litBy(model, ROOT_KEY)
    expect([...root.nodes].sort()).toEqual(["c:Docs", ROOT_KEY])
  })

  test("findAgent finds a copy, and the root only when the main agent is set", () => {
    expect(findAgent(model, copyKey("c:Docs", "A"))?.isLead).toBe(true)
    expect(findAgent(model, ROOT_KEY)).toBeUndefined()
  })

  test("the same data gives the same model", () => {
    const again = buildChart(
      snap({
        agents: [agent("B"), agent("A")],
        channels: [channel("Docs", ["B", "A"], { leadId: "A" })],
        handoffs: [handoff("A", "B", 2)],
      }),
    )
    expect(again).toEqual(model)
  })
})
