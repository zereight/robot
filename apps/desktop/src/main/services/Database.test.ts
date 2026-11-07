import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileState, NewerDatabaseError, openDatabase, SCHEMA_ID } from "./Database.ts"
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

describe("the reset of a database from before the workflow model (owner decision, 2026-11-07)", () => {
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

  test("a missing file is new: a database is made and the state is fresh", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-missing-")), "robot.db")
    expect(fileState(file)).toBe("fresh")
    const db = openDatabase(file)
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
      migrations.length,
    )
    expect(fileState(file)).toBe("current")
  })

  test("an old database loses everything: settings, accounts and linked devices too", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-wipe-")), "robot.db")
    const old = new DatabaseSync(file)
    old.exec(
      "CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT); INSERT INTO setting VALUES ('theme', 'dark'); CREATE TABLE device_link (id TEXT); INSERT INTO device_link VALUES ('phone'); PRAGMA user_version = 12;",
    )
    old.close()
    expect(fileState(file)).toBe("legacy")
    const db = openDatabase(file)
    expect(db.all("SELECT * FROM setting")).toEqual([])
    expect(db.all("SELECT * FROM device_link")).toEqual([])
  })

  test("a database of another program with no version is not erased as an old one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-foreign-")), "robot.db")
    const other = new DatabaseSync(file)
    other.exec("CREATE TABLE x (a TEXT); INSERT INTO x VALUES ('keep')")
    other.close()
    expect(fileState(file)).toBe("fresh")
  })

  test("a database that a newer app made is refused and the file stays as it was", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-newer-")), "robot.db")
    const later = new DatabaseSync(file)
    later.exec(
      `CREATE TABLE future (a TEXT); INSERT INTO future VALUES ('keep'); PRAGMA application_id = ${SCHEMA_ID}; PRAGMA user_version = ${migrations.length + 1};`,
    )
    later.close()
    const before = readFileSync(file)
    expect(fileState(file)).toBe("newer")
    expect(() => openDatabase(file)).toThrow(NewerDatabaseError)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file).equals(before)).toBe(true)
    const check = new DatabaseSync(file)
    expect(check.prepare("SELECT a FROM future").all()).toEqual([{ a: "keep" }])
    expect(
      (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(migrations.length + 1)
    check.close()
  })
  test("an upgrade from the version before the proposals keeps the data and adds the table of proposals", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-upgrade-")), "robot.db")
    const old = new DatabaseSync(file)
    old.exec("PRAGMA foreign_keys = ON")
    const before = migrations.slice(0, 9)
    for (const sql of before) old.exec(sql)
    old.exec(`PRAGMA application_id = ${SCHEMA_ID}; PRAGMA user_version = ${before.length};`)
    old.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s1', 'This computer', 'local', 0, 1);
      INSERT INTO workflow (id, server_id, name, name_key, document, folder, created_at, updated_at)
        VALUES ('w1', 's1', 'Report', 'report', 'Doc.', '/tmp/w1', 1, 1);
      INSERT INTO memory (id, workflow_id, text, source, created_at, updated_at)
        VALUES ('m1', 'w1', 'Likes tea', 'user', 1, 1);
      INSERT INTO memory_history (id, workflow_id, memory_id, at, actor, kind, source, old_text, new_text)
        VALUES ('h1', 'w1', 'm1', 1, 'user', 'added', 'user', NULL, 'Likes tea');
    `)
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'proposal'").all()).toEqual([])
    old.close()
    expect(fileState(file)).toBe("current")
    const db = openDatabase(file)
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
      migrations.length,
    )
    expect(db.all("SELECT text FROM memory")).toEqual([{ text: "Likes tea" }])
    expect(db.all("SELECT id FROM memory_history")).toEqual([{ id: "h1" }])
    expect(db.get<{ document: string }>("SELECT document FROM workflow")?.document).toBe("Doc.")
    // The new table takes a proposal, checks its kind and goes with the workflow.
    db.run(
      `INSERT INTO proposal (id, workflow_id, kind, reason, source_kind, state, created_at)
       VALUES ('p1', 'w1', 'document', 'why', 'chat', 'waiting', 1)`,
    )
    expect(() =>
      db.run(
        `INSERT INTO proposal (id, workflow_id, kind, reason, source_kind, state, created_at)
         VALUES ('p2', 'w1', 'skill', 'why', 'chat', 'waiting', 1)`,
      ),
    ).toThrow()
    db.run("DELETE FROM workflow WHERE id = 'w1'")
    expect(db.all("SELECT id FROM proposal")).toEqual([])
    expect(db.all("SELECT id FROM memory")).toEqual([])
  })

  test("a database built from the first 11 migrations opens at the current version, keeps its rows and gets the claims, the holder and the device", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-upgrade-11-")), "robot.db")
    const old = new DatabaseSync(file)
    old.exec("PRAGMA foreign_keys = ON")
    const before = migrations.slice(0, 11)
    expect(before).toHaveLength(11)
    for (const sql of before) old.exec(sql)
    old.exec(`PRAGMA application_id = ${SCHEMA_ID}; PRAGMA user_version = ${before.length};`)
    old.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s1', 'This computer', 'local', 0, 1);
      INSERT INTO workflow (id, server_id, name, name_key, document, folder, created_at, updated_at)
        VALUES ('w1', 's1', 'Report', 'report', 'Doc.', '/tmp/w1', 1, 1);
      INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', 'w1', 'done', 'hand', 1);
      INSERT INTO action_log (id, at, workflow_id, workflow_name, kind, target, decided_by, result)
        VALUES ('a1', 1, 'w1', 'Report', 'file', '/tmp/w1/a.md', 'level', 'Allowed');
    `)
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'file_claim'").all()).toEqual(
      [],
    )
    old.close()
    expect(fileState(file)).toBe("current")
    const db = openDatabase(file)
    // Later slices append migrations: the file opens at the last one.
    expect(migrations.length).toBeGreaterThanOrEqual(12)
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
      migrations.length,
    )
    // The rows stay.
    expect(db.get<{ document: string }>("SELECT document FROM workflow")?.document).toBe("Doc.")
    expect(db.all("SELECT id FROM run")).toEqual([{ id: "r1" }])
    expect(db.all("SELECT id, holder FROM action_log")).toEqual([{ id: "a1", holder: null }])
    // The columns of the 11th migration and of the 12th are there.
    expect(db.get<{ device: string | null }>("SELECT device FROM run")?.device).toBeNull()
    expect(db.all("SELECT device FROM workflow_version")).toEqual([])
    // The table of claims takes a claim and goes with the workflow.
    db.run(
      "INSERT INTO file_claim (task_id, workflow_id, path, path_key, at) VALUES ('t1', 'w1', '/tmp/w1/a.md', '/tmp/w1/a.md', 1)",
    )
    db.run("UPDATE action_log SET holder = 'Other' WHERE id = 'a1'")
    expect(db.all("SELECT holder FROM action_log")).toEqual([{ holder: "Other" }])
    db.run("DELETE FROM workflow WHERE id = 'w1'")
    expect(db.all("SELECT task_id FROM file_claim")).toEqual([])
  })

  test("a database with exactly the first 12 migrations opens at the current version and gets the table of unread marks", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-upgrade-12-")), "robot.db")
    const old = new DatabaseSync(file)
    old.exec("PRAGMA foreign_keys = ON")
    const before = migrations.slice(0, 12)
    expect(before).toHaveLength(12)
    for (const sql of before) old.exec(sql)
    old.exec(`PRAGMA application_id = ${SCHEMA_ID}; PRAGMA user_version = ${before.length};`)
    old.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s1', 'This computer', 'local', 0, 1);
      INSERT INTO workflow (id, server_id, name, name_key, document, folder, created_at, updated_at)
        VALUES ('w1', 's1', 'Report', 'report', 'Doc.', '/tmp/w1', 1, 1);
      INSERT INTO chat_message (id, workflow_id, author, parts, status, created_at)
        VALUES ('m1', 'w1', 'user', '[]', 'done', 1);
    `)
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_unread'").all()).toEqual(
      [],
    )
    old.close()
    expect(fileState(file)).toBe("current")
    const db = openDatabase(file)
    // Later slices append migrations: the file opens at the last one.
    expect(migrations.length).toBeGreaterThanOrEqual(13)
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(
      migrations.length,
    )
    // The rows stay, and the table takes a mark and goes with the workflow.
    expect(db.all("SELECT id FROM chat_message")).toEqual([{ id: "m1" }])
    db.run("INSERT INTO chat_unread (workflow_id, message_id, at) VALUES ('w1', 'm1', 1)")
    db.run("DELETE FROM workflow WHERE id = 'w1'")
    expect(db.all("SELECT workflow_id FROM chat_unread")).toEqual([])
  })

  test("a database built from the first 12 migrations gets the backup model, the hold and the model usage (spec 006)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-upgrade-12-")), "robot.db")
    const old = new DatabaseSync(file)
    old.exec("PRAGMA foreign_keys = ON")
    const before = migrations.slice(0, 12)
    expect(before).toHaveLength(12)
    for (const sql of before) old.exec(sql)
    old.exec(`PRAGMA application_id = ${SCHEMA_ID}; PRAGMA user_version = ${before.length};`)
    old.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s1', 'This computer', 'local', 0, 1);
      INSERT INTO workflow (id, server_id, name, name_key, document, folder, created_at, updated_at)
        VALUES ('w1', 's1', 'Report', 'report', 'Doc.', '/tmp/w1', 1, 1);
      INSERT INTO workflow_node (id, workflow_id, number, kind, name, account_id, model)
        VALUES ('n1', 'w1', 1, 'text', 'Draft', 'a1', 'm1');
      INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', 'w1', 'done', 'hand', 1);
      INSERT INTO task (id, run_id, workflow_id, node_id, node_name, node_number, state, created_at)
        VALUES ('t1', 'r1', 'w1', 'n1', 'Draft', 1, 'done', 1);
    `)
    old.close()
    const db = openDatabase(file)
    // The node has no backup: the three columns are NULL, and the task has no line.
    expect(
      db.all("SELECT backup_account_id, backup_model, backup_effort FROM workflow_node"),
    ).toEqual([{ backup_account_id: null, backup_model: null, backup_effort: null }])
    expect(db.all("SELECT backup_note FROM task")).toEqual([{ backup_note: null }])
    // The hold belongs to no row of the graph: it stays when the nodes are written again.
    db.run(
      "INSERT INTO model_hold (node_id, ends_at, main_account_id, main_model, backup_account_id, backup_model) VALUES ('n1', 9, 'a1', 'm1', 'a2', 'm2')",
    )
    db.run("DELETE FROM workflow_node WHERE id = 'n1'")
    expect(db.all("SELECT node_id FROM model_hold")).toEqual([{ node_id: "n1" }])
    // The usage of a model goes with its task.
    db.run(
      "INSERT INTO task_usage (task_id, account_id, model, input_tokens) VALUES ('t1', 'a2', 'm2', 5)",
    )
    db.run("DELETE FROM task WHERE id = 't1'")
    expect(db.all("SELECT task_id FROM task_usage")).toEqual([])
  })
})
