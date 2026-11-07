import { describe, expect, test } from "bun:test"
import type { Workflow } from "@robot/shared"
import { CLIENT_METHODS } from "@robot/shared"
import { Effect } from "effect"
import { handlers, runRequest } from "./rpc.ts"
import { Database } from "./services/Database.ts"
import { Servers } from "./services/Servers.ts"
import { testRuntime } from "./services/testing.ts"

/** A server with two linked devices: one that may change workflows, and one that may not. */
const setup = async () => {
  const t = testRuntime()
  const server = await t.runtime.runPromise(Servers.use((s) => s.local))
  await t.runtime.runPromise(
    Database.use((db) =>
      Effect.sync(() => {
        for (const [id, canChange, position] of [
          ["may", 1, 0],
          ["may-not", 0, 1],
        ] as const)
          db.run(
            "INSERT INTO device_link (id, name, kind, public_key, inbound, position, created_at, can_change) VALUES (?, ?, 'phone', '', 1, ?, 0, ?)",
            id,
            id,
            position,
            canChange,
          )
      }),
    ),
  )
  const ask = (method: string, input: unknown, device?: string) =>
    runRequest(t.runtime, method, input, device ? { id: device, name: device } : null)
  return { ...t, server, ask }
}

describe("a linked device and the switch for workflows (spec 010, 012)", () => {
  test("a device without the switch cannot create a workflow, and nothing is made", async () => {
    const t = await setup()
    const result = await t.ask(
      "workflows.create",
      { serverId: t.server.id, name: "Report" },
      "may-not",
    )
    expect(result).toMatchObject({ ok: false, error: { code: "change_off" } })
    const list = await t.ask("workflows.list", { serverId: t.server.id }, "may-not")
    expect(list).toEqual({ ok: true, value: [] })
  })

  test("a device with the switch creates and deletes a workflow", async () => {
    const t = await setup()
    const created = await t.ask(
      "workflows.create",
      { serverId: t.server.id, name: "Report" },
      "may",
    )
    expect(created.ok).toBe(true)
    const id = (created as { value: Workflow }).value.id
    expect(await t.ask("workflows.delete", { id }, "may")).toMatchObject({ ok: true })
    expect(await t.ask("workflows.list", { serverId: t.server.id }, "may")).toEqual({
      ok: true,
      value: [],
    })
  })

  test("a device without the switch cannot delete a workflow, and it stays", async () => {
    const t = await setup()
    const created = await t.ask("workflows.create", { serverId: t.server.id, name: "Report" })
    const id = (created as { value: Workflow }).value.id
    expect(await t.ask("workflows.delete", { id }, "may-not")).toMatchObject({
      ok: false,
      error: { code: "change_off" },
    })
    const list = await t.ask("workflows.list", { serverId: t.server.id }, "may-not")
    expect((list as { value: Workflow[] }).value).toHaveLength(1)
  })

  test("a device that is not linked is refused, and the window needs no switch", async () => {
    const t = await setup()
    const unknown = await t.ask("workflows.create", { serverId: t.server.id, name: "A" }, "ghost")
    expect(unknown).toMatchObject({ ok: false, error: { code: "change_off" } })
    const window = await t.ask("workflows.create", { serverId: t.server.id, name: "B" })
    expect(window.ok).toBe(true)
  })

  test("a method that the link does not list is refused for a device", async () => {
    const t = await setup()
    const result = await t.ask("workflows.rename", { id: "x", name: "Y" }, "may")
    expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } })
  })
})

describe("the requests of a linked device (spec 012)", () => {
  test("every request on the list has a handler", () => {
    for (const method of CLIENT_METHODS) expect(Object.keys(handlers), method).toContain(method)
  })

  test("a request that is not on the list is refused with no change", async () => {
    const t = await setup()
    for (const method of ["workflows.update", "workflows.run", "tools.respond", "agents.list"])
      expect(await t.ask(method, {}, "may")).toMatchObject({
        ok: false,
        error: { code: "not_allowed" },
      })
    // The marks of a chat are cleared by the user on this computer only (spec 007, 012).
    expect(await t.ask("chat.clearMarks", { workflowId: "x" }, "may")).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    })
  })

  test("a device without the switch can run, see and stop a run, and answer cards", async () => {
    const t = await setup()
    const created = await t.ask("workflows.create", { serverId: t.server.id, name: "Report" })
    const id = (created as { value: Workflow }).value.id
    // A workflow with no node does not start: the answer is the error of the run, not "change_off".
    expect(await t.ask("runs.start", { workflowId: id }, "may-not")).toMatchObject({
      ok: false,
      error: { code: "run_empty" },
    })
    expect(await t.ask("runs.list", { workflowId: id }, "may-not")).toEqual({ ok: true, value: [] })
    expect(await t.ask("runs.stop", { runId: "none" }, "may-not")).toMatchObject({
      ok: false,
      error: { code: "run_not_found" },
    })
    expect(
      await t.ask(
        "cards.answer",
        { cardId: "none", answer: { kind: "approval", answer: "deny" } },
        "may-not",
      ),
    ).toMatchObject({ ok: false, error: { code: "card_gone" } })
  })
})
