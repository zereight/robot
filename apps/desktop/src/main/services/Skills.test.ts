import { describe, expect, test } from "bun:test"
import { SKILLS_MAX } from "@robot/shared"
import { Effect, Exit } from "effect"
import { Activity } from "./Activity.ts"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { Servers } from "./Servers.ts"
import { Skills } from "./Skills.ts"
import { testRuntime } from "./testing.ts"

// Skills go with their only agent (spec 002 flow 9, spec 017 "Rules"): the delete of an agent takes
// it out of the list of every skill, deletes a skill that was only for it, and archive changes
// nothing.

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: server.id, name, role: "", instructions: "Be brief." }),
      ),
    )
  const skill = (name: string, agentIds: readonly string[] | null) =>
    run(
      Skills.use((s) =>
        s.create(server.id, { name, description: "", instructions: "Do the work." }, agentIds),
      ),
    )
  const list = () => run(Skills.use((s) => s.list(server.id)))
  const onlyFor = (agentId: string) => run(Skills.use((s) => s.onlyFor(agentId)))
  const archive = (id: string) => run(Agents.use((a) => a.archive(id)))
  const remove = (id: string) => run(Agents.use((a) => a.remove(id)))
  const skillEvents = () => t.events.filter((e) => e.event === "skills.changed")
  const failure = async (id: string) => {
    const exit = await t.runtime.runPromiseExit(Agents.use((a) => a.remove(id)))
    if (Exit.isSuccess(exit)) return "ok"
    return exit.cause.reasons
      .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
      .join()
  }
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const rows = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all(statement, ...params))))
  return {
    ...t,
    run,
    rows,
    server,
    agent,
    skill,
    list,
    onlyFor,
    archive,
    remove,
    skillEvents,
    failure,
    sql,
  }
}

describe("Skills go with their only agent", () => {
  test("the delete of agent A: its own skill goes, the shared one is only for B, the one for all stays", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const b = await t.agent("Bo")
    await t.skill("Only A", [a.id])
    await t.skill("A and B", [a.id, b.id])
    await t.skill("Everyone", null)
    await t.archive(a.id)
    // The confirm text names the count before the delete.
    expect(await t.onlyFor(a.id)).toBe(1)

    await t.remove(a.id)

    const after = await t.list()
    expect(after.map((s) => s.name)).toEqual(["A and B", "Everyone"])
    expect(after.find((s) => s.name === "A and B")?.agentIds).toEqual([b.id])
    expect(after.find((s) => s.name === "Everyone")?.agentIds).toBeNull()
  })

  test("the skills that a starter and Teach a task make for one agent go with it", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const input = { description: "", instructions: "Do it." }
    await t.run(Skills.use((s) => s.createForAgent(a.id, { name: "Starter skill", ...input })))
    await t.run(Skills.use((s) => s.createForAgent(a.id, { name: "Taught", ...input })))
    await t.archive(a.id)
    expect(await t.onlyFor(a.id)).toBe(2)
    await t.remove(a.id)
    expect(await t.list()).toEqual([])
  })

  test("archive changes no skill, and restore brings the agent back to its skill", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    await t.skill("Only A", [a.id])
    const before = await t.list()
    t.events.length = 0
    await t.archive(a.id)
    expect(await t.list()).toEqual(before)
    expect(await t.onlyFor(a.id)).toBe(1)
    expect(t.skillEvents()).toHaveLength(0)
    await t.run(Agents.use((x) => x.restore(a.id)))
    expect((await t.run(Skills.use((s) => s.forAgent(a.id)))).map((s) => s.name)).toEqual([
      "Only A",
    ])
  })

  test("the count is 0 when no skill is only for the agent, and a shared skill still loses the agent", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const b = await t.agent("Bo")
    await t.skill("Shared", [a.id, b.id])
    await t.skill("Everyone", null)
    await t.skill("Only B", [b.id])
    await t.archive(a.id)
    expect(await t.onlyFor(a.id)).toBe(0)
    t.events.length = 0
    await t.remove(a.id)
    // The shared skill lost an agent, so the window hears about it.
    expect(t.skillEvents()).toHaveLength(1)
    expect((await t.list()).find((s) => s.name === "Shared")?.agentIds).toEqual([b.id])
  })

  test("a delete that changes no skill says nothing about skills", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    await t.skill("Everyone", null)
    await t.archive(a.id)
    t.events.length = 0
    await t.remove(a.id)
    expect(t.skillEvents()).toHaveLength(0)
    expect(await t.list()).toHaveLength(1)
  })

  test("a delete that is refused changes no skill", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    await t.skill("Only A", [a.id])
    // Not archived.
    expect(await t.failure(a.id)).toBe("agent_not_archived")
    await t.archive(a.id)
    // Working.
    t.runtime.runSync(Activity.use((x) => Effect.sync(() => x.setWorking(a.id, t.server.id, true))))
    expect(await t.failure(a.id)).toBe("agent_working")
    expect(await t.list()).toHaveLength(1)
    expect(await t.onlyFor(a.id)).toBe(1)
  })

  test("the deleted skill frees its name and its place in the limit", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    await t.skill("Only A", [a.id])
    await t.archive(a.id)
    await t.remove(a.id)
    const again = await t.skill("only a", null)
    expect(again.name).toBe("only a")
    expect(SKILLS_MAX).toBeGreaterThan((await t.list()).length)
  })

  test("a skill with an agent that went before this rule is deleted with the last agent that is left", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const b = await t.agent("Bo")
    const made = await t.skill("Old", [a.id, b.id])
    // The list holds an id of an agent that does not exist any more.
    await t.sql("UPDATE skill SET agents = ? WHERE id = ?", JSON.stringify(["gone", b.id]), made.id)
    await t.archive(b.id)
    expect(await t.onlyFor(b.id)).toBe(1)
    await t.remove(b.id)
    expect(await t.list()).toEqual([])
  })

  test("a skill with a list that cannot be read is left as it is, and the delete still works", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.skill("Odd", [a.id])
    await t.sql("UPDATE skill SET agents = ? WHERE id = ?", "not json", made.id)
    await t.archive(a.id)
    expect(await t.onlyFor(a.id)).toBe(0)
    await t.remove(a.id)
    expect(await t.rows("SELECT id FROM skill WHERE id = ?", made.id)).toHaveLength(1)
    expect(await t.rows("SELECT id FROM agent WHERE id = ?", a.id)).toHaveLength(0)
  })

  test("the skills of another agent are not touched by a delete", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const b = await t.agent("Bo")
    await t.skill("Only B", [b.id])
    await t.archive(a.id)
    await t.remove(a.id)
    expect((await t.list()).map((s) => s.name)).toEqual(["Only B"])
  })
})

// Edit and Duplicate (spec 017, flows 2 and 3).

describe("Edit a skill", () => {
  const form = (name: string, instructions = "Do the new work.") => ({
    name,
    description: "When to use it",
    instructions,
  })
  const update = (
    t: Awaited<ReturnType<typeof setup>>,
    id: string,
    input: ReturnType<typeof form>,
    agentIds: readonly string[] | null,
  ) => t.run(Skills.use((s) => s.update(id, input, agentIds)))
  const codeOf = async (
    t: Awaited<ReturnType<typeof setup>>,
    id: string,
    input: ReturnType<typeof form>,
    agentIds: readonly string[] | null,
  ) => {
    const exit = await t.runtime.runPromiseExit(Skills.use((s) => s.update(id, input, agentIds)))
    if (Exit.isSuccess(exit)) return "ok"
    return exit.cause.reasons
      .map((r) => {
        const error = "error" in r ? (r.error as { code: string; detail?: string }) : undefined
        return `${error?.code}:${error?.detail ?? ""}`
      })
      .join()
  }

  test("every field changes, and the skill stays on or off as it was", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.skill("Weekly summary", null)
    await t.run(Skills.use((s) => s.setEnabled(made.id, false)))
    const before = t.skillEvents().length

    const edited = await update(t, made.id, form("/Monthly summary"), [a.id])

    expect(edited).toMatchObject({
      id: made.id,
      name: "Monthly summary",
      description: "When to use it",
      instructions: "Do the new work.",
      agentIds: [a.id],
      enabled: false,
      createdAt: made.createdAt,
    })
    expect((await t.list()).map((s) => s.name)).toEqual(["Monthly summary"])
    expect(t.skillEvents().length).toBe(before + 1)
  })

  test("the agent list can go back to all agents", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.skill("Only A", [a.id])
    expect((await update(t, made.id, form("Only A"), null)).agentIds).toBeNull()
  })

  test("the name may stay, also with another letter case", async () => {
    const t = await setup()
    const made = await t.skill("Weekly summary", null)
    expect((await update(t, made.id, form("Weekly summary"), null)).name).toBe("Weekly summary")
    expect((await update(t, made.id, form("WEEKLY summary"), null)).name).toBe("WEEKLY summary")
  })

  test("the name of another skill is refused, ignoring case, and nothing changes", async () => {
    const t = await setup()
    await t.skill("Weekly summary", null)
    const other = await t.skill("Check a claim", null)
    expect(await codeOf(t, other.id, form("weekly SUMMARY"), null)).toBe("skill_name_taken:name")
    expect((await t.list()).find((s) => s.id === other.id)?.name).toBe("Check a claim")
  })

  test("the checks of the form apply", async () => {
    const t = await setup()
    const made = await t.skill("Weekly summary", null)
    expect(await codeOf(t, made.id, form("   "), null)).toBe("skill_name_empty:name")
    expect(await codeOf(t, made.id, form("x".repeat(41)), null)).toBe("skill_name_long:name")
    expect(await codeOf(t, made.id, form("Ok", "   "), null)).toBe("skill_empty:instructions")
    expect(await codeOf(t, made.id, form("Ok", "x".repeat(20_001)), null)).toBe(
      "skill_empty:instructions",
    )
    expect((await t.list())[0]?.instructions).toBe("Do the work.")
  })

  test("a list of agents holds agents of this server, and is not empty", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.skill("Only A", [a.id])
    expect(await codeOf(t, made.id, form("Only A"), [])).toBe("skill_agents_invalid:agents")
    expect(await codeOf(t, made.id, form("Only A"), ["nobody"])).toBe("skill_agents_invalid:agents")
    expect((await t.list())[0]?.agentIds).toEqual([a.id])
  })

  test("an archived agent that the skill names stays in its list, and a restore brings it back", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const b = await t.agent("Bo")
    const made = await t.skill("Both", [a.id, b.id])
    await t.archive(a.id)
    const edited = await update(t, made.id, form("Both"), [a.id, b.id])
    expect(edited.agentIds).toEqual([a.id, b.id])
    // An archived agent that the skill does not name is not added.
    const c = await t.agent("Cy")
    await t.archive(c.id)
    expect(await codeOf(t, made.id, form("Both"), [b.id, c.id])).toBe("skill_agents_invalid:agents")
  })

  test("an id of an agent that is gone leaves the list when the skill is saved", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.skill("Old", [a.id])
    await t.sql("UPDATE skill SET agents = ? WHERE id = ?", JSON.stringify(["gone", a.id]), made.id)
    expect((await update(t, made.id, form("Old"), ["gone", a.id])).agentIds).toEqual([a.id])
  })

  test("a skill that does not exist is not available", async () => {
    const t = await setup()
    expect(await codeOf(t, "nope", form("Ok"), null)).toBe("skill_unavailable:")
  })

  test("the next send uses the new instructions", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.skill("Weekly summary", null)
    await update(t, made.id, form("Weekly summary", "New steps."), null)
    const usable = await t.run(Skills.use((s) => s.usable(a.id, made.id)))
    expect(usable.instructions).toBe("New steps.")
  })
})

describe("Duplicate a skill", () => {
  const duplicate = (t: Awaited<ReturnType<typeof setup>>, id: string, suffix = " copy") =>
    t.run(Skills.use((s) => s.duplicate(id, suffix)))

  test("the copy has the same fields, the word copy in its name, and it is off", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.run(
      Skills.use((s) =>
        s.create(
          t.server.id,
          { name: "Weekly summary", description: "Each Friday", instructions: "Do the work." },
          [a.id],
        ),
      ),
    )
    const before = t.skillEvents().length

    const copy = await duplicate(t, made.id)

    expect(copy).toMatchObject({
      name: "Weekly summary copy",
      description: "Each Friday",
      instructions: "Do the work.",
      agentIds: [a.id],
      enabled: false,
    })
    expect(copy.id).not.toBe(made.id)
    expect(made.enabled).toBe(true)
    expect((await t.list()).find((s) => s.id === made.id)?.enabled).toBe(true)
    expect(t.skillEvents().length).toBe(before + 1)
  })

  test("the copy of a skill for all agents is for all agents", async () => {
    const t = await setup()
    const made = await t.skill("Everyone", null)
    expect((await duplicate(t, made.id)).agentIds).toBeNull()
  })

  test("a copy name that is taken gets a number, ignoring case", async () => {
    const t = await setup()
    const made = await t.skill("Weekly summary", null)
    expect((await duplicate(t, made.id)).name).toBe("Weekly summary copy")
    expect((await duplicate(t, made.id)).name).toBe("Weekly summary copy 2")
    await t.skill("weekly summary COPY 3", null)
    expect((await duplicate(t, made.id)).name).toBe("Weekly summary copy 4")
  })

  test("the word comes from the language of the window", async () => {
    const t = await setup()
    const made = await t.skill("주간 요약", null)
    expect((await duplicate(t, made.id, " 사본")).name).toBe("주간 요약 사본")
  })

  test("a copy of a copy is named from the copy", async () => {
    const t = await setup()
    const made = await t.skill("Weekly summary", null)
    const first = await duplicate(t, made.id)
    expect((await duplicate(t, first.id)).name).toBe("Weekly summary copy copy")
  })

  test("a full server refuses the copy", async () => {
    const t = await setup()
    const made = await t.skill("Seed", null)
    for (let n = 1; n < SKILLS_MAX; n++) await t.skill(`Skill ${n}`, null)
    expect(await t.rows("SELECT id FROM skill")).toHaveLength(SKILLS_MAX)
    const exit = await t.runtime.runPromiseExit(Skills.use((s) => s.duplicate(made.id, " copy")))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await t.rows("SELECT id FROM skill")).toHaveLength(SKILLS_MAX)
  })

  test("a skill that does not exist is not available", async () => {
    const t = await setup()
    const exit = await t.runtime.runPromiseExit(Skills.use((s) => s.duplicate("nope", " copy")))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("a copy that is off is not listed for an agent until it is turned on", async () => {
    const t = await setup()
    const a = await t.agent("Ada")
    const made = await t.skill("Weekly summary", null)
    const copy = await duplicate(t, made.id)
    const names = async () => (await t.run(Skills.use((s) => s.forAgent(a.id)))).map((s) => s.name)
    expect(await names()).toEqual(["Weekly summary"])
    await t.run(Skills.use((s) => s.setEnabled(copy.id, true)))
    expect(await names()).toEqual(["Weekly summary", "Weekly summary copy"])
  })
})
