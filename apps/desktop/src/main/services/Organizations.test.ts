import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { Organizations } from "./Organizations.ts"
import { Servers } from "./Servers.ts"
import { Skills } from "./Skills.ts"
import { testRuntime } from "./testing.ts"

// The organizations (spec 030): make, edit and delete with the rules of the tree, the part "Tools"
// of the form, and the lines "From <organization>" of a profile.

const setup = async () => {
  const t = testRuntime({ name: "This Mac" })
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const db = await run(Database.use((d) => Effect.succeed(d)))
  const agent = (name: string) =>
    run(Agents.use((a) => a.create({ serverId: local.id, name, role: "", instructions: "" })))
  const org = (
    name: string,
    memberIds: string[],
    extra: { leadId?: string | null; parentId?: string | null } = {},
  ) =>
    run(
      Organizations.use((o) =>
        o.create({ serverId: local.id, name, memberIds, leadId: extra.leadId ?? null, ...extra }),
      ),
    )
  const codeOf = <A, E>(effect: Effect.Effect<A, E, Organizations>) =>
    run(
      effect.pipe(
        Effect.match({ onFailure: (e) => (e as { code?: string }).code, onSuccess: () => "ok" }),
      ),
    )
  const skill = (name: string, agentIds: string[] | null) =>
    run(
      Skills.use((k) =>
        k.create(local.id, { name, description: "d", instructions: "Do it." }, agentIds),
      ),
    )
  return { run, local, db, agent, org, codeOf, skill }
}

describe("make and edit", () => {
  test("a new organization has its members, lead and defaults, and the list is by name", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const b = await s.org("beta", [bo.id])
    const a = await s.org("Alpha", [ada.id, bo.id, ada.id], { leadId: bo.id })
    expect(a.memberIds).toEqual([ada.id, bo.id])
    expect(a.leadId).toBe(bo.id)
    expect(a.parentId).toBeNull()
    expect(a.handOffRange).toBe("inherit")
    expect(a.dailyTokenLimit).toBeNull()
    expect((await s.run(Organizations.use((o) => o.list(s.local.id)))).map((o) => o.id)).toEqual([
      a.id,
      b.id,
    ])
  })

  test("the name: 1 to 60 characters, unique when case is ignored", async () => {
    const s = await setup()
    await s.org("Support", [])
    const make = (name: string) =>
      s.codeOf(
        Organizations.use((o) =>
          o.create({ serverId: s.local.id, name, memberIds: [], leadId: null }),
        ),
      )
    expect(await make("SUPPORT")).toBe("org_name_taken")
    expect(await make("   ")).toBe("invalid_input")
    expect(await make("x".repeat(61))).toBe("invalid_input")
    expect(await make("x".repeat(60))).toBe("ok")
  })

  test("the lead must be a member; an unknown or archived agent is refused", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const make = (memberIds: string[], leadId: string | null) =>
      s.codeOf(
        Organizations.use((o) => o.create({ serverId: s.local.id, name: "T", memberIds, leadId })),
      )
    expect(await make([ada.id], bo.id)).toBe("invalid_lead")
    expect(await make(["nobody"], null)).toBe("agent_not_found")
    await s.run(Agents.use((a) => a.archive(bo.id)))
    expect(await make([bo.id], null)).toBe("agent_not_found")
  })

  test("an archived member stays; a member that is removed is no longer the lead", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const team = await s.org("Team", [ada.id, bo.id], { leadId: bo.id })
    await s.run(Agents.use((a) => a.archive(ada.id)))
    const renamed = await s.run(Organizations.use((o) => o.update(team.id, { name: "Crew" })))
    expect(renamed.memberIds).toEqual([ada.id, bo.id])
    const without = await s.run(
      Organizations.use((o) => o.update(team.id, { memberIds: [ada.id] })),
    )
    expect(without.leadId).toBeNull()
    expect(without.memberIds).toEqual([ada.id])
  })

  test("the range and the limit are stored; a limit out of range is refused", async () => {
    const s = await setup()
    const team = await s.org("Team", [])
    const set = (patch: { dailyTokenLimit?: number | null; handOffRange?: "own" | "all" }) =>
      s.run(Organizations.use((o) => o.update(team.id, patch)))
    expect((await set({ dailyTokenLimit: 50_000, handOffRange: "own" })).dailyTokenLimit).toBe(
      50_000,
    )
    expect((await set({ handOffRange: "all" })).dailyTokenLimit).toBe(50_000)
    expect(
      await s.codeOf(Organizations.use((o) => o.update(team.id, { dailyTokenLimit: 9_999 }))),
    ).toBe("invalid_daily_limit")
    expect((await set({ dailyTokenLimit: null })).dailyTokenLimit).toBeNull()
  })
})

describe("the tree", () => {
  test("Company > Support > Tier 1: a loop and a fourth level are refused; nothing changes", async () => {
    const s = await setup()
    const company = await s.org("Company", [])
    const support = await s.org("Support", [], { parentId: company.id })
    const tier = await s.org("Tier 1", [], { parentId: support.id })
    const setParent = (id: string, parentId: string | null) =>
      s.codeOf(Organizations.use((o) => o.update(id, { parentId })))
    expect(await setParent(company.id, tier.id)).toBe("org_parent_loop")
    expect(await setParent(company.id, company.id)).toBe("org_parent_loop")
    expect(await setParent(company.id, "nope")).toBe("org_parent_not_found")
    expect(
      await s.codeOf(
        Organizations.use((o) =>
          o.create({
            serverId: s.local.id,
            name: "Deep",
            memberIds: [],
            leadId: null,
            parentId: tier.id,
          }),
        ),
      ),
    ).toBe("org_parent_levels")
    expect((await s.run(Organizations.use((o) => o.get(company.id)))).parentId).toBeNull()
  })

  test("a deleted organization frees its sub-organizations; the members stay agents", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const company = await s.org("Company", [ada.id])
    const support = await s.org("Support", [ada.id], { parentId: company.id })
    await s.run(Organizations.use((o) => o.remove(company.id)))
    expect((await s.run(Organizations.use((o) => o.get(support.id)))).parentId).toBeNull()
    expect(await s.codeOf(Organizations.use((o) => o.get(company.id)))).toBe("org_not_found")
    expect(await s.run(Agents.use((a) => a.get(ada.id)))).toBeDefined()
    expect(s.db.get("SELECT 1 FROM org_member WHERE org_id = ?", company.id)).toBeUndefined()
  })
})

describe("tools", () => {
  test("a skill with a list of agents takes the value of an organization; 'All agents' stays on", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const team = await s.org("Team", [ada.id])
    const own = await s.skill("Own", [ada.id])
    const everyone = await s.skill("Everyone", null)

    const rows = (await s.run(Organizations.use((o) => o.tools(team.id)))).filter(
      (r) => r.kind === "skill",
    )
    expect(rows.find((r) => r.id === own.id)).toMatchObject({ choice: "inherit", all: false })
    expect(rows.find((r) => r.id === everyone.id)).toMatchObject({ choice: "on", all: true })

    const after = await s.run(Organizations.use((o) => o.setTool(team.id, "skill", own.id, "on")))
    expect(after.find((r) => r.id === own.id)?.choice).toBe("on")
    // "All agents" has no list: the switch changes nothing.
    const same = await s.run(
      Organizations.use((o) => o.setTool(team.id, "skill", everyone.id, "inherit")),
    )
    expect(same.find((r) => r.id === everyone.id)).toMatchObject({ choice: "on", all: true })
    expect(
      await s.codeOf(Organizations.use((o) => o.setTool(team.id, "skill", "nope", "on"))),
    ).toBe("skill_unavailable")
    expect(
      await s.codeOf(Organizations.use((o) => o.setTool(team.id, "connection", "nope", "on"))),
    ).toBe("connection_not_found")
  })

  test("a member of a lower organization has the skill 'From <organization>'", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const company = await s.org("Company", [bo.id])
    await s.org("Support", [ada.id], { parentId: company.id })
    // A skill with a list of agents holds at least one agent (spec 017).
    const own = await s.skill("Own", [bo.id])
    expect(await s.run(Organizations.use((o) => o.toolsOfAgent(ada.id)))).toEqual([])
    await s.run(Organizations.use((o) => o.setTool(company.id, "skill", own.id, "on")))
    expect(await s.run(Organizations.use((o) => o.toolsOfAgent(ada.id)))).toEqual([
      {
        kind: "skill",
        id: own.id,
        name: "Own",
        organizations: [{ id: company.id, name: "Company" }],
      },
    ])
  })

  test("'Off' is a value of its own: the row shows it, 'Inherit' takes it out of the list", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const team = await s.org("Team", [ada.id])
    const own = await s.skill("Own", [ada.id])
    const choice = async () =>
      (await s.run(Organizations.use((o) => o.tools(team.id)))).find((r) => r.id === own.id)?.choice
    const stored = async () =>
      (await s.run(Skills.use((k) => k.list(s.local.id)))).find((k) => k.id === own.id)
        ?.organizations
    await s.run(Organizations.use((o) => o.setTool(team.id, "skill", own.id, "off")))
    expect(await choice()).toBe("off")
    expect(await stored()).toEqual([{ id: team.id, value: "off" }])
    await s.run(Organizations.use((o) => o.setTool(team.id, "skill", own.id, "on")))
    expect(await choice()).toBe("on")
    await s.run(Organizations.use((o) => o.setTool(team.id, "skill", own.id, "inherit")))
    expect(await choice()).toBe("inherit")
    expect(await stored()).toEqual([])
  })

  describe("who may use a skill (spec 030 acceptance: Product, Docs, Site)", () => {
    // Product > Docs > Site. Ada is in Site, Bo in Docs and Product, Cy in Product, Di in none.
    const world = async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const bo = await s.agent("Bo")
      const cy = await s.agent("Cy")
      const di = await s.agent("Di")
      const product = await s.org("Product", [bo.id, cy.id])
      const docs = await s.org("Docs", [bo.id], { parentId: product.id })
      const site = await s.org("Site", [ada.id], { parentId: docs.id })
      // A list of one agent that is nobody of the four, so only organizations give the skill.
      const owner = await s.agent("Owner")
      const notes = await s.skill("Release notes", [owner.id])
      const set = (org: { id: string }, choice: "on" | "off" | "inherit") =>
        s.run(Organizations.use((o) => o.setTool(org.id, "skill", notes.id, choice)))
      const has = async (agent: { id: string }) =>
        (await s.run(Skills.use((k) => k.forAgent(agent.id)))).some((k) => k.id === notes.id)
      const from = async (agent: { id: string }) =>
        (await s.run(Organizations.use((o) => o.toolsOfAgent(agent.id)))).flatMap((t) =>
          t.organizations.map((g) => g.name),
        )
      return { s, ada, bo, cy, di, product, docs, site, notes, set, has, from }
    }

    test("'On' in Product reaches Site through Docs, also in the next turn; the profile names Product", async () => {
      const w = await world()
      expect(await w.has(w.ada)).toBe(false)
      await w.set(w.product, "on")
      expect(await w.has(w.ada)).toBe(true)
      expect(await w.from(w.ada)).toEqual(["Product"])
      expect(await w.has(w.di)).toBe(false)
    })

    test("'Off' in Docs takes it from Docs and Site, not from Product; 'On' in Site gives it back", async () => {
      const w = await world()
      await w.set(w.product, "on")
      await w.set(w.docs, "off")
      expect(await w.has(w.ada)).toBe(false)
      expect(await w.has(w.cy)).toBe(true)
      // Bo is a member of Docs and of Product: Product still gives it.
      expect(await w.has(w.bo)).toBe(true)
      await w.set(w.site, "on")
      expect(await w.has(w.ada)).toBe(true)
      expect(await w.from(w.ada)).toEqual(["Site"])
    })

    test("a row under 'Inherit' says 'Now' with the value and the organization that give it", async () => {
      const w = await world()
      const now = async (org: { id: string }) =>
        (await w.s.run(Organizations.use((o) => o.tools(org.id)))).find((r) => r.id === w.notes.id)
          ?.now
      expect(await now(w.site)).toBeNull()
      await w.set(w.product, "on")
      expect(await now(w.site)).toEqual({
        value: "on",
        organization: { id: w.product.id, name: "Product" },
      })
      await w.set(w.docs, "off")
      expect(await now(w.site)).toEqual({
        value: "off",
        organization: { id: w.docs.id, name: "Docs" },
      })
      // The top organization has nothing above it. A row with its own value says no 'Now'.
      expect(await now(w.product)).toBeNull()
      await w.set(w.site, "on")
      expect(await now(w.site)).toBeNull()
    })

    test("a member that leaves Site loses the skill in its next turn", async () => {
      const w = await world()
      await w.set(w.product, "on")
      expect(await w.has(w.ada)).toBe(true)
      await w.s.run(Organizations.use((o) => o.update(w.site.id, { memberIds: [] })))
      expect(await w.has(w.ada)).toBe(false)
    })

    test("'All agents' stays on: 'Off' in Docs takes nothing away", async () => {
      const w = await world()
      const everyone = await w.s.skill("Everyone", null)
      await w.s.run(Organizations.use((o) => o.setTool(w.docs.id, "skill", everyone.id, "off")))
      expect(
        (await w.s.run(Skills.use((k) => k.forAgent(w.ada.id)))).some((k) => k.id === everyone.id),
      ).toBe(true)
    })

    test("the own entry of the agent stays when its organization is 'Off'", async () => {
      const w = await world()
      const mine = await w.s.skill("Mine", [w.ada.id])
      await w.s.run(Organizations.use((o) => o.setTool(w.product.id, "skill", mine.id, "on")))
      await w.s.run(Organizations.use((o) => o.setTool(w.site.id, "skill", mine.id, "off")))
      expect(
        (await w.s.run(Skills.use((k) => k.forAgent(w.ada.id)))).some((k) => k.id === mine.id),
      ).toBe(true)
    })
  })

  test("a deleted organization leaves the list of the skill", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const team = await s.org("Team", [ada.id])
    const own = await s.skill("Own", [ada.id])
    await s.run(Organizations.use((o) => o.setTool(team.id, "skill", own.id, "on")))
    const listed = async () =>
      (await s.run(Skills.use((k) => k.list(s.local.id)))).find((k) => k.id === own.id)
        ?.organizations
    expect(await listed()).toEqual([{ id: team.id, value: "on" }])
    await s.run(Organizations.use((o) => o.remove(team.id)))
    expect(await listed()).toEqual([])
  })
})
