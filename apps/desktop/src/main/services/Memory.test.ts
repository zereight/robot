import { describe, expect, test } from "bun:test"
import {
  DAY_MS,
  MEMORY_HISTORY_DAYS,
  MEMORY_HISTORY_MAX,
  MEMORY_PROPOSAL_DAYS,
  MEMORY_PROPOSALS_MAX,
  MEMORY_TEXT_MAX,
  MEMORY_USER_TEXT_MAX,
  type MemorySave,
} from "@robot/shared"
import { Effect, Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

const setup = async () => {
  const t = testRuntime()
  const server = await t.runtime.runPromise(Servers.use((s) => s.local))
  const run = <A, E>(effect: Effect.Effect<A, E, Memory | Agents | Database | Secrets>) =>
    t.runtime.runPromise(effect)
  const exit = <A, E>(effect: Effect.Effect<A, E, Memory | Agents | Database | Secrets>) =>
    t.runtime.runPromiseExit(effect)
  const make = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: server.id, name, role: "Helps", instructions: "Be brief." }),
      ),
    )
  const agent = await make("Ada")
  const memory = <A, E>(f: (m: Memory["Service"]) => Effect.Effect<A, E>) => run(Memory.use(f))
  const save = (text: string, origin?: Parameters<Memory["Service"]["save"]>[2]) =>
    memory((m) => m.save(agent.id, text, origin))
  const setMode = (mode: "now" | "ask") => memory((m) => m.setMode(agent.id, mode))
  const items = () => memory((m) => m.list(agent.id))
  const history = () => memory((m) => m.history(agent.id))
  const proposals = () => memory((m) => m.proposals(agent.id))
  const sql = <A>(f: (db: Database["Service"]) => A) =>
    run(Database.use((db) => Effect.sync(() => f(db))))
  return { ...t, agent, make, run, exit, memory, save, setMode, items, history, proposals, sql }
}

const code = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

const kind = (r: MemorySave) => r.kind

describe("the choice of an agent", () => {
  test("a new agent saves at once; the choice is kept for that agent only", async () => {
    const s = await setup()
    const other = await s.make("Bo")
    expect(await s.memory((m) => m.mode(s.agent.id))).toBe("now")
    await s.setMode("ask")
    expect(await s.memory((m) => m.mode(s.agent.id))).toBe("ask")
    expect(await s.memory((m) => m.mode(other.id))).toBe("now")
  })

  test("a mode that is not one of the two is refused", async () => {
    const s = await setup()
    const exit = await s.exit(Memory.use((m) => m.setMode(s.agent.id, "later" as "now")))
    expect(code(exit)).toBe("invalid_input")
    expect(await s.memory((m) => m.mode(s.agent.id))).toBe("now")
  })

  test("save at once makes an item and a history row by the agent", async () => {
    const s = await setup()
    const out = await s.save("Likes green tea")
    expect(out.kind).toBe("saved")
    expect((await s.items()).map((i) => [i.text, i.source])).toEqual([["Likes green tea", "agent"]])
    expect((await s.history()).map((r) => [r.actor, r.kind, r.after])).toEqual([
      ["agent", "added", "Likes green tea"],
    ])
    expect(await s.proposals()).toEqual([])
  })

  test("ask me first makes a proposal and no item and no history row", async () => {
    const s = await setup()
    await s.setMode("ask")
    const out = await s.save("Likes green tea", { kind: "agent", id: s.agent.id, messageId: "m1" })
    expect(out.kind).toBe("suggested")
    expect(await s.items()).toEqual([])
    expect(await s.history()).toEqual([])
    const [p] = await s.proposals()
    expect(p).toMatchObject({ text: "Likes green tea", place: { kind: "agent", name: "Ada" } })
    // A proposal is not memory: the agent does not read it.
    expect(await s.memory((m) => Effect.succeed(m.forTurn(s.agent.id, "tea")))).toEqual([])
  })

  test("a change of the choice leaves the proposals as they are", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("Likes tea")
    await s.setMode("now")
    expect((await s.proposals()).map((p) => p.text)).toEqual(["Likes tea"])
    await s.setMode("ask")
    expect((await s.proposals()).length).toBe(1)
  })
})

describe("proposals", () => {
  test("Save makes an item from a proposal, with a history row of a proposal that was accepted", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("Likes tea")
    const [p] = await s.proposals()
    const item = await s.memory((m) => m.accept(p?.id ?? ""))
    expect(item).toMatchObject({ text: "Likes tea", source: "proposal" })
    expect(await s.proposals()).toEqual([])
    expect((await s.history()).map((r) => [r.actor, r.kind, r.after])).toEqual([
      ["proposal", "added", "Likes tea"],
    ])
    // The next turn uses the item.
    expect(
      (await s.memory((m) => Effect.succeed(m.forTurn(s.agent.id, "tea")))).map((i) => i.text),
    ).toEqual(["Likes tea"])
  })

  test("Edit and save makes the item with the new text", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("Likes tea")
    const [p] = await s.proposals()
    const item = await s.memory((m) => m.accept(p?.id ?? "", "  Likes black tea  "))
    expect(item.text).toBe("Likes black tea")
    expect((await s.history())[0]).toMatchObject({ actor: "proposal", after: "Likes black tea" })
  })

  test("Dismiss removes the proposal and makes no item and no history row", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("Likes tea")
    const [p] = await s.proposals()
    await s.memory((m) => m.dismiss(p?.id ?? ""))
    expect(await s.proposals()).toEqual([])
    expect(await s.items()).toEqual([])
    expect(await s.history()).toEqual([])
    // A second answer finds nothing.
    expect(code(await s.exit(Memory.use((m) => m.accept(p?.id ?? ""))))).toBe(
      "memory_proposal_not_found",
    )
  })

  test("21 proposals leave 20, and the oldest one is gone", async () => {
    const s = await setup()
    await s.setMode("ask")
    for (let i = 1; i <= MEMORY_PROPOSALS_MAX + 1; i++) await s.save(`Fact number ${i}`)
    const list = await s.proposals()
    expect(list.length).toBe(MEMORY_PROPOSALS_MAX)
    expect(list.map((p) => p.text)).not.toContain("Fact number 1")
    expect(list[0]?.text).toBe("Fact number 2")
    // Oldest first.
    expect(list.at(-1)?.text).toBe(`Fact number ${MEMORY_PROPOSALS_MAX + 1}`)
  })

  test("a proposal that nobody answers ends after 30 days", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("Old fact")
    await s.save("New fact")
    const old = Date.now() - MEMORY_PROPOSAL_DAYS * DAY_MS - 1000
    await s.sql((db) =>
      db.run("UPDATE memory_proposal SET created_at = ? WHERE text = ?", old, "Old fact"),
    )
    expect((await s.proposals()).map((p) => p.text)).toEqual(["New fact"])
    // One day short of the end: it still waits.
    const nearly = Date.now() - (MEMORY_PROPOSAL_DAYS - 1) * DAY_MS
    await s.sql((db) => db.run("UPDATE memory_proposal SET created_at = ?", nearly))
    expect((await s.proposals()).length).toBe(1)
  })

  test("a proposal that ended cannot be saved", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("Old fact")
    const [p] = await s.proposals()
    await s.sql((db) =>
      db.run(
        "UPDATE memory_proposal SET created_at = ?",
        Date.now() - MEMORY_PROPOSAL_DAYS * DAY_MS - 1000,
      ),
    )
    expect(code(await s.exit(Memory.use((m) => m.accept(p?.id ?? ""))))).toBe(
      "memory_proposal_not_found",
    )
    expect(await s.items()).toEqual([])
  })

  test("a proposal names the channel where it was made, and its name when the channel is gone", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.sql((db) =>
      db.run(
        "INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at) SELECT 'c1', id, 'Plans', 'plans', '', 1, 1 FROM server LIMIT 1",
      ),
    )
    await s.save("Plan fact", { kind: "channel", id: "c1", messageId: "m" })
    expect((await s.proposals())[0]?.place).toEqual({ kind: "channel", id: "c1", name: "Plans" })
    await s.sql((db) => db.run("DELETE FROM channel WHERE id = 'c1'"))
    expect((await s.proposals())[0]?.place).toEqual({ kind: "channel", id: "c1", name: null })
  })
})

describe("what the memory tool refuses", () => {
  test("a text over 500 characters, for an item and for a proposal", async () => {
    const s = await setup()
    const long = "x".repeat(MEMORY_TEXT_MAX + 1)
    expect(kind(await s.save(long))).toBe("too_long")
    await s.setMode("ask")
    expect(kind(await s.save(long))).toBe("too_long")
    expect(kind(await s.save("y".repeat(MEMORY_TEXT_MAX)))).toBe("suggested")
    expect(await s.items()).toEqual([])
  })

  test("an empty text", async () => {
    const s = await setup()
    expect(kind(await s.save("   "))).toBe("empty")
  })

  test("a text that looks like a key makes no item and no proposal", async () => {
    const s = await setup()
    for (const secret of [
      "My key is sk-abcdefghijklmnop1234",
      `token ${"ghp_"}${"a".repeat(30)}`,
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    ]) {
      expect(kind(await s.save(secret))).toBe("secret")
    }
    await s.setMode("ask")
    expect(kind(await s.save("again sk-abcdefghijklmnop1234"))).toBe("secret")
    expect(await s.items()).toEqual([])
    expect(await s.proposals()).toEqual([])
    expect(await s.history()).toEqual([])
  })

  test("a text that equals a stored key looks like a secret", async () => {
    const s = await setup()
    await s.sql((db) =>
      db.run(
        "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('acc', 'openai', 'A', '', 1)",
      ),
    )
    await s.run(Secrets.use((x) => Effect.sync(() => x.set(secretKey("acc"), "hunter2-hunter2"))))
    expect(kind(await s.save("the password is hunter2-hunter2"))).toBe("secret")
    expect(await s.items()).toEqual([])
  })

  test("the user can type such a text by hand, and a text longer than the tool takes", async () => {
    const s = await setup()
    const secret = "my key sk-abcdefghijklmnop1234"
    const item = await s.memory((m) => m.add(s.agent.id, secret, "user"))
    expect(item.text).toBe(secret)
    const long = "z".repeat(MEMORY_TEXT_MAX + 100)
    expect((await s.memory((m) => m.add(s.agent.id, long, "user"))).text).toBe(long)
    expect(
      code(
        await s.exit(
          Memory.use((m) => m.add(s.agent.id, "q".repeat(MEMORY_USER_TEXT_MAX + 1), "user")),
        ),
      ),
    ).toBe("invalid_input")
  })

  test("a fact that is known: spaces at both ends and the case of letters do not matter", async () => {
    const s = await setup()
    expect(kind(await s.save("Likes green tea"))).toBe("saved")
    expect(kind(await s.save("  likes GREEN tea  "))).toBe("known")
    expect((await s.items()).length).toBe(1)
    expect((await s.history()).length).toBe(1)
    // Ask first: a fact of the memory is known, and so is another proposal.
    await s.setMode("ask")
    expect(kind(await s.save("LIKES green tea"))).toBe("known")
    expect(kind(await s.save("Lives in Busan"))).toBe("suggested")
    expect(kind(await s.save(" lives in busan "))).toBe("known")
    expect((await s.proposals()).length).toBe(1)
  })

  test("memory off: the tool saves and suggests nothing", async () => {
    const s = await setup()
    await s.run(Agents.use((a) => a.update(s.agent.id, { memoryEnabled: false })))
    expect(kind(await s.save("Likes tea"))).toBe("off")
    await s.setMode("ask")
    expect(kind(await s.save("Likes tea"))).toBe("off")
    expect(await s.items()).toEqual([])
    expect(await s.proposals()).toEqual([])
  })

  test("memory off: the user can still change items", async () => {
    const s = await setup()
    await s.run(Agents.use((a) => a.update(s.agent.id, { memoryEnabled: false })))
    const item = await s.memory((m) => m.add(s.agent.id, "Typed by hand", "user"))
    await s.memory((m) => m.update(item.id, "Typed again"))
    expect((await s.items()).map((i) => i.text)).toEqual(["Typed again"])
    // The items stay but are not used.
    expect(await s.memory((m) => Effect.succeed(m.forTurn(s.agent.id, "typed")))).toEqual([])
  })
})

describe("history", () => {
  test("every change by the user makes a row: added, edited, deleted", async () => {
    const s = await setup()
    const item = await s.memory((m) => m.add(s.agent.id, "One", "user"))
    await s.memory((m) => m.update(item.id, "Two"))
    await s.memory((m) => m.remove(item.id))
    expect((await s.history()).map((r) => [r.actor, r.kind, r.before, r.after])).toEqual([
      ["user", "deleted", "Two", null],
      ["user", "edited", "One", "Two"],
      ["user", "added", null, "One"],
    ])
  })

  test("an edit to the same text makes no row", async () => {
    const s = await setup()
    const item = await s.memory((m) => m.add(s.agent.id, "One", "user"))
    await s.memory((m) => m.update(item.id, " One "))
    expect((await s.history()).length).toBe(1)
  })

  test("history keeps 90 days", async () => {
    const s = await setup()
    await s.memory((m) => m.add(s.agent.id, "Recent", "user"))
    await s.memory((m) => m.add(s.agent.id, "Old", "user"))
    const old = Date.now() - MEMORY_HISTORY_DAYS * DAY_MS - 1000
    await s.sql((db) => db.run("UPDATE memory_history SET at = ? WHERE new_text = 'Old'", old))
    expect((await s.history()).map((r) => r.after)).toEqual(["Recent"])
    // The item is not changed by removing its row.
    expect((await s.items()).length).toBe(2)
  })

  test("history keeps 1000 rows for each agent, and the oldest go first", async () => {
    const s = await setup()
    const other = await s.make("Bo")
    const item = await s.memory((m) => m.add(s.agent.id, "v0", "user"))
    await s.memory((m) => m.add(other.id, "kept", "user"))
    await s.sql((db) => {
      db.run(
        "UPDATE memory_history SET at = ? WHERE agent_id = ?",
        Date.now() - 200_000,
        s.agent.id,
      )
      // 1005 more rows, made by hand so that the test is quick.
      db.transaction(() => {
        for (let i = 1; i <= MEMORY_HISTORY_MAX + 5; i++)
          db.run(
            "INSERT INTO memory_history (id, agent_id, memory_id, at, actor, kind, source, old_text, new_text) VALUES (?, ?, ?, ?, 'user', 'edited', 'user', ?, ?)",
            `h${i}`,
            s.agent.id,
            item.id,
            Date.now() - 100_000 + i,
            `v${i - 1}`,
            `v${i}`,
          )
      })
    })
    // The next change prunes.
    await s.memory((m) => m.update(item.id, "final"))
    const rows = await s.history()
    expect(rows.length).toBe(MEMORY_HISTORY_MAX)
    expect(rows[0]?.after).toBe("final")
    // The first row of the agent ("added v0") is gone with the oldest ones.
    expect(rows.some((r) => r.kind === "added")).toBe(false)
    // The other agent keeps its row.
    expect((await s.memory((m) => m.history(other.id))).length).toBe(1)
  })

  test("deleting an agent deletes its memory, proposals and history", async () => {
    const s = await setup()
    await s.save("Likes tea")
    await s.setMode("ask")
    await s.save("Lives in Busan")
    await s.run(Agents.use((a) => a.archive(s.agent.id)))
    await s.run(Agents.use((a) => a.remove(s.agent.id)))
    const counts = await s.sql((db) => ({
      items: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory")?.n,
      proposals: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_proposal")?.n,
      history: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_history")?.n,
    }))
    expect(counts).toEqual({ items: 0, proposals: 0, history: 0 })
  })

  test("archiving an agent keeps its memory, proposals and history", async () => {
    const s = await setup()
    await s.save("Likes tea")
    await s.setMode("ask")
    await s.save("Lives in Busan")
    await s.run(Agents.use((a) => a.archive(s.agent.id)))
    expect((await s.items()).length).toBe(1)
    expect((await s.proposals()).length).toBe(1)
    expect((await s.history()).length).toBe(1)
  })

  test("a row whose text looks like a secret shows [redacted] and has no Undo", async () => {
    const s = await setup()
    const item = await s.memory((m) => m.add(s.agent.id, "my key sk-abcdefghijklmnop1234", "user"))
    await s.memory((m) => m.update(item.id, "Plain text again"))
    const [edit, add] = await s.history()
    // The edit holds the secret as its text before, the add holds it as its text after.
    expect(edit).toMatchObject({ kind: "edited", before: "[redacted]", after: "[redacted]" })
    expect(edit?.undo).toEqual({ on: false, why: "secret" })
    expect(add).toMatchObject({ kind: "added", after: "[redacted]" })
    expect(add?.undo.on).toBe(false)
    expect(JSON.stringify(await s.history())).not.toContain("sk-abcdefghijklmnop1234")
    expect(code(await s.exit(Memory.use((m) => m.undo(edit?.id ?? ""))))).toBe("memory_undo_off")
  })
})

describe("undo", () => {
  test("undo of added removes the item; undo of that undo puts it back", async () => {
    const s = await setup()
    const out = await s.save("Likes tea")
    if (out.kind !== "saved") throw new Error("not saved")
    await s.memory((m) => m.undo(out.historyId))
    expect(await s.items()).toEqual([])
    const [undoRow] = await s.history()
    expect(undoRow).toMatchObject({ actor: "undo", kind: "deleted" })
    await s.memory((m) => m.undo(undoRow?.id ?? ""))
    expect((await s.items()).map((i) => [i.text, i.source])).toEqual([["Likes tea", "agent"]])
  })

  test("two edits: undo of the first is off with its reason; undo the second, then the first, then the last undo", async () => {
    const s = await setup()
    const item = await s.memory((m) => m.add(s.agent.id, "T0", "user"))
    await s.memory((m) => m.update(item.id, "T1"))
    await s.memory((m) => m.update(item.id, "T2"))
    const text = async () => (await s.items())[0]?.text
    const rows = () => s.history()
    const [second, first] = await rows()
    expect(first?.undo).toEqual({ on: false, why: "newer" })
    expect(second?.undo).toEqual({ on: true })
    expect(code(await s.exit(Memory.use((m) => m.undo(first?.id ?? ""))))).toBe("memory_undo_off")
    expect(await text()).toBe("T2")

    await s.memory((m) => m.undo(second?.id ?? ""))
    expect(await text()).toBe("T1")
    // Now the first edit is exactly as the item is.
    const firstNow = (await rows()).find((r) => r.id === first?.id)
    expect(firstNow?.undo).toEqual({ on: true })
    await s.memory((m) => m.undo(first?.id ?? ""))
    expect(await text()).toBe("T0")

    // Undo the last undo: the item has the text of the first edit again.
    const [lastUndo] = await rows()
    expect(lastUndo).toMatchObject({ actor: "undo", before: "T1", after: "T0" })
    await s.memory((m) => m.undo(lastUndo?.id ?? ""))
    expect(await text()).toBe("T1")
    // Every undo is a row.
    expect((await rows()).length).toBe(3 + 3)
  })

  test("an undo is on only while the item is exactly as the change made it", async () => {
    const s = await setup()
    const item = await s.memory((m) => m.add(s.agent.id, "Alpha", "user"))
    const [added] = await s.history()
    expect(added?.undo).toEqual({ on: true })
    // A change that makes no history row (a sync change) turns the undo off.
    await s.sql((db) => db.run("UPDATE memory SET text = 'Beta' WHERE id = ?", item.id))
    expect((await s.history())[0]?.undo).toEqual({ on: false, why: "newer" })
    // The same text again turns it on: the item is as the change made it.
    await s.sql((db) => db.run("UPDATE memory SET text = 'Alpha' WHERE id = ?", item.id))
    expect((await s.history())[0]?.undo).toEqual({ on: true })
    // A missing item turns it off.
    await s.sql((db) => db.run("DELETE FROM memory WHERE id = ?", item.id))
    expect((await s.history())[0]?.undo).toEqual({ on: false, why: "newer" })
  })

  test("delete an item, then undo its row: the item is back with its text", async () => {
    const s = await setup()
    const item = await s.memory((m) => m.add(s.agent.id, "Keep this", "user"))
    await s.memory((m) => m.remove(item.id))
    const [deleted] = await s.history()
    expect(deleted).toMatchObject({ kind: "deleted", before: "Keep this" })
    expect(deleted?.undo).toEqual({ on: true })
    await s.memory((m) => m.undo(deleted?.id ?? ""))
    expect((await s.items()).map((i) => i.text)).toEqual(["Keep this"])
    // The deleted row cannot be undone twice.
    expect((await s.history()).find((r) => r.id === deleted?.id)?.undo).toEqual({
      on: false,
      why: "newer",
    })
    expect(code(await s.exit(Memory.use((m) => m.undo(deleted?.id ?? ""))))).toBe("memory_undo_off")
  })

  test("undo of a deletion that was itself undone deletes the item again, and the first row works again", async () => {
    const s = await setup()
    const item = await s.memory((m) => m.add(s.agent.id, "Again", "user"))
    await s.memory((m) => m.remove(item.id))
    const [deleted] = await s.history()
    await s.memory((m) => m.undo(deleted?.id ?? ""))
    const [revived] = await s.history()
    expect(revived).toMatchObject({ actor: "undo", kind: "added" })
    await s.memory((m) => m.undo(revived?.id ?? ""))
    expect(await s.items()).toEqual([])
    // The item is missing as the first deletion left it.
    expect((await s.history()).find((r) => r.id === deleted?.id)?.undo).toEqual({ on: true })
  })

  test("undo of an item that came from a proposal puts back the same source", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("From a proposal")
    const [p] = await s.proposals()
    const item = await s.memory((m) => m.accept(p?.id ?? ""))
    await s.memory((m) => m.remove(item.id))
    const deleted = await s.sql(
      (db) => db.get<{ id: string }>("SELECT id FROM memory_history WHERE kind = 'deleted'")?.id,
    )
    await s.memory((m) => m.undo(deleted ?? ""))
    expect((await s.items()).map((i) => i.source)).toEqual(["proposal"])
  })

  test("a change that is not in the history gives a plain error", async () => {
    const s = await setup()
    expect(code(await s.exit(Memory.use((m) => m.undo("nope"))))).toBe("memory_history_not_found")
    expect(await s.memory((m) => m.historyRow("nope"))).toBeUndefined()
  })

  test("a change by a sync (no history row) is not recorded", async () => {
    const s = await setup()
    // What sync writes goes straight to the table, as the sync kinds do.
    await s.sql((db) =>
      db.run(
        "INSERT INTO memory (id, agent_id, text, source, created_at, updated_at) VALUES ('m1', ?, 'From the other computer', 'user', 1, 1)",
        s.agent.id,
      ),
    )
    expect((await s.items()).length).toBe(1)
    expect(await s.history()).toEqual([])
  })
})

describe("the tool of a memory check (spec 008)", () => {
  const suggest = (s: Awaited<ReturnType<typeof setup>>, text: string) =>
    s.memory((m) => m.suggest(s.agent.id, text))

  test("it makes a proposal also with 'Save at once', marked as made by a check, with no chat", async () => {
    const s = await setup()
    expect(await s.memory((m) => m.mode(s.agent.id))).toBe("now")
    const out = await suggest(s, "Prefers short answers")
    expect(out.kind).toBe("suggested")
    expect(await s.items()).toEqual([])
    expect(await s.history()).toEqual([])
    const [p] = await s.proposals()
    expect(p).toMatchObject({ text: "Prefers short answers", fromCheck: true, place: null })
  })

  test("a proposal that the memory tool made in a chat is not marked as made by a check", async () => {
    const s = await setup()
    await s.setMode("ask")
    await s.save("From a chat", { kind: "agent", id: s.agent.id, messageId: "m1" })
    expect((await s.proposals()).map((p) => p.fromCheck)).toEqual([false])
  })

  test("a known fact, a text over 500 characters, a secret and an empty text make no proposal", async () => {
    const s = await setup()
    await s.memory((m) => m.add(s.agent.id, "Likes tea", "user"))
    expect(kind(await suggest(s, "  likes TEA "))).toBe("known")
    expect(kind(await suggest(s, "x".repeat(MEMORY_TEXT_MAX + 1)))).toBe("too_long")
    expect(kind(await suggest(s, "key sk-live-1234567890abcdef1234567890abcdef"))).toBe("secret")
    expect(kind(await suggest(s, "   "))).toBe("empty")
    expect(await s.proposals()).toEqual([])
    // The same fact twice: the second call adds nothing.
    expect(kind(await suggest(s, "Lives in Busan"))).toBe("suggested")
    expect(kind(await suggest(s, "lives in busan"))).toBe("known")
    expect(await s.proposals()).toHaveLength(1)
  })

  test("at most 20 proposals wait: a new one replaces the oldest", async () => {
    const s = await setup()
    for (let i = 1; i <= MEMORY_PROPOSALS_MAX + 1; i++) await suggest(s, `Fact ${i}`)
    const waiting = await s.proposals()
    expect(waiting).toHaveLength(MEMORY_PROPOSALS_MAX)
    expect(waiting[0]?.text).toBe("Fact 2")
  })

  test("it makes nothing with memory off", async () => {
    const s = await setup()
    await s.run(Agents.use((a) => a.update(s.agent.id, { memoryEnabled: false })))
    expect(kind(await suggest(s, "Likes tea"))).toBe("off")
  })

  test("the user can save such a proposal like any other", async () => {
    const s = await setup()
    await suggest(s, "Lives in Busan")
    const [p] = await s.proposals()
    await s.memory((m) => m.accept(p?.id ?? ""))
    expect((await s.items()).map((i) => [i.text, i.source])).toEqual([
      ["Lives in Busan", "proposal"],
    ])
    expect(await s.proposals()).toEqual([])
  })
})
