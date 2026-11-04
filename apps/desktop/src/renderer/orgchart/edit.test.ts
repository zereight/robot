import { describe, expect, test } from "bun:test"
import {
  agentsFor,
  channelsFor,
  dropEdit,
  type EditChannel,
  leavingOf,
  planEdit,
  undoSteps,
} from "./edit.ts"

// Spec 029, "Edit on the chart": the lists of the menus, where a drop is allowed, the patches of
// each change, and Undo.

const docs: EditChannel = { id: "docs", name: "Docs", leadId: "a", memberIds: ["a", "b", "c"] }
const ops: EditChannel = { id: "ops", name: "ops", leadId: null, memberIds: ["d"] }
const art: EditChannel = { id: "art", name: "Art", leadId: null, memberIds: [] }
const all = [docs, ops, art]

/** The channels after the steps, as the server would store them. */
const after = (
  channels: readonly EditChannel[],
  steps: readonly {
    channelId: string
    patch: { memberIds?: readonly string[]; leadId?: string | null }
  }[],
) =>
  channels.map((c) => {
    let now: EditChannel = c
    for (const s of steps) {
      if (s.channelId !== c.id) continue
      now = {
        ...now,
        memberIds: s.patch.memberIds ?? now.memberIds,
        leadId: s.patch.leadId !== undefined ? s.patch.leadId : now.leadId,
      }
    }
    return now
  })

describe("the lists of the menus", () => {
  test("Add to channel and Move to channel list the channels where the agent is no member, by name", () => {
    expect(channelsFor("b", all).map((c) => c.id)).toEqual(["art", "ops"])
    expect(channelsFor("x", all).map((c) => c.name)).toEqual(["Art", "Docs", "ops"])
  })

  test("Add member lists the agents that are not members, by name", () => {
    const agents = [
      { id: "d", name: "dee" },
      { id: "a", name: "Ada" },
      { id: "e", name: "Eve" },
      { id: "b", name: "Bo" },
    ]
    expect(agentsFor(docs, agents).map((a) => a.name)).toEqual(["dee", "Eve"])
  })
})

describe("a drop", () => {
  test("on another channel node moves the agent; with Option it adds the agent", () => {
    expect(dropEdit({ agentId: "b", from: "docs", to: "ops", add: false }, all)).toEqual({
      kind: "move",
      agentId: "b",
      from: "docs",
      to: "ops",
    })
    expect(dropEdit({ agentId: "b", from: "docs", to: "ops", add: true }, all)).toEqual({
      kind: "add",
      agentId: "b",
      to: "ops",
    })
  })

  test("from No channel onto a channel node adds the agent", () => {
    expect(dropEdit({ agentId: "x", from: null, to: "art", add: false }, all)).toEqual({
      kind: "add",
      agentId: "x",
      to: "art",
    })
  })

  test("on No channel removes the agent from the channel it came from", () => {
    expect(dropEdit({ agentId: "b", from: "docs", to: null, add: false }, all)).toEqual({
      kind: "remove",
      agentId: "b",
      from: "docs",
    })
  })

  test("is not allowed on its own channel, on a channel where it is a member, or from No channel to No channel", () => {
    expect(dropEdit({ agentId: "b", from: "docs", to: "docs", add: false }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "d", from: "docs", to: "ops", add: true }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "x", from: null, to: null, add: false }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "b", from: "docs", to: null, add: true }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "b", from: "docs", to: "gone", add: false }, all)).toBeUndefined()
  })
})

describe("the patches of a change", () => {
  test("a move takes the agent out first, then adds it", () => {
    const plan = planEdit({ kind: "move", agentId: "b", from: "docs", to: "ops" }, all)
    expect(plan?.steps).toEqual([
      { channelId: "docs", patch: { memberIds: ["a", "c"] } },
      { channelId: "ops", patch: { memberIds: ["d", "b"] } },
    ])
  })

  test("a move of the lead leaves its channel with no lead", () => {
    const plan = planEdit({ kind: "move", agentId: "a", from: "docs", to: "ops" }, all)
    expect(plan?.steps[0]).toEqual({
      channelId: "docs",
      patch: { memberIds: ["b", "c"], leadId: null },
    })
  })

  test("make lead and remove as lead change the lead only", () => {
    expect(planEdit({ kind: "lead", agentId: "b", channelId: "docs" }, all)?.steps).toEqual([
      { channelId: "docs", patch: { leadId: "b" } },
    ])
    expect(planEdit({ kind: "unlead", agentId: "a", channelId: "docs" }, all)?.steps).toEqual([
      { channelId: "docs", patch: { leadId: null } },
    ])
  })

  test("a change that names a channel that is gone makes no patch", () => {
    expect(planEdit({ kind: "add", agentId: "b", to: "gone" }, all)).toBeUndefined()
  })
})

describe("undo", () => {
  test("puts back the members and the lead; the channel that loses a member goes first", () => {
    const plan = planEdit({ kind: "move", agentId: "a", from: "docs", to: "ops" }, all)
    if (!plan) throw new Error("no plan")
    const now = after(all, plan.steps)
    const steps = undoSteps(plan.before, now)
    expect(steps.map((s) => s.channelId)).toEqual(["ops", "docs"])
    const back = after(now, steps)
    expect(back.find((c) => c.id === "docs")).toEqual(docs)
    expect(back.find((c) => c.id === "ops")).toEqual(ops)
  })

  test("leaves out a channel that is gone", () => {
    const plan = planEdit({ kind: "add", agentId: "b", to: "ops" }, all)
    if (!plan) throw new Error("no plan")
    expect(undoSteps(plan.before, [docs])).toEqual([])
  })

  test("a refusal names the member that leaves its channel", () => {
    expect(leavingOf({ channelId: "docs", patch: { memberIds: ["a", "c"] } }, all)).toEqual({
      channelId: "docs",
      agentIds: ["b"],
    })
    expect(leavingOf({ channelId: "docs", patch: { leadId: null } }, all)).toBeUndefined()
  })
})
