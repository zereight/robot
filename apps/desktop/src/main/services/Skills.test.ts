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
