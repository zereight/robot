import { describe, expect, test } from "bun:test"
import {
  activeMembers,
  effectiveLead,
  goalTooLong,
  type MigrationChannel,
  migratedOrgId,
  numberedOrgName,
  ORG_NAME_MAX,
  orgGoalsOfAgent,
  orgNameProblem,
  orgsOfAgent,
  planOrgMigration,
} from "./organizations.ts"

describe("the name (spec 030, Concepts)", () => {
  const taken =
    (...keys: string[]) =>
    (key: string) =>
      keys.includes(key)

  test("1 to 60 characters, counted as characters", () => {
    expect(orgNameProblem("Docs", taken())).toBeUndefined()
    expect(orgNameProblem("   ", taken())).toBe("invalid")
    expect(orgNameProblem("", taken())).toBe("invalid")
    expect(orgNameProblem("a".repeat(ORG_NAME_MAX), taken())).toBeUndefined()
    expect(orgNameProblem("a".repeat(ORG_NAME_MAX + 1), taken())).toBe("invalid")
    // 60 characters of 2 code units each.
    expect(orgNameProblem("😀".repeat(ORG_NAME_MAX), taken())).toBeUndefined()
  })

  test('the check ignores case: "product" is refused when "Product" exists', () => {
    expect(orgNameProblem("product", taken("product"))).toBe("taken")
    expect(orgNameProblem("  PRODUCT ", taken("product"))).toBe("taken")
    expect(orgNameProblem("Products", taken("product"))).toBeUndefined()
  })

  test("a taken name gets a number inside the length limit", () => {
    expect(numberedOrgName("Docs", taken())).toBe("Docs")
    expect(numberedOrgName("Docs", taken("docs"))).toBe("Docs 2")
    expect(numberedOrgName("Docs", taken("docs", "docs 2"))).toBe("Docs 3")
    const long = "x".repeat(ORG_NAME_MAX)
    const numbered = numberedOrgName(long, taken(long))
    expect(numbered).toBe(`${"x".repeat(ORG_NAME_MAX - 2)} 2`)
    expect([...numbered].length).toBe(ORG_NAME_MAX)
  })
})

describe("members and lead (spec 030, Concepts)", () => {
  const org = { id: "o", memberIds: ["a", "b", "c"], leadId: "b" }

  test("an archived lead counts as no lead; a lead that is no member counts as none", () => {
    expect(effectiveLead(org, new Set())).toBe("b")
    expect(effectiveLead(org, new Set(["b"]))).toBeNull()
    expect(effectiveLead({ ...org, memberIds: ["a", "c"] }, new Set())).toBeNull()
    expect(effectiveLead({ ...org, leadId: null }, new Set())).toBeNull()
  })

  test("an archived agent stays a member, and the rules skip it", () => {
    expect(activeMembers(org, new Set(["a"]))).toEqual(["b", "c"])
    expect(activeMembers(org, new Set())).toEqual(["a", "b", "c"])
  })

  test("the organizations of an agent: any number", () => {
    const orgs = [org, { id: "p", memberIds: ["a"] }, { id: "q", memberIds: [] }]
    expect(orgsOfAgent(orgs, "a").map((o) => o.id)).toEqual(["o", "p"])
    expect(orgsOfAgent(orgs, "z")).toEqual([])
  })
})

describe("the migration of channels (spec 030, Migration)", () => {
  const channel = (id: string, extra: Partial<MigrationChannel> = {}): MigrationChannel => ({
    id,
    serverId: "s",
    name: id,
    parentId: null,
    leadId: null,
    memberIds: [],
    dailyTokenLimit: null,
    hasTools: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  })
  const ids = (list: { id: string }[]) => list.map((o) => o.id)

  test('acceptance: "Docs" under "Product" with a tool and a limit; "Chat" makes none', () => {
    const plan = planOrgMigration(
      [
        channel("Product", { memberIds: ["m1"], leadId: "m1", createdAt: 1 }),
        channel("Docs", {
          parentId: "Product",
          memberIds: ["m1", "m2"],
          leadId: "m2",
          hasTools: true,
          dailyTokenLimit: 50_000,
          createdAt: 2,
        }),
        channel("Chat", { memberIds: ["m1", "m2"] }),
      ],
      { alongChannels: false },
    )
    expect(plan.map((o) => o.name)).toEqual(["Product", "Docs"])
    const docs = plan.find((o) => o.name === "Docs")
    expect(docs).toMatchObject({
      id: migratedOrgId("Docs"),
      parentId: migratedOrgId("Product"),
      memberIds: ["m1", "m2"],
      leadId: "m2",
      dailyTokenLimit: 50_000,
      handOffRange: "inherit",
      channelId: "Docs",
    })
    expect(plan.find((o) => o.name === "Product")?.parentId).toBeNull()
  })

  test("a channel with a sub-channel, a tool, or a limit makes one; a channel with none does not", () => {
    const plan = planOrgMigration(
      [
        channel("parent"),
        channel("sub", { parentId: "parent" }),
        channel("tool", { hasTools: true }),
        channel("limit", { dailyTokenLimit: 10_000 }),
        channel("plain", { memberIds: ["m1", "m2", "m3"] }),
        channel("empty"),
      ],
      { alongChannels: false },
    )
    expect(ids(plan).sort()).toEqual(["parent", "sub", "tool", "limit"].map(migratedOrgId).sort())
  })

  test('with the hand-off rule "Along the channels", a channel with two members makes one too', () => {
    const channels = [
      channel("Chat", { memberIds: ["m1", "m2"] }),
      channel("Solo", { memberIds: ["m1"] }),
    ]
    expect(ids(planOrgMigration(channels, { alongChannels: true }))).toEqual([
      migratedOrgId("Chat"),
    ])
    expect(planOrgMigration(channels, { alongChannels: false })).toEqual([])
  })

  test("the id comes from the channel id, so two computers make the same one", () => {
    const channels = [channel("c1", { hasTools: true }), channel("c2", { hasTools: true })]
    const first = planOrgMigration(channels, { alongChannels: false })
    const second = planOrgMigration([...channels].reverse(), { alongChannels: false })
    expect(ids(first).sort()).toEqual(ids(second).sort())
    expect(ids(first)).toContain("org-c1")
  })

  test("a lead that is no member is dropped; a taken name gets a number in the order of making", () => {
    const plan = planOrgMigration(
      [
        channel("c-late", { name: "Docs", hasTools: true, createdAt: 9, leadId: "gone" }),
        channel("c-early", { name: "docs", hasTools: true, createdAt: 3 }),
      ],
      { alongChannels: false, taken: (_server, key) => key === "ops" },
    )
    // The channel made first keeps the name. The other one gets a number, whatever the input order.
    expect(plan.map((o) => [o.channelId, o.name])).toEqual([
      ["c-early", "docs"],
      ["c-late", "Docs 2"],
    ])
    expect(plan.find((o) => o.channelId === "c-late")?.leadId).toBeNull()
  })

  test("a name that an existing organization holds gets a number; the same name on another server does not", () => {
    const plan = planOrgMigration(
      [
        channel("a", { name: "Ops", hasTools: true, serverId: "s1" }),
        channel("b", { name: "Ops", hasTools: true, serverId: "s2" }),
      ],
      { alongChannels: false, taken: (server, key) => server === "s1" && key === "ops" },
    )
    expect(plan.map((o) => [o.channelId, o.name])).toEqual([
      ["a", "Ops 2"],
      ["b", "Ops"],
    ])
  })
})

describe("the goals that an agent reads (spec 030, Goal)", () => {
  const org = (
    id: string,
    goal: string,
    parentId: string | null = null,
    memberIds: string[] = ["a"],
  ) => ({
    id,
    serverId: "s",
    name: id,
    goal,
    memberIds,
    leadId: null,
    parentId,
    handOffRange: "inherit" as const,
    dailyTokenLimit: null,
    createdAt: 1,
  })

  test("the goal of each organization of the agent, from the top organization down", () => {
    // Written out of order on purpose: the result must not depend on the order of the list.
    const orgs = [
      org("Site", "Site goal", "Docs"),
      org("Product", "Product goal"),
      org("Docs", "Docs goal", "Product"),
    ]
    expect(orgGoalsOfAgent(orgs, "a").map((g) => g.name)).toEqual(["Product", "Docs", "Site"])
  })

  test("an empty goal gives nothing, and an agent in no organization reads none", () => {
    expect(orgGoalsOfAgent([org("Docs", "   ")], "a")).toEqual([])
    expect(orgGoalsOfAgent([org("Docs", "Docs goal")], "z")).toEqual([])
  })

  test("the goal of a higher organization is not given to a member of a lower one", () => {
    const orgs = [
      org("Product", "Product goal", null, ["b"]),
      org("Docs", "Docs goal", "Product", ["a"]),
    ]
    expect(orgGoalsOfAgent(orgs, "a")).toEqual([{ name: "Docs", text: "Docs goal" }])
  })

  test("a goal longer than 400 characters is refused", () => {
    expect(goalTooLong("x".repeat(400))).toBe(false)
    expect(goalTooLong("x".repeat(401))).toBe(true)
  })
})
