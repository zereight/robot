import { describe, expect, test } from "bun:test"
import { MEMORY_HISTORY_ROWS, MEMORY_USER_MAX } from "@robot/shared"
import { Effect, Exit } from "effect"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

type Service = Memory["Service"]

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const flow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Report" })))
  const m = <A>(f: (x: Service) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Memory.use(f))
  const code = async <A>(f: (x: Service) => Effect.Effect<A, import("./errors.ts").AppError>) => {
    const exit = await t.runtime.runPromiseExit(Memory.use(f))
    if (Exit.isSuccess(exit)) return "ok"
    return exit.cause.reasons
      .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
      .join()
  }
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const rows = <T>(statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all<T>(statement, ...params))))
  const texts = async () => (await m((x) => x.state(flow.id))).items.map((i) => i.text)
  return { ...t, run, flow, m, code, sql, rows, texts }
}

describe("the memory page (spec 008)", () => {
  test("a new workflow has memory on and 'Ask me first'", async () => {
    const t = await setup()
    const s = await t.m((x) => x.state(t.flow.id))
    expect(s).toMatchObject({ enabled: true, mode: "ask", selfImprovement: true, proposals: 0 })
    expect(s.items).toEqual([])
  })

  test("add, edit and delete make items and history rows; the newest item comes first", async () => {
    const t = await setup()
    const a = await t.m((x) => x.add(t.flow.id, "  Reports in Korean  "))
    expect(a.text).toBe("Reports in Korean")
    expect(a.source).toBe("user")
    await t.m((x) => x.add(t.flow.id, "Short answers"))
    expect(await t.texts()).toEqual(["Short answers", "Reports in Korean"])
    await t.m((x) => x.update(a.id, "Reports in English"))
    await t.m((x) => x.remove(a.id))
    const history = await t.m((x) => x.history(t.flow.id))
    expect(history.map((h) => h.kind).sort()).toEqual(["added", "added", "deleted", "edited"])
    expect(history.every((h) => h.actor === "user")).toBe(true)
  })

  test("empty and too long texts are refused; a long text is fine up to 1000 characters", async () => {
    const t = await setup()
    expect(await t.code((x) => x.add(t.flow.id, "   "))).toBe("memory_text_empty")
    expect(await t.code((x) => x.add(t.flow.id, "a".repeat(MEMORY_USER_MAX + 1)))).toBe(
      "memory_text_long",
    )
    expect(await t.code((x) => x.add(t.flow.id, "a".repeat(MEMORY_USER_MAX)))).toBe("ok")
  })

  test("the search keeps the items that hold every word", async () => {
    const t = await setup()
    await t.m((x) => x.add(t.flow.id, "The boss likes short reports"))
    await t.m((x) => x.add(t.flow.id, "Send mail at nine"))
    const s = await t.m((x) => x.state(t.flow.id, "REPORTS short"))
    expect(s.items.map((i) => i.text)).toEqual(["The boss likes short reports"])
  })

  test("edit twice: undo of the first edit is off with a reason; undo the second, then the first; undo the last undo", async () => {
    const t = await setup()
    const item = await t.m((x) => x.add(t.flow.id, "v0"))
    await t.m((x) => x.update(item.id, "v1"))
    await t.m((x) => x.update(item.id, "v2"))
    const find = async (old: string) =>
      (await t.m((x) => x.history(t.flow.id))).find((h) => h.kind === "edited" && h.oldText === old)
    const first = await find("v0")
    const second = await find("v1")
    expect(first).toMatchObject({ canUndo: false, undoBlocked: "newer" })
    expect(second?.canUndo).toBe(true)
    expect(await t.code((x) => x.undo(first?.id ?? ""))).toBe("memory_undo_blocked")
    await t.m((x) => x.undo(second?.id ?? ""))
    expect(await t.texts()).toEqual(["v1"])
    await t.m((x) => x.undo((first as { id: string }).id))
    expect(await t.texts()).toEqual(["v0"])
    // The last undo (of the first edit) can be undone: the item has the text of the first edit again.
    const undoOfFirst = (await t.m((x) => x.history(t.flow.id))).find((h) => h.undoOf === first?.id)
    expect(undoOfFirst?.canUndo).toBe(true)
    await t.m((x) => x.undo(undoOfFirst?.id ?? ""))
    expect(await t.texts()).toEqual(["v1"])
  })

  test("delete an item and press Undo on its row: the item is back with its text", async () => {
    const t = await setup()
    const item = await t.m((x) => x.add(t.flow.id, "Keep this"))
    await t.m((x) => x.remove(item.id))
    expect(await t.texts()).toEqual([])
    const row = (await t.m((x) => x.history(t.flow.id))).find((h) => h.kind === "deleted")
    await t.m((x) => x.undo(row?.id ?? ""))
    expect(await t.texts()).toEqual(["Keep this"])
  })

  test("undo of an add removes the item; the undo of the add is then off for the added row", async () => {
    const t = await setup()
    await t.m((x) => x.add(t.flow.id, "Temp"))
    const added = (await t.m((x) => x.history(t.flow.id))).find((h) => h.kind === "added")
    await t.m((x) => x.undo(added?.id ?? ""))
    expect(await t.texts()).toEqual([])
    const again = (await t.m((x) => x.history(t.flow.id))).find((h) => h.id === added?.id)
    expect(again).toMatchObject({ canUndo: false, undoBlocked: "undone" })
  })

  test("a text that looks like a secret is typed by hand, but its history shows no text and has no Undo", async () => {
    const t = await setup()
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"
    await t.m((x) => x.add(t.flow.id, key))
    expect(await t.texts()).toEqual([key])
    const [row] = await t.m((x) => x.history(t.flow.id))
    expect(row).toMatchObject({ redacted: true, oldText: null, newText: null, canUndo: false })
    const stored = await t.rows<{ old_text: string | null; new_text: string | null }>(
      "SELECT old_text, new_text FROM memory_history",
    )
    expect(JSON.stringify(stored)).not.toContain("sk-ant")
  })

  test("a change made in the database leaves an old row as it was, and its undo is off", async () => {
    const t = await setup()
    const item = await t.m((x) => x.add(t.flow.id, "Original"))
    await t.sql("UPDATE memory SET text = 'Changed by sync' WHERE id = ?", item.id)
    const [row] = await t.m((x) => x.history(t.flow.id))
    expect(row).toMatchObject({ canUndo: false, undoBlocked: "newer" })
  })

  test("the history keeps at most 1000 rows and 90 days, the oldest go first", async () => {
    const t = await setup()
    const item = await t.m((x) => x.add(t.flow.id, "x"))
    const old = Date.now() - 91 * 86_400_000
    await t.sql("UPDATE memory_history SET at = ?", old)
    await t.m((x) => x.update(item.id, "y"))
    expect(await t.m((x) => x.history(t.flow.id))).toHaveLength(1)
    for (let i = 0; i < MEMORY_HISTORY_ROWS + 5; i++)
      await t.sql(
        `INSERT INTO memory_history (id, workflow_id, memory_id, at, actor, kind, source, old_text, new_text, hidden)
         VALUES (?, ?, ?, ?, 'user', 'edited', 'user', 'a', 'b', 0)`,
        `fill-${i}`,
        t.flow.id,
        item.id,
        Date.now() - i,
      )
    await t.m((x) => x.update(item.id, "z"))
    const left = await t.rows<{ n: number }>("SELECT COUNT(*) AS n FROM memory_history")
    expect(left[0]?.n).toBe(MEMORY_HISTORY_ROWS)
    // The items are not touched by a trimmed row.
    expect(await t.texts()).toEqual(["z"])
  })

  test("memory off keeps the items; the switch and the mode are saved", async () => {
    const t = await setup()
    await t.m((x) => x.add(t.flow.id, "Stays"))
    const off = await t.m((x) => x.setEnabled(t.flow.id, false))
    expect(off.enabled).toBe(false)
    expect(off.items).toHaveLength(1)
    const now = await t.m((x) => x.setMode(t.flow.id, "now"))
    expect(now.mode).toBe("now")
    expect(await t.run(Memory.use((x) => Effect.sync(() => x.settings(t.flow.id))))).toMatchObject({
      enabled: false,
      mode: "now",
    })
  })

  test("known ignores spaces at both ends and the case; deleting the workflow deletes memory and history", async () => {
    const t = await setup()
    await t.m((x) => x.add(t.flow.id, "Likes Tea"))
    const known = await t.run(
      Memory.use((x) => Effect.sync(() => x.known(t.flow.id, "  likes tea "))),
    )
    expect(known).toBe(true)
    await t.run(Workflows.use((w) => w.remove(t.flow.id)))
    expect(await t.rows("SELECT id FROM memory")).toEqual([])
    expect(await t.rows("SELECT id FROM memory_history")).toEqual([])
  })

  test("the read of the tool gives every item when fewer than 6 exist, and a search otherwise", async () => {
    const t = await setup()
    for (const text of ["alpha one", "beta two", "gamma three"])
      await t.m((x) => x.add(t.flow.id, text))
    const few = await t.m((x) => x.search(t.flow.id, "alpha"))
    expect(few.items).toHaveLength(3)
    for (const text of ["delta four", "epsilon five", "zeta six"])
      await t.m((x) => x.add(t.flow.id, text))
    const many = await t.m((x) => x.search(t.flow.id, "alpha"))
    expect(many.items.map((i) => i.text)).toEqual(["alpha one"])
    expect(many.total).toBe(6)
  })
})
