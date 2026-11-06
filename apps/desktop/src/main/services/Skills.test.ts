import { describe, expect, test } from "bun:test"
import { SKILLS_MAX } from "@robot/shared"
import { type Effect, Exit } from "effect"
import { Servers } from "./Servers.ts"
import { Skills } from "./Skills.ts"
import { testRuntime } from "./testing.ts"

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const create = (name: string, instructions = "Do the work.") =>
    run(Skills.use((s) => s.create(server.id, { name, description: "", instructions })))
  const code = async <A>(effect: Effect.Effect<A, unknown, Skills>) => {
    const exit = await t.runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return "ok"
    return exit.cause.reasons
      .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
      .join()
  }
  return { ...t, run, server, create, code }
}

describe("skills belong to the server (spec 017)", () => {
  test("a new skill is on, and a taken name is refused, ignoring case", async () => {
    const t = await setup()
    const skill = await t.create("Weekly summary")
    expect(skill.enabled).toBe(true)
    expect(
      await t.code(
        Skills.use((s) =>
          s.create(t.server.id, { name: "/weekly SUMMARY", description: "", instructions: "x" }),
        ),
      ),
    ).toBe("skill_name_taken")
  })

  test("the checks of the form apply", async () => {
    const t = await setup()
    expect(
      await t.code(
        Skills.use((s) => s.create(t.server.id, { name: " ", description: "", instructions: "x" })),
      ),
    ).toBe("skill_name_empty")
    expect(
      await t.code(
        Skills.use((s) => s.create(t.server.id, { name: "A", description: "", instructions: "" })),
      ),
    ).toBe("skill_empty")
  })

  test("a server holds at most 100 skills", async () => {
    const t = await setup()
    for (let i = 0; i < SKILLS_MAX; i++) await t.create(`Skill ${i}`)
    expect(await t.run(Skills.use((s) => s.room(t.server.id)))).toBe(0)
    expect(
      await t.code(
        Skills.use((s) =>
          s.create(t.server.id, { name: "More", description: "", instructions: "x" }),
        ),
      ),
    ).toBe("skills_full")
  })

  test("edit keeps the on or off state, and the name may stay with another letter case", async () => {
    const t = await setup()
    const skill = await t.create("Check")
    await t.run(Skills.use((s) => s.setEnabled(skill.id, false)))
    const changed = await t.run(
      Skills.use((s) =>
        s.update(skill.id, { name: "CHECK", description: " note ", instructions: "New steps." }),
      ),
    )
    expect(changed).toMatchObject({
      name: "CHECK",
      description: "note",
      instructions: "New steps.",
      enabled: false,
    })
  })

  test("the name of another skill is refused when a skill is edited", async () => {
    const t = await setup()
    await t.create("One")
    const two = await t.create("Two")
    expect(
      await t.code(
        Skills.use((s) => s.update(two.id, { name: "one", description: "", instructions: "x" })),
      ),
    ).toBe("skill_name_taken")
  })

  test("a copy is off, has the word copy, and a copy of a copy is named from the copy", async () => {
    const t = await setup()
    const skill = await t.create("Check")
    const copy = await t.run(Skills.use((s) => s.duplicate(skill.id, " copy")))
    expect(copy).toMatchObject({
      name: "Check copy",
      enabled: false,
      instructions: skill.instructions,
    })
    const again = await t.run(Skills.use((s) => s.duplicate(copy.id, " copy")))
    expect(again.name).toBe("Check copy copy")
  })

  test("only a skill that is on is usable, and a deleted skill is not", async () => {
    const t = await setup()
    const skill = await t.create("Check")
    expect((await t.run(Skills.use((s) => s.enabled(t.server.id)))).map((s) => s.name)).toEqual([
      "Check",
    ])
    await t.run(Skills.use((s) => s.setEnabled(skill.id, false)))
    expect(await t.code(Skills.use((s) => s.usable(skill.id)))).toBe("skill_unavailable")
    await t.run(Skills.use((s) => s.remove(skill.id)))
    expect(await t.run(Skills.use((s) => s.list(t.server.id)))).toEqual([])
  })

  test("a change tells the window", async () => {
    const t = await setup()
    await t.create("Check")
    expect(t.events.filter((e) => e.event === "skills.changed").length).toBeGreaterThan(0)
  })
})
