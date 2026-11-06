import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openDatabase, SCHEMA_ID } from "./Database.ts"
import { migrations } from "./migrations.ts"

describe("Database", () => {
  test("a frozen database reads, takes no writes, and calls no write listener", () => {
    const db = openDatabase(":memory:")
    db.run("INSERT INTO setting (key, value) VALUES ('a', '1')")
    let writes = 0
    db.onWrite(() => writes++)
    db.freeze()
    db.run("INSERT INTO setting (key, value) VALUES ('b', '2')")
    db.run("UPDATE setting SET value = '9' WHERE key = 'a'")
    expect(db.all<{ key: string; value: string }>("SELECT key, value FROM setting")).toEqual([
      { key: "a", value: "1" },
    ])
    expect(writes).toBe(0)
    // A transaction still runs and ends; its writes do nothing.
    expect(
      db.transaction(() => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM setting")?.n),
    ).toBe(1)
  })

  test("a new database has the workflow schema, its id and the last version", () => {
    const db = openDatabase(":memory:")
    expect(db.get<{ application_id: number }>("PRAGMA application_id")?.application_id).toBe(
      SCHEMA_ID,
    )
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
      migrations.length,
    )
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name)
    for (const name of [
      "workflow",
      "workflow_node",
      "document_version",
      "chat_message",
      "memory",
      "run",
      "task",
    ])
      expect(tables).toContain(name)
    for (const name of ["agent", "routine", "org_chart", "mute"]) expect(tables).not.toContain(name)
  })
})

describe("the reset of a database from before the workflow model (owner decision 16)", () => {
  const legacy = (dir: string) => {
    const file = join(dir, "robot.db")
    const old = new DatabaseSync(file)
    old.exec(
      "CREATE TABLE agent (id TEXT PRIMARY KEY); INSERT INTO agent VALUES ('a'); PRAGMA user_version = 93;",
    )
    old.close()
    writeFileSync(`${file}-wal`, "")
    writeFileSync(`${file}-shm`, "")
    return file
  }

  test("the old file and its side files are dropped and a new schema is made", () => {
    const file = legacy(mkdtempSync(join(tmpdir(), "robot-legacy-")))
    const db = openDatabase(file)
    expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'agent'")).toBeUndefined()
    expect(db.get<{ application_id: number }>("PRAGMA application_id")?.application_id).toBe(
      SCHEMA_ID,
    )
  })

  test("a database of the new model keeps its data when the app starts again", () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-keep-"))
    const file = join(dir, "robot.db")
    const first = openDatabase(file)
    first.run("INSERT INTO setting (key, value) VALUES ('keep', 'me')")
    const second = openDatabase(file)
    expect(
      second.get<{ value: string }>("SELECT value FROM setting WHERE key = 'keep'")?.value,
    ).toBe("me")
  })

  test("an empty file is a new database, not an old one", () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-empty-"))
    const file = join(dir, "robot.db")
    writeFileSync(file, "")
    const db = openDatabase(file)
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
      migrations.length,
    )
  })
})
