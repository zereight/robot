import { describe, expect, test } from "bun:test"
import {
  ALL_AGENTS,
  channelsThatGive,
  DAILY_LIMIT_MAX,
  DAILY_LIMIT_MIN,
  emptyAudience,
  givingChannels,
  type LimitChannel,
  limitViewOf,
  mayUseTool,
  stoppingChannel,
  usedWithLower,
  validDailyLimit,
  withChannelSwitch,
} from "./channelTools.ts"
import type { TreeChannel } from "./channelTree.ts"

// Spec 030, "Channel tools" and "Daily token limit".

const ch = (id: string, parentId: string | null = null, archived = false): TreeChannel => ({
  id,
  parentId,
  archived,
})

// Product > Docs > Site, and Ops alone.
const tree = [ch("product"), ch("docs", "product"), ch("site", "docs"), ch("ops")]

describe("who may use a skill or a connection", () => {
  test("a member of a lower channel gets what a higher channel gives", () => {
    expect(givingChannels(tree, ["site"])).toEqual(["site", "docs", "product"])
    expect(givingChannels(tree, ["docs"])).toEqual(["docs", "product"])
    expect(givingChannels(tree, ["product"])).toEqual(["product"])
  })

  test("a member of a higher channel gets nothing from a lower channel", () => {
    const giving = givingChannels(tree, ["product"])
    expect(mayUseTool({ agentIds: [], channelIds: ["site"] }, "a", giving)).toBe(false)
    expect(mayUseTool({ agentIds: [], channelIds: ["docs"] }, "a", giving)).toBe(false)
  })

  test("the nearest channel comes first, and a channel is listed once", () => {
    expect(givingChannels(tree, ["site", "docs"])).toEqual(["site", "docs", "product"])
    expect(givingChannels(tree, ["ops", "site"])).toEqual(["ops", "site", "docs", "product"])
  })

  test("an agent in no channel gets nothing from a channel", () => {
    expect(givingChannels(tree, [])).toEqual([])
    expect(mayUseTool({ agentIds: [], channelIds: ["product"] }, "a", [])).toBe(false)
  })

  test("an archived channel gives nothing: as a member channel, and as a higher channel", () => {
    const archivedMember = [ch("product"), ch("docs", "product", true)]
    expect(givingChannels(archivedMember, ["docs"])).toEqual([])
    // The parent is archived: the sub-channel is a top channel, so it gets nothing from the parent.
    const archivedParent = [ch("product", null, true), ch("docs", "product")]
    expect(givingChannels(archivedParent, ["docs"])).toEqual(["docs"])
    expect(mayUseTool({ agentIds: [], channelIds: ["product"] }, "a", ["docs"])).toBe(false)
    // A restore brings the right back.
    const restored = [ch("product"), ch("docs", "product")]
    expect(givingChannels(restored, ["docs"])).toEqual(["docs", "product"])
  })

  test("a channel in the list, the agent itself, or All agents", () => {
    const giving = givingChannels(tree, ["site"])
    expect(mayUseTool(ALL_AGENTS, "x", [])).toBe(true)
    expect(mayUseTool({ agentIds: ["x"], channelIds: [] }, "x", [])).toBe(true)
    expect(mayUseTool({ agentIds: ["y"], channelIds: [] }, "x", [])).toBe(false)
    expect(mayUseTool({ agentIds: [], channelIds: ["product"] }, "x", giving)).toBe(true)
    expect(mayUseTool({ agentIds: ["y"], channelIds: ["ops"] }, "x", giving)).toBe(false)
  })

  test("the channels that give a tool are named nearest first, for the line 'From <channel>'", () => {
    const giving = givingChannels(tree, ["site"])
    expect(
      channelsThatGive({ agentIds: [], channelIds: ["product", "docs", "ops"] }, giving),
    ).toEqual(["docs", "product"])
    expect(channelsThatGive(ALL_AGENTS, giving)).toEqual([])
  })

  test("the switch of a channel adds or removes the channel and keeps the agents", () => {
    const list = { agentIds: ["a"], channelIds: ["ops"] }
    expect(withChannelSwitch(list, "product", true)).toEqual({
      agentIds: ["a"],
      channelIds: ["ops", "product"],
    })
    expect(
      withChannelSwitch({ agentIds: ["a"], channelIds: ["product"] }, "product", false),
    ).toEqual({ agentIds: ["a"], channelIds: [] })
    // Turning on twice adds the channel once.
    expect(withChannelSwitch(withChannelSwitch(list, "product", true), "product", true)).toEqual({
      agentIds: ["a"],
      channelIds: ["ops", "product"],
    })
    // A skill for all agents is not a list.
    expect(withChannelSwitch(ALL_AGENTS, "product", false)).toEqual(ALL_AGENTS)
    expect(emptyAudience({ agentIds: [], channelIds: [] })).toBe(true)
    expect(emptyAudience({ agentIds: [], channelIds: ["product"] })).toBe(false)
    expect(emptyAudience(ALL_AGENTS)).toBe(false)
  })
})

describe("the daily token limit", () => {
  test("it takes a whole number from 10,000 to 100,000,000", () => {
    expect(DAILY_LIMIT_MIN).toBe(10_000)
    expect(DAILY_LIMIT_MAX).toBe(100_000_000)
    expect(validDailyLimit(9_999)).toBe(false)
    expect(validDailyLimit(10_000)).toBe(true)
    expect(validDailyLimit(50_000)).toBe(true)
    expect(validDailyLimit(100_000_000)).toBe(true)
    expect(validDailyLimit(100_000_001)).toBe(false)
    expect(validDailyLimit(12_345.5)).toBe(false)
    expect(validDailyLimit("50000")).toBe(false)
    expect(validDailyLimit(null)).toBe(false)
  })

  test("a channel counts the tokens of its lower channels too", () => {
    const own = new Map([
      ["product", 1_000],
      ["docs", 20_000],
      ["site", 300],
      ["ops", 7],
    ])
    const used = usedWithLower(tree, own)
    expect(used.get("site")).toBe(300)
    expect(used.get("docs")).toBe(20_300)
    expect(used.get("product")).toBe(21_300)
    expect(used.get("ops")).toBe(7)
  })

  test("a channel with no task used nothing", () => {
    expect(usedWithLower(tree, new Map()).get("product")).toBe(0)
  })

  const limits = (docs: number | null, product: number | null): LimitChannel[] => [
    { ...ch("product"), dailyLimit: product },
    { ...ch("docs", "product"), dailyLimit: docs },
    { ...ch("site", "docs"), dailyLimit: null },
  ]

  test("a limit that is used stops the channel; below it nothing stops", () => {
    const channels = limits(50_000, null)
    expect(stoppingChannel(channels, new Map([["docs", 49_999]]), "docs")).toBeNull()
    expect(stoppingChannel(channels, new Map([["docs", 50_000]]), "docs")).toBe("docs")
    expect(stoppingChannel(channels, new Map([["docs", 51_000]]), "docs")).toBe("docs")
  })

  test("a limit of a parent channel stops its lower channels, and names the parent", () => {
    const channels = limits(null, 50_000)
    const used = new Map([["product", 60_000]])
    expect(stoppingChannel(channels, used, "site")).toBe("product")
    expect(stoppingChannel(channels, used, "docs")).toBe("product")
    expect(stoppingChannel(channels, used, "product")).toBe("product")
  })

  test("a lower limit does not stop a higher channel", () => {
    const channels = limits(50_000, null)
    expect(stoppingChannel(channels, new Map([["docs", 60_000]]), "product")).toBeNull()
  })

  test("when the channel and its parent are both used, the nearest is named", () => {
    const channels = limits(50_000, 50_000)
    const used = new Map([
      ["docs", 60_000],
      ["product", 70_000],
    ])
    expect(stoppingChannel(channels, used, "site")).toBe("docs")
  })

  test("a channel with the limit off is never stopped by itself", () => {
    expect(stoppingChannel(limits(null, null), new Map([["docs", 1e9]]), "docs")).toBeNull()
  })

  test("the view: 80 percent is near, the limit is over, no limit is ok", () => {
    expect(limitViewOf(null, 99_999)).toEqual({ limit: null, used: 99_999, state: "ok" })
    expect(limitViewOf(50_000, 39_999).state).toBe("ok")
    expect(limitViewOf(50_000, 40_000).state).toBe("near")
    expect(limitViewOf(50_000, 41_000).state).toBe("near")
    expect(limitViewOf(50_000, 49_999).state).toBe("near")
    expect(limitViewOf(50_000, 50_000).state).toBe("over")
    expect(limitViewOf(50_000, 51_000).state).toBe("over")
  })
})
