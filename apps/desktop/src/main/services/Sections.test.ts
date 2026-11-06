import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type PlaceKind, SECTION_NAME_MAX } from "@robot/shared"
import { Exit, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { AgentFiles } from "./AgentFiles.ts"
import { Agents } from "./Agents.ts"
import { Places } from "./Places.ts"
import { Secrets } from "./Secrets.ts"
import { Sections } from "./Sections.ts"
import { Servers } from "./Servers.ts"
import { testPlatform, testRuntime } from "./testing.ts"

const setup = async () => {
  const t = testRuntime()
  const server = await t.runtime.runPromise(Servers.use((s) => s.local))
  const run = t.runtime.runPromise
  const exit = t.runtime.runPromiseExit
  const section = (kind: PlaceKind, name: string) =>
    run(Sections.use((s) => s.create({ serverId: server.id, kind, name })))
  const agent = (name: string, sectionId?: string | null) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: server.id,
          name,
          role: "",
          instructions: "",
          ...(sectionId !== undefined ? { sectionId } : {}),
        }),
      ),
    )
  const move = (kind: PlaceKind, id: string, sectionId: string | null) =>
    run(Sections.use((s) => s.assign({ kind, id }, sectionId)))
  const places = async (builtIn: "agents") => {
    const list = await run(Places.use((p) => p.list(server.id)))
    const found = list.find((s) => s.id === builtIn)
    if (!found) throw new Error("no section")
    return {
      none: found.places.map((p) => p.name),
      sections: found.sections.map((s) => ({ name: s.name, places: s.places.map((p) => p.name) })),
    }
  }
  return { ...t, run, exit, server, section, agent, move, places }
}

const failCode = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

describe("make a section", () => {
  test("a new section is last, empty, and has the trimmed name", async () => {
    const t = await setup()
    const first = await t.section("agent", "  Research ")
    const second = await t.section("agent", "Ops")
    expect(first.name).toBe("Research")
    expect(first.position).toBeLessThan(second.position)
    expect(await t.places("agents")).toEqual({
      none: [],
      sections: [
        { name: "Research", places: [] },
        { name: "Ops", places: [] },
      ],
    })
  })

  test("a name has 1 to 40 characters", async () => {
    const t = await setup()
    for (const bad of ["", "   ", "a".repeat(SECTION_NAME_MAX + 1)])
      expect(
        failCode(
          await t.exit(
            Sections.use((s) => s.create({ serverId: t.server.id, kind: "agent", name: bad })),
          ),
        ),
      ).toBe("section_name_invalid")
    await t.section("agent", "a".repeat(SECTION_NAME_MAX))
  })

  test("a server that does not exist is refused", async () => {
    const t = await setup()
    const exit = await t.exit(
      Sections.use((s) => s.create({ serverId: "nope", kind: "agent", name: "X" })),
    )
    expect(failCode(exit)).toBe("invalid_input")
  })

  test("a places change event tells the lists", async () => {
    const t = await setup()
    t.events.length = 0
    await t.section("agent", "Research")
    expect(t.events.map((e) => e.event)).toContain("places.changed")
  })
})

describe("rename and order", () => {
  test("rename keeps the rules, and a section may keep its own name in another case", async () => {
    const t = await setup()
    const research = await t.section("agent", "Research")
    await t.section("agent", "Ops")
    const taken = await t.exit(Sections.use((s) => s.rename(research.id, "OPS")))
    expect(failCode(taken)).toBe("section_name_taken")
    const empty = await t.exit(Sections.use((s) => s.rename(research.id, "  ")))
    expect(failCode(empty)).toBe("section_name_invalid")
    const renamed = await t.run(Sections.use((s) => s.rename(research.id, "RESEARCH")))
    expect(renamed.name).toBe("RESEARCH")
    const missing = await t.exit(Sections.use((s) => s.rename("nope", "X")))
    expect(failCode(missing)).toBe("section_not_found")
  })

  test("move up and move down swap neighbours; at an end nothing changes", async () => {
    const t = await setup()
    const a = await t.section("agent", "A")
    await t.section("agent", "B")
    const c = await t.section("agent", "C")
    const names = async () => (await t.places("agents")).sections.map((s) => s.name)
    await t.run(Sections.use((s) => s.move(a.id, "up")))
    expect(await names()).toEqual(["A", "B", "C"])
    await t.run(Sections.use((s) => s.move(c.id, "down")))
    expect(await names()).toEqual(["A", "B", "C"])
    await t.run(Sections.use((s) => s.move(c.id, "up")))
    expect(await names()).toEqual(["A", "C", "B"])
    await t.run(Sections.use((s) => s.move(a.id, "down")))
    expect(await names()).toEqual(["C", "A", "B"])
  })

  test("a section made after a delete is still last", async () => {
    const t = await setup()
    await t.section("agent", "A")
    const b = await t.section("agent", "B")
    await t.section("agent", "C")
    await t.run(Sections.use((s) => s.remove(b.id)))
    await t.section("agent", "D")
    expect((await t.places("agents")).sections.map((s) => s.name)).toEqual(["A", "C", "D"])
  })
})

describe("put places in sections", () => {
  test("a moved agent shows in its section and not among the others", async () => {
    const t = await setup()
    const research = await t.section("agent", "Research")
    const ada = await t.agent("Ada")
    await t.agent("Bo")
    await t.move("agent", ada.id, research.id)
    expect(await t.places("agents")).toEqual({
      none: ["Bo"],
      sections: [{ name: "Research", places: ["Ada"] }],
    })
    expect((await t.run(Agents.use((a) => a.get(ada.id)))).sectionId).toBe(research.id)
    // Back to no section: Ada comes last there (spec 001, "Order of places").
    await t.move("agent", ada.id, null)
    expect(await t.places("agents")).toEqual({
      none: ["Bo", "Ada"],
      sections: [{ name: "Research", places: [] }],
    })
  })

  test("the order of the places inside a section is the order of the moves", async () => {
    const t = await setup()
    const r = await t.section("agent", "R")
    const ids = []
    for (const name of ["Cy", "Ada", "Bo"]) ids.push((await t.agent(name)).id)
    for (const id of ids) await t.move("agent", id, r.id)
    expect((await t.places("agents")).sections[0]?.places).toEqual(["Cy", "Ada", "Bo"])
    await t.move("agent", ids[1] ?? "", null)
    await t.move("agent", ids[1] ?? "", r.id)
    expect((await t.places("agents")).sections[0]?.places).toEqual(["Cy", "Bo", "Ada"])
  })
})

describe("delete a section", () => {
  test("its places move to no section; none is deleted", async () => {
    const t = await setup()
    const research = await t.section("agent", "Research")
    const other = await t.section("agent", "Ops")
    const ada = await t.agent("Ada", research.id)
    const bo = await t.agent("Bo", research.id)
    const cy = await t.agent("Cy", other.id)
    await t.run(Sections.use((s) => s.remove(research.id)))
    expect(await t.places("agents")).toEqual({
      none: ["Ada", "Bo"],
      sections: [{ name: "Ops", places: ["Cy"] }],
    })
    for (const a of [ada, bo, cy]) {
      const found = await t.run(Agents.use((x) => x.get(a.id)))
      expect(found.archived).toBe(false)
    }
    expect((await t.run(Agents.use((x) => x.get(ada.id)))).sectionId).toBeNull()
    const gone = await t.exit(Sections.use((s) => s.remove(research.id)))
    expect(failCode(gone)).toBe("section_not_found")
  })

  test("a deleted name can be used again", async () => {
    const t = await setup()
    const research = await t.section("agent", "Research")
    await t.run(Sections.use((s) => s.remove(research.id)))
    await t.section("agent", "Research")
  })

  test("an archived agent in the section moves out too", async () => {
    const t = await setup()
    const research = await t.section("agent", "Research")
    const ada = await t.agent("Ada", research.id)
    await t.run(Agents.use((a) => a.archive(ada.id)))
    await t.run(Sections.use((s) => s.remove(research.id)))
    const restored = await t.run(Agents.use((a) => a.restore(ada.id)))
    expect(restored.sectionId).toBeNull()
    expect((await t.places("agents")).none).toEqual(["Ada"])
  })
})

describe("archive, restore and duplicate", () => {
  test("archive keeps the section and restore returns the agent to it", async () => {
    const t = await setup()
    const research = await t.section("agent", "Research")
    const ada = await t.agent("Ada", research.id)
    const archived = await t.run(Agents.use((a) => a.archive(ada.id)))
    expect(archived.sectionId).toBe(research.id)
    expect((await t.places("agents")).sections[0]?.places).toEqual([])
    const restored = await t.run(Agents.use((a) => a.restore(ada.id)))
    expect(restored.sectionId).toBe(research.id)
    expect((await t.places("agents")).sections[0]?.places).toEqual(["Ada"])
  })

  test("a duplicate joins the section of the original", async () => {
    const t = await setup()
    const research = await t.section("agent", "Research")
    const ada = await t.agent("Ada", research.id)
    const copy = await t.run(Agents.use((a) => a.duplicate(ada.id, " copy")))
    expect(copy.sectionId).toBe(research.id)
    expect((await t.places("agents")).sections[0]?.places).toEqual(["Ada", "Ada copy"])
    const plain = await t.agent("Bo")
    const plainCopy = await t.run(Agents.use((a) => a.duplicate(plain.id, " copy")))
    expect(plainCopy.sectionId).toBeNull()
  })
})

describe("the agent file", () => {
  test("an export writes no section, and an import reads none", async () => {
    const { platform, dataDir } = testPlatform()
    const file = join(dataDir, "team.json")
    const pick = { save: file as string | undefined, open: file as string | undefined }
    const runtime = ManagedRuntime.make(
      appLayer({
        platform: {
          ...platform,
          pickAgentFileSave: async () => pick.save,
          pickAgentFile: async () => pick.open,
        },
        databaseFile: ":memory:",
        localServerName: "Test computer",
        emit: () => {},
        secrets: Secrets.memory,
      }),
    )
    const run = runtime.runPromise
    const server = await run(Servers.use((s) => s.local))
    const research = await run(
      Sections.use((s) => s.create({ serverId: server.id, kind: "agent", name: "Secret Section" })),
    )
    const ada = await run(
      Agents.use((a) =>
        a.create({
          serverId: server.id,
          name: "Ada",
          role: "",
          instructions: "",
          sectionId: research.id,
        }),
      ),
    )
    await run(AgentFiles.use((f) => f.export({ serverId: server.id, agentIds: [ada.id] })))
    const text = readFileSync(file, "utf8")
    expect(text).not.toContain("Secret Section")
    expect(text).not.toContain(research.id)
    expect(text.toLowerCase()).not.toContain("section")

    // A file that names a section is read without it: the agent has none.
    const parsed = JSON.parse(text) as { agents: Record<string, unknown>[] }
    for (const a of parsed.agents) {
      a.sectionId = research.id
      a.section = "Secret Section"
    }
    writeFileSync(file, JSON.stringify(parsed))
    const preview = await run(AgentFiles.use((f) => f.open(server.id)))
    const picks = (preview?.agents ?? []).map((_, index) => ({
      index,
      instructions: true,
      routines: [],
    }))
    await run(AgentFiles.use((f) => f.import({ serverId: server.id, model: null, pick: picks })))
    const made = (await run(Agents.use((a) => a.list(server.id, false)))).find(
      (a) => a.name === "Ada 2",
    )
    expect(made).toBeDefined()
    expect(made?.sectionId).toBeNull()
    await runtime.dispose()
  })
})

describe("pinned places and the order of places", () => {
  const all = async (t: Awaited<ReturnType<typeof setup>>) => {
    const list = await t.run(Places.use((p) => p.list(t.server.id)))
    return list.flatMap((s) => [s.places, ...s.sections.map((u) => u.places)].flat())
  }
  const pin = (kind: PlaceKind, id: string, pinned: boolean) =>
    Sections.use((s) => s.pin({ kind, id }, pinned))

  test("at 10 pinned places the next pin is refused; an archived place does not count", async () => {
    const t = await setup()
    const made: { id: string }[] = []
    for (let i = 0; i < 11; i++) made.push(await t.agent(`Agent ${i}`))
    for (const a of made.slice(0, 10)) await t.run(pin("agent", a.id, true))
    const over = await t.exit(pin("agent", (made[10] as { id: string }).id, true))
    expect(failCode(over)).toBe("pin_limit")
    await t.run(Agents.use((a) => a.archive((made[0] as { id: string }).id)))
    await t.run(pin("agent", (made[10] as { id: string }).id, true))
    // The archived agent left the group, and a restore does not pin it again.
    await t.run(Agents.use((a) => a.restore((made[0] as { id: string }).id)))
    const back = (await all(t)).find((p) => p.name === "Agent 0")
    expect(back?.pinRank).toBeUndefined()
  })

  test("order sets the spots; the places that were not ordered follow by name", async () => {
    const t = await setup()
    const a = await t.agent("A")
    const b = await t.agent("B")
    const c = await t.agent("C")
    await t.run(
      Sections.use((s) =>
        s.order([
          { kind: "agent", id: c.id },
          { kind: "agent", id: b.id },
        ]),
      ),
    )
    expect((await t.places("agents")).none).toEqual(["C", "B", "A"])
    expect(a.name).toBe("A")
  })

  test("a place that moves to another list comes last there", async () => {
    const t = await setup()
    const sec = await t.section("agent", "Team")
    const a = await t.agent("A", sec.id)
    await t.agent("B", sec.id)
    const c = await t.agent("C")
    await t.move("agent", c.id, sec.id)
    expect((await t.places("agents")).sections[0]?.places).toEqual(["A", "B", "C"])
    await t.move("agent", a.id, null)
    await t.move("agent", a.id, sec.id)
    expect((await t.places("agents")).sections[0]?.places).toEqual(["B", "C", "A"])
  })

  test("order refuses an unknown place and an empty list", async () => {
    const t = await setup()
    const none = await t.exit(Sections.use((s) => s.order([{ kind: "agent", id: "nope" }])))
    expect(failCode(none)).toBe("agent_not_found")
    const empty = await t.exit(Sections.use((s) => s.order([])))
    expect(failCode(empty)).toBe("invalid_input")
  })
})
