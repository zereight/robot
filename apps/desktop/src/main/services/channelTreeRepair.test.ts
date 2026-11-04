import { describe, expect, test } from "bun:test"
import { isNoteOnly, type MessagePart, messageText } from "@robot/shared"
import { repairChannelTree, storedParentChanges } from "./channelTreeRepair.ts"
import { type DatabaseService, openDatabase } from "./Database.ts"

// The repair of a broken channel tree (spec 030, "Repair"): the parent field of the chosen channel
// is cleared, and the channel gets one muted line with the reason. The rules of the choice are in
// the shared tree module; these tests check what the repair does to the data.

const store = () => {
  const db = openDatabase(":memory:")
  db.run(
    "INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0)",
  )
  return db
}
const channel = (db: DatabaseService, id: string, parent: string | null, createdAt = 1) =>
  db.run(
    `INSERT INTO channel (id, server_id, name, name_key, topic, parent_channel_id, created_at, updated_at)
     VALUES (?, 's', ?, ?, '', ?, ?, ?)`,
    id,
    id,
    id,
    parent,
    createdAt,
    createdAt,
  )
const parents = (db: DatabaseService) =>
  Object.fromEntries(
    db
      .all<{ id: string; parent_channel_id: string | null }>(
        "SELECT id, parent_channel_id FROM channel ORDER BY id",
      )
      .map((r) => [r.id, r.parent_channel_id]),
  )
const lines = (db: DatabaseService, channelId: string) =>
  db.all<{
    id: string
    author: string
    agent_id: string | null
    kind: string
    parts: string
    status: string
  }>("SELECT * FROM channel_message WHERE channel_id = ? ORDER BY created_at", channelId)

describe("the repair after a restore", () => {
  test("a channel on the fourth level loses its parent and gets one muted line", () => {
    const db = store()
    // Product > Docs > Site > Wiki: "Wiki" would be on the fourth level.
    channel(db, "product", null)
    channel(db, "docs", "product")
    channel(db, "site", "docs")
    channel(db, "wiki", "site")
    channel(db, "ops", null)
    const made = repairChannelTree(db, { mode: "restore" })
    expect(made.map((r) => [r.channelId, r.reason])).toEqual([["wiki", "levels"]])
    expect(parents(db)).toEqual({
      docs: "product",
      ops: null,
      product: null,
      site: "docs",
      wiki: null,
    })
    // One line, in the channel that lost its parent only.
    for (const id of ["product", "docs", "site", "ops"]) expect(lines(db, id)).toEqual([])
    const [line, ...rest] = lines(db, "wiki")
    expect(rest).toEqual([])
    expect(line?.id).toBe(made[0]?.messageId as string)
    expect(JSON.parse(line?.parts ?? "[]")).toEqual([
      { kind: "note", note: "tree_repaired", why: "levels" },
    ])
    expect([line?.author, line?.agent_id, line?.kind, line?.status]).toEqual([
      "agent",
      null,
      "text",
      "done",
    ])
  })

  test("the line is a muted line: no words for the model, and no text to search", () => {
    const db = store()
    channel(db, "a", null)
    channel(db, "b", "a")
    channel(db, "c", "b")
    channel(db, "d", "c")
    repairChannelTree(db, { mode: "restore" })
    const row = lines(db, "d")[0]
    const parts = JSON.parse(row?.parts ?? "[]") as MessagePart[]
    expect(isNoteOnly(parts)).toBe(true)
    // The channel turns of a model keep the messages that have text only.
    expect(messageText({ parts })).toBe("")
    expect(db.all("SELECT * FROM message_text WHERE place_id = 'd'")).toEqual([])
  })

  test("a tree that is right changes nothing, and a second run finds nothing", () => {
    const db = store()
    channel(db, "a", null)
    channel(db, "b", "a")
    channel(db, "c", "b")
    expect(repairChannelTree(db, { mode: "restore" })).toEqual([])
    expect(db.all("SELECT id FROM channel_message")).toEqual([])
    channel(db, "d", "c")
    expect(repairChannelTree(db, { mode: "restore" })).toHaveLength(1)
    expect(repairChannelTree(db, { mode: "restore" })).toEqual([])
    expect(db.all("SELECT id FROM channel_message")).toHaveLength(1)
  })

  test("a loop in an archive is broken, and the line names the loop", () => {
    const db = store()
    channel(db, "a", "b", 1)
    channel(db, "b", "a", 2)
    const made = repairChannelTree(db, { mode: "restore" })
    // No stamps (no sync): the channel that was made later gives its parent.
    expect(made.map((r) => [r.channelId, r.reason])).toEqual([["b", "loop"]])
    expect(parents(db)).toEqual({ a: "b", b: null })
    expect(JSON.parse(lines(db, "b")[0]?.parts ?? "[]")).toEqual([
      { kind: "note", note: "tree_repaired", why: "loop" },
    ])
  })

  test("the same channel can be repaired again later and gets a second line", () => {
    const db = store()
    for (const [id, parent] of [
      ["a", null],
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
    ] as const)
      channel(db, id, parent)
    repairChannelTree(db, { mode: "restore" })
    db.run("UPDATE channel SET parent_channel_id = 'c' WHERE id = 'd'")
    repairChannelTree(db, { mode: "restore" })
    expect(lines(db, "d")).toHaveLength(2)
  })
})

describe("the repair after a sync", () => {
  const stamps = (list: Record<string, number>) =>
    new Map(Object.entries(list).map(([id, l]) => [id, { l, c: 0, n: "dev-a" }]))

  test("the channel with the later parent change is cleared; both computers make the same line", () => {
    const one = store()
    const two = store()
    for (const db of [one, two]) {
      channel(db, "docs", "site", 1)
      channel(db, "site", "docs", 1)
    }
    // The same two changes, the same stamps: the two stores choose the same channel and make
    // the same muted line, so sync keeps one line.
    const changed = stamps({ docs: 5, site: 7 })
    const a = repairChannelTree(one, { mode: "sync", changed, now: () => 100 })
    const b = repairChannelTree(two, { mode: "sync", changed, now: () => 200 })
    expect(a.map((r) => [r.channelId, r.reason])).toEqual([["site", "loop"]])
    expect(b.map((r) => r.channelId)).toEqual(["site"])
    expect(a[0]?.messageId).toBeTruthy()
    expect(a[0]?.messageId).toBe(b[0]?.messageId as string)
    expect(parents(one)).toEqual(parents(two))
    expect(parents(one)).toEqual({ docs: "site", site: null })
    expect(lines(one, "site")).toHaveLength(1)
  })

  test("a line that arrived from the other computer first is not made again", () => {
    const db = store()
    channel(db, "docs", "site", 1)
    channel(db, "site", "docs", 1)
    const changed = stamps({ docs: 5, site: 7 })
    const first = repairChannelTree(db, { mode: "sync", changed })
    // The other computer repaired the same break later: its field and its line arrive again.
    db.run("UPDATE channel SET parent_channel_id = 'docs' WHERE id = 'site'")
    const second = repairChannelTree(db, { mode: "sync", changed })
    expect(second.map((r) => [r.channelId, r.messageId])).toEqual([["site", null]])
    expect(parents(db)).toEqual({ docs: "site", site: null })
    expect(lines(db, "site").map((l) => l.id)).toEqual([first[0]?.messageId as string])
  })

  test("a repair marks the channel and the line for sync, as any change does", () => {
    const db = store()
    channel(db, "docs", "site", 1)
    channel(db, "site", "docs", 1)
    db.run(
      "INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at) VALUES (1, 'p', 'P', 'a', 'merge', 'live', 1)",
    )
    db.run("DELETE FROM sync_dirty")
    const made = repairChannelTree(db, { mode: "sync", changed: stamps({ docs: 5, site: 7 }) })
    expect(
      db
        .all<{ kind: string; id: string }>("SELECT kind, id FROM sync_dirty ORDER BY kind, id")
        .map((r) => `${r.kind}:${r.id}`),
    ).toEqual(["channel:site", `cmessage:${made[0]?.messageId}`])
  })
})

describe("the repair after a restore uses the changes that the fields carry (spec 030, Repair)", () => {
  // A restore or an import has no parent change of its own, so it uses the stamps that sync keeps
  // for the parent fields. An import into a new app has none, and the tie rule decides.
  const stamp = (db: DatabaseService, id: string, l: number, n = "dev-a") =>
    db.run(
      "INSERT INTO sync_field (kind, id, field, l, c, n, h, aseq) VALUES ('channel', ?, 'parentChannel', ?, 0, ?, 'h', 0)",
      id,
      l,
      n,
    )

  test("the stored stamps choose the channel of the loop, not the time it was made", () => {
    const db = store()
    // "A" was made first, but its parent change is the later one.
    channel(db, "a", "b", 1)
    channel(db, "b", "a", 2)
    stamp(db, "a", 9)
    stamp(db, "b", 3)
    const made = repairChannelTree(db, { mode: "restore" })
    expect(made.map((r) => [r.channelId, r.reason])).toEqual([["a", "loop"]])
    expect(parents(db)).toEqual({ a: null, b: "a" })
  })

  test("given stamps win over the stored ones; none at all: the channel made later", () => {
    const db = store()
    channel(db, "a", "b", 1)
    channel(db, "b", "a", 2)
    stamp(db, "a", 9)
    stamp(db, "b", 3)
    const made = repairChannelTree(db, {
      mode: "restore",
      changed: new Map([["b", { l: 20, c: 0, n: "dev-b" }]]),
    })
    expect(made.map((r) => r.channelId)).toEqual(["b"])
    const none = store()
    channel(none, "a", "b", 1)
    channel(none, "b", "a", 2)
    expect(repairChannelTree(none, { mode: "restore" }).map((r) => r.channelId)).toEqual(["b"])
  })

  test("the line of a restore has the id of the sync repair, so a sync keeps one line", () => {
    const one = store()
    const two = store()
    for (const db of [one, two]) {
      channel(db, "a", "b", 1)
      channel(db, "b", "a", 2)
      stamp(db, "a", 9)
      stamp(db, "b", 3)
    }
    const restore = repairChannelTree(one, { mode: "restore" })
    const sync = repairChannelTree(two, { mode: "sync", changed: storedParentChanges(two) })
    expect(restore[0]?.messageId).toBeTruthy()
    expect(restore[0]?.messageId).toBe(sync[0]?.messageId as string)
  })
})
