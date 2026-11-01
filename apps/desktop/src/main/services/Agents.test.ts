import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Effect, Exit } from "effect"
import { Activity } from "./Activity.ts"
import { Agents } from "./Agents.ts"
import { Places } from "./Places.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

const setup = async () => {
  const t = testRuntime()
  const server = await t.runtime.runPromise(Servers.use((s) => s.local))
  const run = <A, E>(effect: Effect.Effect<A, E, Agents | Activity | Places>) =>
    t.runtime.runPromise(effect)
  const exit = <A, E>(effect: Effect.Effect<A, E, Agents | Activity | Places>) =>
    t.runtime.runPromiseExit(effect)
  const create = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: server.id, name, role: "Helps", instructions: "Be brief." }),
      ),
    )
  return { ...t, server, run, exit, create }
}

const failCode = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

describe("Agents", () => {
  test("create makes a workspace folder and shows in the place list", async () => {
    const t = await setup()
    const agent = await t.create("Writer")
    expect(existsSync(agent.workspace)).toBe(true)
    expect(agent.workspace.startsWith(t.dataDir)).toBe(true)
    const sections = await t.run(Places.use((p) => p.list(t.server.id)))
    expect(sections.find((s) => s.id === "agents")?.places.map((p) => p.name)).toEqual(["Writer"])
  })

  test("names are unique on a server, ignoring case", async () => {
    const t = await setup()
    await t.create("Writer")
    const exit = await t.exit(
      Agents.use((a) =>
        a.create({ serverId: t.server.id, name: " writer ", role: "", instructions: "" }),
      ),
    )
    expect(failCode(exit)).toBe("agent_name_taken")
  })

  test("duplicate gives 'Name copy', then 'Name copy 2', with a new workspace", async () => {
    const t = await setup()
    const agent = await t.create("Writer")
    const first = await t.run(Agents.use((a) => a.duplicate(agent.id, " copy")))
    const second = await t.run(Agents.use((a) => a.duplicate(agent.id, " copy")))
    expect(first.name).toBe("Writer copy")
    expect(second.name).toBe("Writer copy 2")
    expect(first.workspace).not.toBe(agent.workspace)
    expect(first.role).toBe(agent.role)
    expect(first.face).toEqual(agent.face)
  })

  test("archive hides the agent; delete works only from the archive and trashes the workspace", async () => {
    const t = await setup()
    const agent = await t.create("Writer")
    expect(failCode(await t.exit(Agents.use((a) => a.remove(agent.id))))).toBe("agent_not_archived")
    await t.run(Agents.use((a) => a.archive(agent.id)))
    expect(await t.run(Agents.use((a) => a.list(t.server.id, false)))).toHaveLength(0)
    expect(await t.run(Agents.use((a) => a.list(t.server.id, true)))).toHaveLength(1)

    t.runtime.runSync(
      Activity.use((a) => Effect.sync(() => a.setWorking(agent.id, t.server.id, true))),
    )
    expect(failCode(await t.exit(Agents.use((a) => a.remove(agent.id))))).toBe("agent_working")
    t.runtime.runSync(
      Activity.use((a) => Effect.sync(() => a.setWorking(agent.id, t.server.id, false))),
    )

    await t.run(Agents.use((a) => a.remove(agent.id)))
    expect(t.trashed).toEqual([agent.workspace])
    expect(await t.run(Agents.use((a) => a.list(t.server.id, true)))).toHaveLength(0)
  })

  test("restore brings an archived agent back", async () => {
    const t = await setup()
    const agent = await t.create("Writer")
    await t.run(Agents.use((a) => a.archive(agent.id)))
    await t.run(Agents.use((a) => a.restore(agent.id)))
    expect((await t.run(Agents.use((a) => a.list(t.server.id, false)))).map((a) => a.name)).toEqual(
      ["Writer"],
    )
  })

  test("update keeps the identity and changes the fields", async () => {
    const t = await setup()
    const agent = await t.create("Writer")
    const next = await t.run(
      Agents.use((a) =>
        a.update(agent.id, {
          name: "Editor",
          face: { shape: 2, hue: 7 },
          model: { accountId: "acc", model: "m1", effort: null },
        }),
      ),
    )
    expect(next.id).toBe(agent.id)
    expect(next.workspace).toBe(agent.workspace)
    expect(next.name).toBe("Editor")
    expect(next.face).toEqual({ shape: 2, hue: 7 })
    expect(next.model?.model).toBe("m1")
  })

  test("a face picture is stored as a file and comes back as a data URL", async () => {
    const t = await setup()
    const agent = await t.create("Writer")
    const png = "data:image/png;base64,iVBORw0KGgo="
    const next = await t.run(Agents.use((a) => a.setFaceImage(agent.id, png)))
    expect(next.faceImage).toBe(png)
    const cleared = await t.run(Agents.use((a) => a.setFaceImage(agent.id, null)))
    expect(cleared.faceImage).toBeNull()
    const bad = await t.exit(
      Agents.use((a) => a.setFaceImage(agent.id, "data:text/html;base64,AAAA")),
    )
    expect(failCode(bad)).toBe("face_image_invalid")
  })
})
