import { describe, expect, test } from "bun:test"
import type { Skill } from "@robot/shared"
import { isChangeMethod, isClientMethod, isRoutedMethod } from "@robot/shared"
import { runRequest } from "../rpc.ts"
import { Agents } from "../services/Agents.ts"
import { Servers } from "../services/Servers.ts"
import { Skills } from "../services/Skills.ts"
import { testRuntime } from "../services/testing.ts"

// A linked device reads the skills of one agent for its command list, and sends with a chip
// (spec 003, 011, 012, 017). It never sees the instructions, and it cannot make, edit, copy,
// turn on or off, or delete a skill.

const device = { id: "dev-1", name: "Phone" } as never

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
        s.create(
          server.id,
          { name, description: `About ${name}`, instructions: "SECRET STEPS" },
          agentIds,
        ),
      ),
    )
  return { ...t, run, agent, skill, server }
}

describe("skills for a linked device (spec 003, 012, 017)", () => {
  test("only the list of one agent is on the list of a client", () => {
    expect(isClientMethod("skills.forAgent")).toBe(true)
    expect(isRoutedMethod("skills.forAgent")).toBe(true)
    expect(isChangeMethod("skills.forAgent")).toBe(false)
    for (const method of [
      "skills.list",
      "skills.create",
      "skills.update",
      "skills.duplicate",
      "skills.setEnabled",
      "skills.delete",
      "skills.onlyFor",
      "skills.draft",
      "skills.draftCancel",
    ]) {
      expect(isClientMethod(method)).toBe(false)
    }
  })

  test("a client gets the skills that the agent may use now, with no instructions", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const bo = await t.agent("Bo")
    await t.skill("Everyone", null)
    await t.skill("Only Ada", [ada.id])
    await t.skill("Only Bo", [bo.id])
    const off = await t.skill("Switched off", null)
    await t.run(Skills.use((s) => s.setEnabled(off.id, false)))

    const result = await runRequest(t.runtime, "skills.forAgent", { agentId: ada.id }, device)

    expect(result.ok).toBe(true)
    const list = (result.ok ? result.value : []) as Skill[]
    expect(list.map((s) => s.name)).toEqual(["Everyone", "Only Ada"])
    expect(list.map((s) => s.description)).toEqual(["About Everyone", "About Only Ada"])
    expect(list.every((s) => s.instructions === "")).toBe(true)
    expect(JSON.stringify(result)).not.toContain("SECRET STEPS")
    // The window of the server still gets the whole skill.
    const whole = await runRequest(t.runtime, "skills.forAgent", { agentId: ada.id })
    expect(JSON.stringify(whole)).toContain("SECRET STEPS")
    await t.runtime.dispose()
  })

  test("a request with a field that is not an id of an agent is refused", async () => {
    const t = await setup()
    const result = await runRequest(t.runtime, "skills.forAgent", { agentId: 7 }, device)
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    await t.runtime.dispose()
  })

  test("a client cannot change a skill, and nothing changes", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const made = await t.skill("Only Ada", [ada.id])
    const asks: [string, unknown][] = [
      ["skills.list", { serverId: t.server.id }],
      [
        "skills.create",
        { serverId: t.server.id, name: "N", description: "", instructions: "i", agentIds: null },
      ],
      [
        "skills.update",
        { id: made.id, name: "N", description: "", instructions: "i", agentIds: null },
      ],
      ["skills.duplicate", { id: made.id, suffix: " copy" }],
      ["skills.setEnabled", { id: made.id, enabled: false }],
      ["skills.delete", { id: made.id }],
    ]
    for (const [method, input] of asks) {
      expect(await runRequest(t.runtime, method, input, device)).toEqual({
        ok: false,
        error: { code: "not_allowed", message: "Not allowed" },
      })
    }
    const after = await t.run(Skills.use((s) => s.list(t.server.id)))
    expect(after).toEqual([made])
    await t.runtime.dispose()
  })
})
