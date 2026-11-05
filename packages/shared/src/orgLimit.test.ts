import { describe, expect, test } from "bun:test"
import {
  DAILY_LIMIT_MAX,
  DAILY_LIMIT_MIN,
  type LimitOrg,
  limitStopsSource,
  orgLimitView,
  orgUsageRows,
  orgUsedToday,
  stoppingOrg,
  validDailyLimit,
} from "./orgLimit.ts"

// Spec 030, "Daily token limit": the limit of an organization counts the tokens of the tasks of its
// members and of the members of its lower organizations. Every limit of the organization and of its
// higher organizations holds. When more than one limit is used, the organization that comes first in
// the order of names (ignoring case) is named.

const org = (
  id: string,
  name: string,
  parentId: string | null,
  memberIds: string[],
  dailyLimit: number | null = null,
): LimitOrg => ({ id, name, parentId, memberIds, dailyLimit })

// Product > Docs > Site, and Ops alone.
const tree = [
  org("product", "Product", null, ["p"], 200_000),
  org("docs", "Docs", "product", ["d", "both"], 50_000),
  org("site", "Site", "docs", ["s1", "s2"]),
  org("ops", "Ops", null, ["both", "o"], 10_000),
]

describe("the range of the limit", () => {
  test("10,000 to 100,000,000 whole tokens", () => {
    expect(DAILY_LIMIT_MIN).toBe(10_000)
    expect(DAILY_LIMIT_MAX).toBe(100_000_000)
    expect(validDailyLimit(10_000)).toBe(true)
    expect(validDailyLimit(100_000_000)).toBe(true)
    expect(validDailyLimit(9_999)).toBe(false)
    expect(validDailyLimit(100_000_001)).toBe(false)
    expect(validDailyLimit(12_000.5)).toBe(false)
    expect(validDailyLimit("50000")).toBe(false)
  })
})

describe("what counts", () => {
  test("an organization counts the tasks of its members and of its lower organizations", () => {
    const used = orgUsedToday(
      tree,
      new Map([
        ["s1", 30_000],
        ["s2", 11_000],
        ["d", 5_000],
      ]),
    )
    expect(used.get("site")).toBe(41_000)
    expect(used.get("docs")).toBe(46_000)
    expect(used.get("product")).toBe(46_000)
    expect(used.get("ops")).toBe(0)
  })

  test("an agent in two organizations counts in both", () => {
    const used = orgUsedToday(tree, new Map([["both", 10_000]]))
    expect(used.get("docs")).toBe(10_000)
    expect(used.get("ops")).toBe(10_000)
    expect(used.get("product")).toBe(10_000)
  })

  test("an agent in an organization and in a higher one counts once in the higher one", () => {
    const twice = [org("a", "A", null, ["x"]), org("b", "B", "a", ["x"])]
    expect(orgUsedToday(twice, new Map([["x", 7]])).get("a")).toBe(7)
  })

  test("an agent in no organization counts nowhere", () => {
    const used = orgUsedToday(tree, new Map([["nobody", 99_000]]))
    expect([...used.values()].every((n) => n === 0)).toBe(true)
  })
})

describe("what stops a new task", () => {
  const used = (entries: [string, number][]) => orgUsedToday(tree, new Map(entries))

  test("no limit is used: nothing stops", () => {
    expect(stoppingOrg(tree, used([["s1", 41_000]]), ["site"])).toBeNull()
  })

  test("the limit of the organization of the agent stops it", () => {
    expect(stoppingOrg(tree, used([["s1", 51_000]]), ["docs"])?.name).toBe("Docs")
  })

  test("the limit of a higher organization stops the members of a lower one", () => {
    const stop = stoppingOrg(tree, used([["s1", 51_000]]), ["site"])
    expect(stop).toEqual({ id: "docs", name: "Docs" })
  })

  test("a limit that is used only in a lower organization does not stop its higher one", () => {
    expect(stoppingOrg(tree, used([["s1", 51_000]]), ["product"])).toBeNull()
  })

  test("the limit holds at exactly the limit", () => {
    expect(stoppingOrg(tree, used([["d", 50_000]]), ["docs"])?.id).toBe("docs")
    expect(stoppingOrg(tree, used([["d", 49_999]]), ["docs"])).toBeNull()
  })

  test("an agent in two organizations is stopped by either limit", () => {
    expect(stoppingOrg(tree, used([["o", 10_000]]), ["docs", "ops"])?.id).toBe("ops")
  })

  test("more than one limit used: the first name in the order of names, ignoring case", () => {
    const both = used([["both", 60_000]])
    // Docs (50,000) and Ops (10,000) are both used. "Docs" comes before "Ops".
    expect(stoppingOrg(tree, both, ["ops", "docs"])?.name).toBe("Docs")
    const lower = [org("a", "zeta", null, ["x"], 10_000), org("b", "Alpha", null, ["x"], 10_000)]
    expect(
      stoppingOrg(lower, orgUsedToday(lower, new Map([["x", 20_000]])), ["a", "b"])?.name,
    ).toBe("Alpha")
  })

  test("an agent in no organization has no limit", () => {
    expect(stoppingOrg(tree, used([["both", 90_000]]), [])).toBeNull()
  })

  test("a limit that is off never stops", () => {
    expect(stoppingOrg(tree, used([["s1", 5_000_000]]), ["site"])?.id).toBe("docs")
    expect(stoppingOrg(tree, used([["s1", 5_000_000]]), ["product"])?.id).toBe("product")
    const none = [org("n", "None", null, ["x"])]
    expect(stoppingOrg(none, orgUsedToday(none, new Map([["x", 9e9]])), ["n"])).toBeNull()
  })
})

describe("which tasks the limit can stop", () => {
  test("a task of a direct chat is never stopped; every other source can be", () => {
    for (const source of ["chat", "handover", "teams", "memory_check"] as const)
      expect(limitStopsSource(source)).toBe(false)
    for (const source of ["channel", "routine", "workflow", "agent", "question"] as const)
      expect(limitStopsSource(source)).toBe(true)
  })
})

describe("what the form and the usage page show", () => {
  test("the line at 80% shows from 80 percent, and the state is over at the limit", () => {
    expect(orgLimitView(50_000, 41_000)).toEqual({ limit: 50_000, used: 41_000, state: "near" })
    expect(orgLimitView(50_000, 39_999)).toEqual({ limit: 50_000, used: 39_999, state: "ok" })
    expect(orgLimitView(50_000, 51_000).state).toBe("over")
    expect(orgLimitView(null, 9e9)).toEqual({ limit: null, used: 9e9, state: "ok" })
  })

  test("the usage page lists the organizations with a limit, in the order of names", () => {
    const used = orgUsedToday(
      tree,
      new Map([
        ["s1", 41_000],
        ["o", 1_000],
      ]),
    )
    expect(orgUsageRows(tree, used)).toEqual([
      { orgId: "docs", name: "Docs", used: 41_000, limit: 50_000 },
      { orgId: "ops", name: "Ops", used: 1_000, limit: 10_000 },
      { orgId: "product", name: "Product", used: 41_000, limit: 200_000 },
    ])
  })
})
