import { describe, expect, test } from "bun:test"
import { DatabaseSync } from "node:sqlite"
import { migrate } from "./Database.ts"
import { migrations } from "./migrations.ts"

/** The index of the migration that S27 added: the notes of a workflow. */
const NOTES = 13
/** The index of the migration that S28 added: the user sections of the place list. */
const SECTIONS = 14
/** The index of the migration that S26 added: agent knowledge. */
const KNOWLEDGE = 12
/** The index of the migration that spec 006 added: the separate sign-in of an account. */
const SIGN_IN = SECTIONS + 1
/** The index of the migration that spec 003 added: the notes kept with a message. */
const CONTEXT = SIGN_IN + 1
/** Main has this many steps. The steps of the device link and of sync follow them. */
const MAIN_STEPS = CONTEXT + 1

const upTo = (count: number) => {
  const db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const sql of migrations.slice(0, count)) db.exec(sql)
  return db
}

describe("the migration for workflow notes", () => {
  test("it only adds a column that has a default", () => {
    expect(migrations[NOTES]?.trim()).toBe(
      "ALTER TABLE workflow ADD COLUMN notes TEXT NOT NULL DEFAULT '[]';",
    )
    // Later migrations may follow it.
    expect(migrations.length).toBeGreaterThan(NOTES)
  })

  test("a database from before it keeps its workflows, and the build before it keeps working", () => {
    const db = upTo(NOTES)
    const columns = () =>
      (db.prepare("PRAGMA table_info(workflow)").all() as { name: string }[]).map((c) => c.name)
    const before = columns()
    db.prepare(
      `INSERT INTO workflow (id, server_id, name, trigger, steps, edges, enabled, last_checked_at, created_at, updated_at)
       VALUES ('w1', 's', 'Old', '{"kind":"manual"}', '[]', '[]', 1, 0, 0, 0)`,
    ).run()

    db.exec(migrations[NOTES] ?? "")

    // Nothing was taken away or renamed, and the old row has an empty list of notes.
    expect(columns()).toEqual([...before, "notes"])
    expect(db.prepare("SELECT notes, enabled, name FROM workflow WHERE id = 'w1'").get()).toEqual({
      notes: "[]",
      enabled: 1,
      name: "Old",
    })
    // The statements of the build before the change need no value for the new column.
    db.prepare(
      `INSERT INTO workflow (id, server_id, name, trigger, steps, edges, enabled, last_checked_at, created_at, updated_at)
       VALUES ('w2', 's', 'Made by the old build', '{"kind":"manual"}', '[]', '[]', 1, 0, 0, 0)`,
    ).run()
    db.prepare(
      "UPDATE workflow SET name = ?, steps = ?, edges = ?, enabled = ?, updated_at = ? WHERE id = ?",
    ).run("Renamed", "[]", "[]", 0, 1, "w2")
    expect(db.prepare("SELECT * FROM workflow WHERE id = 'w2'").get()).toMatchObject({
      name: "Renamed",
      notes: "[]",
    })
    db.exec("DELETE FROM workflow WHERE id = 'w1'")
  })

  test("the tables of runs are not changed by it", () => {
    const db = upTo(NOTES)
    const shape = () =>
      JSON.stringify(
        ["workflow_run", "workflow_run_step"].map((t) =>
          db.prepare(`PRAGMA table_info(${t})`).all(),
        ),
      )
    const before = shape()
    db.exec(migrations[NOTES] ?? "")
    expect(shape()).toBe(before)
  })
})

describe("the migration for user sections", () => {
  const insertAgent = (db: DatabaseSync, id: string) =>
    db
      .prepare(
        `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
           workspace, section, created_at, updated_at)
         VALUES (?, 's', ?, ?, '', '', 0, 0, '/w', 'agents', 0, 0)`,
      )
      .run(id, id, id)
  const insertChannel = (db: DatabaseSync, id: string) =>
    db
      .prepare(
        `INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
         VALUES (?, 's', ?, ?, '', 0, 0)`,
      )
      .run(id, id, id)
  const withServer = (count: number) => {
    const db = upTo(count)
    db.exec(
      "INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0)",
    )
    return db
  }

  test("it only adds a table, an index and two columns", () => {
    expect(migrations.length).toBeGreaterThan(SECTIONS)
    const sql = migrations[SECTIONS] ?? ""
    expect(sql).toContain("CREATE TABLE place_section")
    expect(sql).not.toMatch(/DROP |RENAME |DELETE FROM|UPDATE /i)
  })

  test("a database from before it keeps its agents and channels, with no section", () => {
    const db = withServer(SECTIONS)
    insertAgent(db, "a1")
    insertChannel(db, "c1")
    db.exec(migrations[SECTIONS] ?? "")
    expect(db.prepare("SELECT name, place_section_id FROM agent").all()).toEqual([
      { name: "a1", place_section_id: null },
    ])
    expect(db.prepare("SELECT name, place_section_id FROM channel").all()).toEqual([
      { name: "c1", place_section_id: null },
    ])
  })

  test("the statements of the build before it keep working", () => {
    const db = withServer(SECTIONS)
    db.exec(migrations[SECTIONS] ?? "")
    // The agent and channel inserts of the earlier build name no section column.
    insertAgent(db, "a2")
    insertChannel(db, "c2")
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM agent WHERE place_section_id IS NULL").get(),
    ).toEqual({ n: 1 })
  })

  test("a section name is unique in one kind on one server, ignoring case through its key", () => {
    const db = withServer(SECTIONS + 1)
    const add = (id: string, kind: string, key: string) =>
      db
        .prepare(
          "INSERT INTO place_section (id, server_id, kind, name, name_key, position, created_at) VALUES (?, 's', ?, ?, ?, 0, 0)",
        )
        .run(id, kind, key, key)
    add("p1", "agent", "research")
    expect(() => add("p2", "agent", "research")).toThrow()
    expect(() => add("p3", "channel", "research")).not.toThrow()
  })

  test("deleting a section clears the section of its agents and channels", () => {
    const db = withServer(SECTIONS + 1)
    db.exec(
      "INSERT INTO place_section (id, server_id, kind, name, name_key, position, created_at) VALUES ('p1', 's', 'agent', 'R', 'r', 0, 0)",
    )
    insertAgent(db, "a1")
    db.exec("UPDATE agent SET place_section_id = 'p1'")
    db.exec("DELETE FROM place_section WHERE id = 'p1'")
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent").get()).toEqual({ n: 1 })
    expect(db.prepare("SELECT place_section_id FROM agent").get()).toEqual({
      place_section_id: null,
    })
  })

  test("an agent cannot point at a section that does not exist", () => {
    const db = withServer(SECTIONS + 1)
    insertAgent(db, "a1")
    expect(() => db.exec("UPDATE agent SET place_section_id = 'nope'")).toThrow()
  })
})

describe("the steps of the device link and of sync", () => {
  test("the steps of main keep their numbers and the steps of this branch follow them", () => {
    expect(migrations[KNOWLEDGE]).toContain("knowledge_enabled")
    expect(migrations[NOTES]).toContain("ADD COLUMN notes")
    expect(migrations[SECTIONS]).toContain("CREATE TABLE place_section")
    expect(migrations[SIGN_IN]?.trim()).toBe(
      "ALTER TABLE provider_account ADD COLUMN sign_in TEXT;",
    )
    expect(migrations[CONTEXT]?.trim()).toBe("ALTER TABLE message ADD COLUMN context TEXT;")
    expect(migrations[MAIN_STEPS]).toContain("CREATE TABLE device_link")
    expect(migrations[MAIN_STEPS + 1]).toContain("CREATE TABLE sync_pair")
    expect(migrations[MAIN_STEPS + 2]).toContain("ALTER TABLE device_link ADD COLUMN can_change")
    // No step of this branch changes the table that the step of main changed.
    for (const sql of migrations.slice(MAIN_STEPS)) {
      expect(sql).not.toMatch(/ALTER TABLE provider_account/i)
    }
    // The step for the progress of a task (spec 005) follows them.
    expect(migrations[MAIN_STEPS + 3]?.trim()).toContain(
      "ALTER TABLE task ADD COLUMN progress TEXT;",
    )
    // The number of steps is the data version that two computers compare before they sync.
    expect(migrations.length).toBe(MAIN_STEPS + 4)
  })

  test("a task from before the progress step keeps its row and shows no progress", () => {
    const db = upTo(MAIN_STEPS + 3)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, knowledge_enabled, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 0, 1, 1);
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at)
        VALUES ('t', 'a', 'old', 'old', 'chat', 'failed', 1);
    `)
    db.exec(migrations[MAIN_STEPS + 3] as string)
    expect(db.prepare("SELECT id, progress FROM task").all()).toEqual([{ id: "t", progress: null }])
  })

  test("a database that ran only the steps of main opens, migrates, and keeps its data", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    for (const sql of migrations.slice(0, MAIN_STEPS)) db.exec(sql)
    db.exec(`PRAGMA user_version = ${MAIN_STEPS}`)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO place_section (id, server_id, kind, name, name_key, position, created_at)
        VALUES ('p', 's', 'agent', 'Team', 'team', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, place_section_id, knowledge_enabled, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 'p', 0, 1, 1);
      INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
        VALUES ('c', 's', 'Room', 'room', '', 1, 1);
      INSERT INTO channel_member (channel_id, agent_id, position) VALUES ('c', 'a', 0);
      INSERT INTO workflow (id, server_id, name, trigger, steps, edges, notes, last_checked_at,
        created_at, updated_at)
        VALUES ('w', 's', 'Flow', '{}', '[]', '[]', '[{"id":"n1"}]', 0, 1, 1);
      INSERT INTO knowledge_file (agent_id, file, hash, editor, content)
        VALUES ('a', 'x.md', 'h', 'agent', 'text');
      INSERT INTO provider_account (id, kind, name, base_url, created_at)
        VALUES ('acc', 'claude-code', 'Claude', '', 1);
    `)

    migrate(db)

    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length })
    expect(db.prepare("SELECT name, place_section_id, knowledge_enabled FROM agent").all()).toEqual(
      [{ name: "Ada", place_section_id: "p", knowledge_enabled: 0 }],
    )
    expect(db.prepare("SELECT name FROM channel").all()).toEqual([{ name: "Room" }])
    expect(db.prepare("SELECT agent_id FROM channel_member").all()).toEqual([{ agent_id: "a" }])
    expect(db.prepare("SELECT name, notes FROM workflow").all()).toEqual([
      { name: "Flow", notes: '[{"id":"n1"}]' },
    ])
    expect(db.prepare("SELECT file FROM knowledge_file").all()).toEqual([{ file: "x.md" }])
    // The account keeps its row, and the separate sign-in of main stays empty.
    expect(db.prepare("SELECT name, sign_in FROM provider_account").all()).toEqual([
      { name: "Claude", sign_in: null },
    ])
    // The new columns start empty, and no sync pair exists, so nothing marks a row as changed.
    expect(db.prepare("SELECT changed_by, changed_at FROM agent").all()).toEqual([
      { changed_by: null, changed_at: null },
    ])
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_dirty").get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM device_link").get()).toEqual({ n: 0 })
    // The tables of main still accept their rows after the later steps.
    db.exec("UPDATE agent SET role = 'Writer'")
    db.exec("UPDATE workflow SET name = 'Flow 2'")
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_dirty").get()).toEqual({ n: 0 })
  })

  test("a second open of a migrated database changes nothing", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    migrate(db)
    migrate(db)
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length })
  })
})
