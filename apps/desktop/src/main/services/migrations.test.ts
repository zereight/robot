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
/** The index of the step that keeps how far the turn of a task went (spec 005). */
const PROGRESS = migrations.findIndex((sql) => sql.includes("ALTER TABLE task ADD COLUMN progress"))
/** The index of the step that keeps the done test and the verdict of a part (spec 004, 005). */
const VERDICT = migrations.findIndex((sql) => sql.includes("ALTER TABLE task ADD COLUMN done_test"))
/** The index of the step that S46 added: message search (spec 001). It follows the sync steps. */
const MOMENTS = migrations.findIndex((sql) => sql.includes("ALTER TABLE task ADD COLUMN ended_at"))
const AGENT_MESSAGE = migrations.findIndex((sql) =>
  sql.includes("ALTER TABLE task ADD COLUMN agent_message"),
)
const SEARCH = migrations.findIndex((sql) => sql.includes("CREATE VIRTUAL TABLE message_fts"))

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
    // The step for the progress of a task (spec 005) comes after the steps above, and once.
    expect(PROGRESS).toBeGreaterThan(MAIN_STEPS + 2)
    expect(
      migrations.filter((sql) => sql.includes("ALTER TABLE task ADD COLUMN progress")),
    ).toHaveLength(1)
    // The step for message search (spec 001) follows them.
    expect(SEARCH).toBeGreaterThan(MAIN_STEPS + 2)
    // The step of the limits of a task adds its columns after the step that makes the action log.
    const logStep = migrations.findIndex((sql) => sql.includes("CREATE TABLE action_log"))
    const depthStep = migrations.findIndex((sql) =>
      sql.includes("ALTER TABLE task ADD COLUMN depth"),
    )
    expect(logStep).toBeGreaterThan(MAIN_STEPS + 2)
    expect(depthStep).toBeGreaterThan(logStep)
    expect(migrations[depthStep]).toContain("ALTER TABLE action_log ADD COLUMN access")
    // The number of steps is the data version that two computers compare before they sync.
    // Later steps follow these.
    expect(migrations.length).toBeGreaterThan(depthStep)
    // S44: the checklist that an import leaves is a step of its own, after the action log (S39).
    const checklist = migrations.findIndex((sql) => sql.includes("CREATE TABLE import_checklist"))
    const actionLog = migrations.findIndex((sql) => sql.includes("CREATE TABLE action_log"))
    expect(checklist).toBeGreaterThan(actionLog)
    expect(migrations[checklist]).not.toContain("action_log")
  })

  test("a task from before the progress step keeps its row and shows no progress", () => {
    const db = upTo(PROGRESS)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, knowledge_enabled, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 0, 1, 1);
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at)
        VALUES ('t', 'a', 'old', 'old', 'chat', 'failed', 1);
    `)
    db.exec(migrations[PROGRESS] as string)
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

describe("the step for message search", () => {
  const insertAgent = (db: DatabaseSync) =>
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 1, 1);
      INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
        VALUES ('c', 's', 'Room', 'room', '', 1, 1);
    `)
  const text = (value: string) => JSON.stringify([{ kind: "text", text: value }])

  test("it only adds tables, an index and triggers; it changes no table that exists", () => {
    const sql = migrations[SEARCH] ?? ""
    expect(sql).toContain("CREATE TABLE message_text")
    expect(sql).not.toMatch(/ALTER TABLE|DROP TABLE|UPDATE message|DELETE FROM message\b/i)
  })

  test("a database from before it gets an index of the messages it holds", () => {
    const db = upTo(SEARCH)
    insertAgent(db)
    const add = db.prepare(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES (?, 'a', 'user', ?, ?, ?)",
    )
    add.run("m1", text("The budget is 4200 euros"), "done", 1)
    add.run("m2", text("still being written"), "streaming", 2)
    add.run("m3", JSON.stringify([{ kind: "thinking", text: "private" }]), "done", 3)
    add.run("m4", "not json", "done", 4)
    db.prepare(
      "INSERT INTO channel_message (id, channel_id, author, parts, status, created_at) VALUES ('c1', 'c', 'user', ?, 'done', 5)",
    ).run(text("budget talk in a channel"))

    db.exec(migrations[SEARCH] ?? "")

    expect(
      db.prepare("SELECT kind, message_id FROM message_text ORDER BY created_at").all(),
    ).toEqual([
      { kind: "chat", message_id: "m1" },
      { kind: "channel", message_id: "c1" },
    ])
    expect(
      db.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH '\"bud\"'").all(),
    ).toHaveLength(2)
    // The step changed no message.
    expect(db.prepare("SELECT COUNT(*) AS n FROM message").get()).toEqual({ n: 4 })
  })

  test("a message that is not JSON does not stop a write", () => {
    const db = upTo(SEARCH + 1)
    insertAgent(db)
    db.exec(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('m', 'a', 'user', 'oops', 'done', 1)",
    )
    db.exec("UPDATE message SET status = 'stopped'")
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_text").get()).toEqual({ n: 0 })
  })

  test("a write to a message keeps the text table and the index in step", () => {
    const db = upTo(SEARCH + 1)
    insertAgent(db)
    const find = (word: string) =>
      db
        .prepare(
          "SELECT t.message_id AS id FROM message_fts JOIN message_text t ON t.n = message_fts.rowid WHERE message_fts MATCH ?",
        )
        .all(`"${word}"`)
        .map((r) => (r as { id: string }).id)
    db.prepare(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('m', 'a', 'agent', ?, 'streaming', 1)",
    ).run(text("partial words"))
    expect(find("partial")).toEqual([])
    db.exec("UPDATE message SET status = 'done'")
    expect(find("partial")).toEqual(["m"])
    db.prepare("UPDATE message SET parts = ?").run(text("final words"))
    expect(find("partial")).toEqual([])
    expect(find("final")).toEqual(["m"])
    // A change that is not text does not touch the entry.
    db.exec("UPDATE message SET context = 'notes'")
    expect(find("final")).toEqual(["m"])
    db.exec("DELETE FROM agent WHERE id = 'a'")
    expect(find("final")).toEqual([])
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_text").get()).toEqual({ n: 0 })
  })

  test("an old database opens, migrates, and then searches", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    for (const sql of migrations.slice(0, SEARCH)) db.exec(sql)
    db.exec(`PRAGMA user_version = ${SEARCH}`)
    insertAgent(db)
    db.prepare(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('m', 'a', 'user', ?, 'done', 1)",
    ).run(text("hello there"))
    migrate(db)
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length })
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_text").get()).toEqual({ n: 1 })
  })
})

describe("the step of the action log", () => {
  test("it makes the table of the log, which no trigger of sync watches", () => {
    const step = migrations.findIndex((sql) => sql.includes("CREATE TABLE action_log"))
    expect(step).toBeGreaterThan(MAIN_STEPS + 2)
    const db = new DatabaseSync(":memory:")
    for (const sql of migrations) db.exec(sql)
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'action_log'")
      .all()
    expect(triggers).toEqual([])
  })
})

describe("the step of messages during a turn", () => {
  test("it comes after the action log and adds the turn and the read time of a message", () => {
    const step = migrations.findIndex((sql) => sql.includes("ADD COLUMN joined_to"))
    expect(step).toBeGreaterThan(
      migrations.findIndex((sql) => sql.includes("CREATE TABLE action_log")),
    )
    const db = new DatabaseSync(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    migrate(db)
    const columns = db.prepare("PRAGMA table_info(message)").all() as { name: string }[]
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(["joined_to", "read_at"]))
  })
})

describe("the step of skills (S45)", () => {
  test("it comes after the step of messages during a turn, and no trigger of sync watches it", () => {
    const joined = migrations.findIndex((sql) => sql.includes("ADD COLUMN joined_to"))
    const step = migrations.findIndex((sql) => sql.includes("CREATE TABLE skill"))
    expect(step).toBe(joined + 1)
    const db = new DatabaseSync(":memory:")
    for (const sql of migrations) db.exec(sql)
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'skill'")
      .all()
    expect(triggers).toEqual([])
  })
})

describe("the step for the times of a task", () => {
  test("it adds two empty columns, and old tasks keep their rows with unknown times", () => {
    const step = migrations.findIndex((sql) => sql.includes("ADD COLUMN first_reply_at"))
    // It follows the step of the import checklist, the last step of main when it was added.
    expect(step).toBeGreaterThan(
      migrations.findIndex((sql) => sql.includes("CREATE TABLE import_checklist")),
    )
    const db = upTo(step)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 1, 1);
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at)
        VALUES ('t', 'a', 'hi', 'hi', 'chat', 'done', 5);
    `)
    db.exec(migrations[step] as string)
    expect(db.prepare("SELECT id, asked_at, first_reply_at FROM task").all()).toEqual([
      { id: "t", asked_at: null, first_reply_at: null },
    ])
  })
})

describe("the step for memory control", () => {
  /** The step that spec 008 added: the choice of an agent, proposals and history. */
  const MEMORY = migrations.findIndex((sql) => sql.includes("ADD COLUMN memory_mode"))

  test("it adds the choice with a default, and two tables that sync does not carry", () => {
    const sql = migrations[MEMORY] ?? ""
    expect(sql).toContain("ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'now'")
    expect(sql).toContain("CREATE TABLE memory_proposal")
    expect(sql).toContain("CREATE TABLE memory_history")
    // Spec 019: no trigger marks a row of these tables as changed.
    expect(sql).not.toMatch(/CREATE TRIGGER/i)
    expect(sql).not.toMatch(/sync_dirty/)
  })

  test("a database from before keeps its agents and memory, and every agent saves at once", () => {
    const db = upTo(MEMORY)
    db.exec(`PRAGMA user_version = ${MEMORY}`)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 1, 1);
      INSERT INTO memory (id, agent_id, text, source, created_at, updated_at)
        VALUES ('m', 'a', 'Likes tea', 'user', 1, 1);
    `)
    migrate(db)
    expect(db.prepare("SELECT memory_mode FROM agent").get()).toEqual({ memory_mode: "now" })
    expect(db.prepare("SELECT text FROM memory").get()).toEqual({ text: "Likes tea" })
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_proposal").get()).toEqual({ n: 0 })
  })

  test("a change to the memory tables marks no row for sync, also in a sync pair", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    migrate(db)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 1, 1);
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
    `)
    db.exec("DELETE FROM sync_dirty")
    db.exec(`
      INSERT INTO memory_proposal (id, agent_id, text, created_at) VALUES ('p1', 'a', 'x', 1);
      INSERT INTO memory_history (id, agent_id, memory_id, at, actor, kind, source, new_text)
        VALUES ('h1', 'a', 'm', 1, 'user', 'added', 'user', 'x');
      DELETE FROM memory_proposal;
    `)
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_dirty").get()).toEqual({ n: 0 })
  })
})

describe("the step of saved secrets", () => {
  test("it keeps no value, no trigger of sync watches it, and an agent takes its secrets along", () => {
    const step = migrations.findIndex((sql) => sql.includes("CREATE TABLE saved_secret"))
    expect(step).toBeGreaterThan(MAIN_STEPS + 2)
    const db = new DatabaseSync(":memory:")
    for (const sql of migrations) db.exec(sql)
    const synced = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'saved_secret'",
      )
      .all()
    expect(synced).toEqual([])
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('saved_secret')")
      .all()
      .map((c) => (c as { name: string }).name)
    expect(columns).not.toContain("value")
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO place_section (id, server_id, kind, name, name_key, position, created_at)
        VALUES ('p', 's', 'agent', 'Team', 'team', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, place_section_id, knowledge_enabled, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 'p', 0, 1, 1);
      INSERT INTO saved_secret (id, agent_id, name, name_key, origin, auth, value_ref, saved_at)
        VALUES ('k', 'a', 'Key', 'key', 'https://x.test', '{"kind":"bearer"}', 'ref-1', 1);
      DELETE FROM agent WHERE id = 'a';
    `)
    expect(db.prepare("SELECT COUNT(*) AS n FROM saved_secret").get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT value_ref FROM saved_secret_drop").all()).toEqual([
      { value_ref: "ref-1" },
    ])
  })
})

describe("the step of the instruction history", () => {
  test("it makes the table, which sync watches and which goes with its agent", () => {
    const step = migrations.findIndex((sql) => sql.includes("CREATE TABLE instruction_version"))
    expect(step).toBeGreaterThan(
      migrations.findIndex((sql) => sql.includes("CREATE TABLE saved_secret")),
    )
    // Later steps may follow it (S43 adds the step of watch routines).
    expect(step).toBeLessThan(migrations.length)
    const db = upTo(migrations.length)
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'instruction_version' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name)
    expect(triggers).toEqual([
      "sync_dirty_instruction_version_delete",
      "sync_dirty_instruction_version_insert",
      "sync_dirty_instruction_version_update",
    ])
    db.exec(
      "INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0); INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue, workspace, section, created_at, updated_at) VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 1, 1)",
    )
    db.exec(
      "INSERT INTO instruction_version (id, agent_id, text, source, created_at) VALUES ('v', 'a', 'x', 'chat', 1)",
    )
    db.exec("DELETE FROM agent WHERE id = 'a'")
    expect(db.prepare("SELECT COUNT(*) AS n FROM instruction_version").get()).toEqual({ n: 0 })
  })
})

describe("the step of the done test and the verdict", () => {
  const server = `
    INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
    INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
      workspace, section, knowledge_enabled, created_at, updated_at)
      VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 0, 1, 1);
  `

  test("it only adds nullable columns, once, after the step of the review setting", () => {
    expect(VERDICT).toBeGreaterThan(PROGRESS)
    expect(migrations.filter((sql) => sql.includes("ADD COLUMN done_test"))).toHaveLength(1)
    const sql = migrations[VERDICT] ?? ""
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE |NOT NULL/i)
    for (const column of ["done_test", "verdict", "verdict_reason", "judged_at", "decided_at"])
      expect(sql).toContain(`ALTER TABLE task ADD COLUMN ${column}`)
  })

  test("a task from before it keeps its row, with no done test and no verdict", () => {
    const db = upTo(VERDICT)
    db.exec(server)
    db.exec(`
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at)
        VALUES ('t', 'a', 'old', 'old', 'channel', 'done', 1);
    `)
    db.exec(migrations[VERDICT] as string)
    expect(
      db
        .prepare(
          "SELECT id, state, done_test, verdict, verdict_reason, judged_at, decided_at FROM task",
        )
        .all(),
    ).toEqual([
      {
        id: "t",
        state: "done",
        done_test: null,
        verdict: null,
        verdict_reason: null,
        judged_at: null,
        decided_at: null,
      },
    ])
  })

  test("a change of the verdict marks the task for sync, in a sync pair", () => {
    const db = upTo(VERDICT + 1)
    db.exec(server)
    db.exec(`
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at, done_test)
        VALUES ('t', 'a', 'x', 'x', 'channel', 'done', 1, 'Holds a title');
    `)
    db.exec("DELETE FROM sync_dirty")
    db.exec("UPDATE task SET verdict = 'not_met', verdict_reason = 'No title', judged_at = 5")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([{ kind: "task", id: "t" }])
  })
})

describe("the step of the moments of a task", () => {
  const server = `
    INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
    INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
      workspace, section, knowledge_enabled, created_at, updated_at)
      VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 0, 1, 1);
  `

  test("it only adds nullable columns, once, after the step of the verdict", () => {
    expect(MOMENTS).toBeGreaterThan(VERDICT)
    expect(migrations.filter((sql) => sql.includes("ADD COLUMN ended_at"))).toHaveLength(1)
    const sql = migrations[MOMENTS] ?? ""
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE |NOT NULL/i)
    for (const column of ["ended_at", "ended_as", "decision", "decision_text"])
      expect(sql).toContain(`ALTER TABLE task ADD COLUMN ${column}`)
  })

  test("a task from before it keeps its row, with no moment of the turn and no decision", () => {
    const db = upTo(MOMENTS)
    db.exec(server)
    db.exec(`
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at, started_at, finished_at)
        VALUES ('t', 'a', 'old', 'old', 'channel', 'done', 1, 2, 3);
    `)
    db.exec(migrations[MOMENTS] as string)
    expect(
      db
        .prepare(
          "SELECT id, state, started_at, finished_at, ended_at, ended_as, decision, decision_text FROM task",
        )
        .all(),
    ).toEqual([
      {
        id: "t",
        state: "done",
        started_at: 2,
        finished_at: 3,
        ended_at: null,
        ended_as: null,
        decision: null,
        decision_text: null,
      },
    ])
  })

  test("a change of a decision marks the task for sync, in a sync pair", () => {
    const db = upTo(MOMENTS + 1)
    db.exec(server)
    db.exec(`
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at)
        VALUES ('t', 'a', 'x', 'x', 'channel', 'review', 1);
    `)
    db.exec("DELETE FROM sync_dirty")
    db.exec("UPDATE task SET decision = 'changes', decision_text = 'Add a title', decided_at = 5")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([{ kind: "task", id: "t" }])
  })
})

describe("the step of permission rules (S30)", () => {
  const RULES = migrations.findIndex((sql) => sql.includes("CREATE TABLE permission_rule"))
  const before = () => {
    const db = upTo(RULES)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, knowledge_enabled, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 0, 1, 1);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, knowledge_enabled, created_at, updated_at)
        VALUES ('b', 's', 'Bo', 'bo', '', '', 0, 0, '/w2', 'agents', 0, 1, 1);
    `)
    return db
  }
  const allow = (db: DatabaseSync, agent: string, key: string) =>
    db.prepare("INSERT INTO agent_allow (agent_id, key) VALUES (?, ?)").run(agent, key)
  const rules = (db: DatabaseSync) =>
    db
      .prepare(
        "SELECT agent_id AS agent, kind, match_text AS text, detail, decision, source FROM permission_rule ORDER BY kind, match_text, detail",
      )
      .all()

  test("it comes after the table of the log and no trigger of sync watches the rules", () => {
    expect(RULES).toBeGreaterThan(
      migrations.findIndex((sql) => sql.includes("CREATE TABLE action_log")),
    )
    const db = new DatabaseSync(":memory:")
    for (const sql of migrations) db.exec(sql)
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'permission_rule'",
      )
      .all()
    expect(triggers).toEqual([])
    const columns = db.prepare("PRAGMA table_info(action_log)").all() as { name: string }[]
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["rule_id", "rule_kind", "rule_text", "rule_detail"]),
    )
  })

  test("the keys that name a step become Allow rules from a card, and the old table goes", () => {
    const db = before()
    allow(db, "a", "run_command:git status")
    allow(db, "a", "run_command:control:echo x >> ~/.zshrc")
    allow(db, "a", "write_file:control:/home/u/.zshrc")
    allow(db, "a", "write_file:/data/out.txt")
    allow(db, "b", "read_file:/data/in.txt")
    allow(db, "a", "list_files:/data/dir")
    allow(db, "a", "fetch_url:local:127.0.0.1")
    allow(db, "b", "network:Example.COM")
    allow(db, "a", "secret_request:stripe:POST")
    allow(db, "a", "secret_request:my:odd:name:*")
    db.exec(migrations[RULES] as string)
    const card = { decision: "allow", source: "card", detail: null }
    expect(rules(db)).toEqual([
      { agent: "a", kind: "file", text: "/data/dir", ...card },
      { agent: "b", kind: "file", text: "/data/in.txt", ...card },
      { agent: "a", kind: "file", text: "/data/out.txt", ...card },
      { agent: "a", kind: "file", text: "/home/u/.zshrc", ...card },
      { agent: "a", kind: "secret", text: "my:odd:name", ...card },
      { agent: "a", kind: "secret", text: "stripe", ...card, detail: "POST" },
      { agent: "a", kind: "shell", text: "echo x >> ~/.zshrc", ...card },
      { agent: "a", kind: "shell", text: "git status", ...card },
      { agent: "a", kind: "web", text: "127.0.0.1", ...card },
      { agent: "b", kind: "web", text: "example.com", ...card },
    ])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_allow'").all()).toEqual(
      [],
    )
  })

  test("a key for a whole class of steps is dropped: a rule is never wider than the key was", () => {
    const db = before()
    for (const key of [
      "run_command:install",
      "run_command:network",
      "run_command:sudo",
      "run_command:shell_pipe",
      "run_command:delete_outside",
      "run_command:",
      "read_file",
      "read_file:outside",
      "write_file",
      "write_file:outside",
      "list_files",
      "list_files:outside",
      "fetch_url",
      "web_search",
      "browser_open",
      "browser_act",
      "forget_secret",
      "tool:Skill",
      "mcp:server:tool:{}",
    ])
      allow(db, "a", key)
    db.exec(migrations[RULES] as string)
    expect(rules(db)).toEqual([])
  })

  test("a key of text over 500 characters is dropped, and two equal keys make one rule", () => {
    const db = before()
    allow(db, "a", `run_command:${"x".repeat(501)}`)
    allow(db, "a", "run_command:ls")
    allow(db, "a", "run_command:control:ls")
    db.exec(migrations[RULES] as string)
    expect(rules(db)).toEqual([
      { agent: "a", kind: "shell", text: "ls", detail: null, decision: "allow", source: "card" },
    ])
  })

  test("deleting an agent deletes its rules, and a rule for all agents stays", () => {
    const db = before()
    db.exec("PRAGMA foreign_keys = ON")
    db.exec(migrations[RULES] as string)
    db.exec(`
      INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
        VALUES ('r1', 's', 'a', 'shell', 'ls', NULL, 'allow', 'list', 1),
               ('r2', 's', NULL, 'shell', 'pwd', NULL, 'deny', 'list', 2);
      DELETE FROM agent WHERE id = 'a';
    `)
    expect(db.prepare("SELECT id FROM permission_rule").all()).toEqual([{ id: "r2" }])
  })

  test("a log entry from before keeps its row, with no rule", () => {
    const db = upTo(RULES)
    db.exec(`
      INSERT INTO action_log (id, at, agent_id, agent_name, kind, target, decided_by, result)
        VALUES ('e', 1, 'a', 'Ada', 'shell', 'ls', 'level', 'ran');
    `)
    db.exec(migrations[RULES] as string)
    expect(db.prepare("SELECT id, rule_id, rule_text FROM action_log").all()).toEqual([
      { id: "e", rule_id: null, rule_text: null },
    ])
  })
})

describe("the migration for the review of connection tools (spec 018)", () => {
  const REVIEW = migrations.findIndex((sql) => sql.includes("ADD COLUMN review_adopt"))
  const insert = (db: DatabaseSync, id: string) =>
    db
      .prepare(
        `INSERT INTO tool_connection (id, server_id, name, name_key, kind, enabled, tools, created_at)
         VALUES (?, 's', ?, ?, 'program', 1, '[{"name":"echo","description":"Says it."}]', 1)`,
      )
      .run(id, id, id)

  test("it only adds columns that have a default", () => {
    // Later steps may follow it.
    expect(REVIEW).toBeGreaterThan(0)
    expect(migrations[REVIEW]).toContain("ADD COLUMN reviewed TEXT NOT NULL DEFAULT '[]'")
    expect(migrations[REVIEW]).toContain("ADD COLUMN review_adopt INTEGER NOT NULL DEFAULT 0")
  })

  test("a connection from before keeps its row and is marked to take its tools at its first start; a new one is not", () => {
    const db = upTo(REVIEW)
    insert(db, "old")
    db.exec(migrations[REVIEW] ?? "")
    expect(
      db
        .prepare("SELECT reviewed, review_adopt, tools FROM tool_connection WHERE id = 'old'")
        .get(),
    ).toEqual({
      reviewed: "[]",
      review_adopt: 1,
      tools: '[{"name":"echo","description":"Says it."}]',
    })
    insert(db, "new")
    expect(
      db.prepare("SELECT reviewed, review_adopt FROM tool_connection WHERE id = 'new'").get(),
    ).toEqual({ reviewed: "[]", review_adopt: 0 })
  })
})

describe('the migration for the switch "Trust read-only marks" (spec 018)', () => {
  const TRUST = migrations.findIndex((sql) => sql.includes("ADD COLUMN trust_read_only"))

  test("it only adds one column with a default of off, once", () => {
    expect(TRUST).toBeGreaterThan(0)
    expect(migrations.filter((sql) => sql.includes("ADD COLUMN trust_read_only"))).toHaveLength(1)
    const sql = migrations[TRUST] ?? ""
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE /i)
    expect(sql).toContain("ADD COLUMN trust_read_only INTEGER NOT NULL DEFAULT 0")
  })

  test("a connection from before keeps its row with the switch off", () => {
    const db = upTo(TRUST)
    db.prepare(
      `INSERT INTO tool_connection (id, server_id, name, name_key, kind, enabled, created_at)
       VALUES ('old', 's', 'Old', 'old', 'program', 1, 1)`,
    ).run()
    db.exec(migrations[TRUST] as string)
    expect(db.prepare("SELECT id, enabled, trust_read_only FROM tool_connection").all()).toEqual([
      { id: "old", enabled: 1, trust_read_only: 0 },
    ])
  })
})

describe("the step of the mark of a message from another agent", () => {
  const server = `
    INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
    INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
      workspace, section, knowledge_enabled, created_at, updated_at)
      VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 0, 1, 1);
  `

  test("it only adds one nullable column, once, after the step of the moments", () => {
    expect(AGENT_MESSAGE).toBeGreaterThan(MOMENTS)
    expect(migrations.filter((sql) => sql.includes("ADD COLUMN agent_message"))).toHaveLength(1)
    const sql = migrations[AGENT_MESSAGE] ?? ""
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE |NOT NULL/i)
    expect(sql).toContain("ALTER TABLE task ADD COLUMN agent_message TEXT;")
  })

  test("a task from before it keeps its row, with no mark", () => {
    const db = upTo(AGENT_MESSAGE)
    db.exec(server)
    db.exec(`
      INSERT INTO task (id, agent_id, prompt, label, source, source_id, state, created_at)
        VALUES ('t', 'a', 'old', 'old', 'agent', 'a', 'done', 1);
    `)
    db.exec(migrations[AGENT_MESSAGE] as string)
    expect(db.prepare("SELECT id, source, state, agent_message FROM task").all()).toEqual([
      { id: "t", source: "agent", state: "done", agent_message: null },
    ])
  })

  test("a task with a mark marks itself for sync, in a sync pair", () => {
    const db = upTo(AGENT_MESSAGE + 1)
    db.exec(server)
    db.exec(`
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
    `)
    db.exec("DELETE FROM sync_dirty")
    db.exec(`
      INSERT INTO task (id, agent_id, prompt, label, source, source_id, state, created_at, agent_message)
        VALUES ('t', 'a', 'x', 'x', 'agent', 'a', 'queued', 1, 'send');
    `)
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([{ kind: "task", id: "t" }])
  })
})

describe("the step of the handbook and the instructions of a channel (spec 002, 004, 019)", () => {
  const HANDBOOK = migrations.findIndex((sql) => sql.includes("CREATE TABLE handbook_version"))
  const server = `
    INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
    INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
      workspace, section, knowledge_enabled, created_at, updated_at)
      VALUES ('a', 's', 'Ada', 'ada', '', 'Be brief.', 0, 0, '/w', 'agents', 0, 1, 1);
    INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
      VALUES ('c', 's', 'Team', 'team', 'Talk', 1, 1);
  `
  const pair = `
    INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
      VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
  `

  test("it adds two columns that have a default and one table, once, and drops or changes nothing", () => {
    expect(HANDBOOK).toBeGreaterThan(0)
    expect(migrations.filter((sql) => sql.includes("CREATE TABLE handbook_version"))).toHaveLength(
      1,
    )
    expect(migrations.filter((sql) => sql.includes("ADD COLUMN read_handbook"))).toHaveLength(1)
    expect(
      migrations.filter((sql) => sql.includes("ALTER TABLE channel ADD COLUMN instructions")),
    ).toHaveLength(1)
    const sql = migrations[HANDBOOK] ?? ""
    // The triggers say "AFTER UPDATE ON"; no statement may change a row that exists.
    expect(sql).not.toMatch(/DROP |^\s*DELETE FROM|^\s*UPDATE /im)
    expect(sql).toContain("ADD COLUMN read_handbook INTEGER NOT NULL DEFAULT 1")
    expect(sql).toContain("ADD COLUMN instructions TEXT NOT NULL DEFAULT ''")
  })

  test("an agent and a channel from before keep their rows: the switch is on, the instructions are empty, and the handbook is empty", () => {
    const db = upTo(HANDBOOK)
    db.exec(server)
    db.exec(migrations[HANDBOOK] as string)
    expect(db.prepare("SELECT id, instructions, read_handbook FROM agent").all()).toEqual([
      { id: "a", instructions: "Be brief.", read_handbook: 1 },
    ])
    expect(db.prepare("SELECT id, topic, instructions FROM channel").all()).toEqual([
      { id: "c", topic: "Talk", instructions: "" },
    ])
    expect(db.prepare("SELECT COUNT(*) AS n FROM handbook_version").get()).toEqual({ n: 0 })
  })

  test("a version needs a server, and only a version of a server that exists is kept", () => {
    const db = upTo(HANDBOOK + 1)
    db.exec(server)
    expect(() =>
      db
        .prepare(
          "INSERT INTO handbook_version (id, server_id, text, source, created_at) VALUES ('v', 'nowhere', 't', 'page', 1)",
        )
        .run(),
    ).toThrow()
    db.prepare(
      "INSERT INTO handbook_version (id, server_id, text, source, created_at) VALUES ('v', 's', 't', 'page', 1)",
    ).run()
    expect(db.prepare("SELECT id FROM handbook_version").all()).toEqual([{ id: "v" }])
  })

  test("a version, the switch and the instructions of a channel mark themselves for sync, in a sync pair only", () => {
    // Outside a sync pair nothing is marked.
    const alone = upTo(HANDBOOK + 1)
    alone.exec(server)
    alone.exec("DELETE FROM sync_dirty")
    alone.exec("UPDATE agent SET read_handbook = 0")
    alone.exec("UPDATE channel SET instructions = 'Use lists.'")
    expect(alone.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([])

    const db = upTo(HANDBOOK + 1)
    db.exec(server)
    db.exec(pair)
    db.exec("DELETE FROM sync_dirty")
    db.exec("UPDATE agent SET read_handbook = 0")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([
      { kind: "agent", id: "a" },
    ])
    db.exec("DELETE FROM sync_dirty")
    db.exec("UPDATE channel SET instructions = 'Use lists.'")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([
      { kind: "channel", id: "c" },
    ])
    db.exec("DELETE FROM sync_dirty")
    db.exec(
      "INSERT INTO handbook_version (id, server_id, text, source, created_at) VALUES ('v', 's', 't', 'page', 1)",
    )
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([
      { kind: "hversion", id: "v" },
    ])
    // A removal of a version (the oldest one goes past 20) is marked too.
    db.exec("DELETE FROM sync_dirty")
    db.exec("DELETE FROM handbook_version WHERE id = 'v'")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([
      { kind: "hversion", id: "v" },
    ])
  })
})

describe("the step of the parent channel (spec 030)", () => {
  const PARENT = migrations.findIndex((sql) => sql.includes("ADD COLUMN parent_channel_id"))
  const server = `
    INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
  `

  test("it only adds one nullable column, once", () => {
    expect(PARENT).toBeGreaterThan(0)
    expect(migrations.filter((sql) => sql.includes("ADD COLUMN parent_channel_id"))).toHaveLength(1)
    const sql = migrations[PARENT] ?? ""
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE |NOT NULL/i)
    expect(sql).toContain("ALTER TABLE channel ADD COLUMN parent_channel_id TEXT;")
  })

  test("a channel from before it keeps its row, as a top channel", () => {
    const db = upTo(PARENT)
    db.exec(server)
    db.exec(`
      INSERT INTO channel (id, server_id, name, name_key, topic, lead_agent_id, created_at, updated_at)
        VALUES ('c', 's', 'Docs', 'docs', 'Write', NULL, 1, 1);
    `)
    db.exec(migrations[PARENT] as string)
    expect(db.prepare("SELECT id, name, topic, parent_channel_id FROM channel").all()).toEqual([
      { id: "c", name: "Docs", topic: "Write", parent_channel_id: null },
    ])
  })

  test("a change of the parent marks the channel for sync, in a sync pair", () => {
    const db = upTo(PARENT + 1)
    db.exec(server)
    db.exec(`
      INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
        VALUES ('p', 's', 'Product', 'product', '', 1, 1), ('c', 's', 'Docs', 'docs', '', 1, 1);
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
    `)
    db.exec("DELETE FROM sync_dirty")
    db.exec("UPDATE channel SET parent_channel_id = 'p' WHERE id = 'c'")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([
      { kind: "channel", id: "c" },
    ])
  })
})

describe("the step for the memory check", () => {
  /** The step that spec 008 added: the choice of an agent, the turns it counted, the source of a proposal. */
  const CHECK = migrations.findIndex((sql) => sql.includes("ADD COLUMN memory_check"))

  test("it comes after the steps that main had before it, so they run in their old places", () => {
    const handbook = migrations.findIndex((sql) => sql.includes("CREATE TABLE handbook_version"))
    expect(handbook).toBeGreaterThan(0)
    expect(CHECK).toBeGreaterThan(handbook)
  })

  test("it adds the choice, the count table and the mark of a proposal; sync carries none of them", () => {
    const sql = migrations[CHECK] ?? ""
    expect(sql).toContain("ADD COLUMN memory_check INTEGER NOT NULL DEFAULT 0")
    expect(sql).toContain("CREATE TABLE memory_check_turn")
    expect(sql).toContain("ADD COLUMN from_check INTEGER NOT NULL DEFAULT 0")
    // Spec 019: no trigger marks a row of the count table as changed.
    expect(sql).not.toMatch(/CREATE TRIGGER/i)
    expect(sql).not.toMatch(/sync_dirty/)
  })

  test("a database from before keeps its agents and proposals; every check is off and counts 0", () => {
    const db = upTo(CHECK)
    db.exec(`PRAGMA user_version = ${CHECK}`)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 1, 1);
      INSERT INTO memory_proposal (id, agent_id, text, created_at) VALUES ('p', 'a', 'Likes tea', 1);
    `)
    migrate(db)
    expect(db.prepare("SELECT memory_check FROM agent").get()).toEqual({ memory_check: 0 })
    expect(db.prepare("SELECT text, from_check FROM memory_proposal").get()).toEqual({
      text: "Likes tea",
      from_check: 0,
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_check_turn").get()).toEqual({ n: 0 })
  })

  test("a counted turn goes with its task and with its agent, and marks nothing for sync", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    migrate(db)
    db.exec(`
      INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
      INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, created_at, updated_at)
        VALUES ('a', 's', 'Ada', 'ada', '', '', 0, 0, '/w', 'agents', 1, 1);
      INSERT INTO task (id, agent_id, prompt, label, source, state, created_at)
        VALUES ('t1', 'a', 'x', 'x', 'chat', 'done', 1), ('t2', 'a', 'y', 'y', 'chat', 'done', 2);
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
    `)
    db.exec("DELETE FROM sync_dirty")
    db.exec(`
      INSERT INTO memory_check_turn (task_id, agent_id, at) VALUES ('t1', 'a', 1), ('t2', 'a', 2);
    `)
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_dirty").get()).toEqual({ n: 0 })
    db.exec("DELETE FROM task WHERE id = 't1'")
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_check_turn").get()).toEqual({ n: 1 })
    db.exec("DELETE FROM agent WHERE id = 'a'")
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_check_turn").get()).toEqual({ n: 0 })
  })
})

describe("the step of the part Organization (spec 030, S110)", () => {
  const ORG = migrations.findIndex((sql) => sql.includes("CREATE TABLE organization"))

  test("it makes one table, once, with one row that holds the default rule", () => {
    expect(ORG).toBeGreaterThan(0)
    expect(migrations.filter((sql) => sql.includes("CREATE TABLE organization"))).toHaveLength(1)
    // It drops nothing and changes no row that exists (the triggers name UPDATE and DELETE).
    expect(migrations[ORG] ?? "").not.toMatch(/DROP /i)
    const db = upTo(ORG)
    db.exec(migrations[ORG] as string)
    expect(db.prepare("SELECT id, hand_off, changed_at FROM organization").all()).toEqual([
      { id: "organization", hand_off: "any", changed_at: 0 },
    ])
  })

  test("the table takes the two known rules and one row only", () => {
    const db = upTo(ORG + 1)
    db.exec("UPDATE organization SET hand_off = 'channels'")
    expect(db.prepare("SELECT hand_off FROM organization").get()).toEqual({ hand_off: "channels" })
    expect(() => db.exec("UPDATE organization SET hand_off = 'all'")).toThrow()
    expect(() => db.exec("INSERT INTO organization (id) VALUES ('second')")).toThrow()
  })

  test("a change of the rule marks the row for sync, in a sync pair only", () => {
    const db = upTo(ORG + 1)
    db.exec("DELETE FROM sync_dirty")
    db.exec("UPDATE organization SET hand_off = 'channels'")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([])
    db.exec(`
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
    `)
    db.exec("UPDATE organization SET hand_off = 'any'")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([
      { kind: "org", id: "organization" },
    ])
  })
})

describe("the step of the tools and the daily token limit of a channel (spec 030)", () => {
  const LIMIT = migrations.findIndex((sql) => sql.includes("ADD COLUMN daily_token_limit"))
  const server = `
    INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0);
  `

  test("it only adds three columns that have a default, once, and drops or changes nothing", () => {
    expect(LIMIT).toBeGreaterThan(0)
    expect(migrations.filter((sql) => sql.includes("ADD COLUMN daily_token_limit"))).toHaveLength(1)
    const sql = migrations[LIMIT] ?? ""
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE /i)
    expect(sql).toContain("ALTER TABLE skill ADD COLUMN channels TEXT NOT NULL DEFAULT '[]';")
    expect(sql).toContain(
      "ALTER TABLE tool_connection ADD COLUMN channels TEXT NOT NULL DEFAULT '[]';",
    )
    expect(sql).toContain("ALTER TABLE channel ADD COLUMN daily_token_limit INTEGER;")
  })

  test("a skill, a connection and a channel from before keep their rows: no channel in a list, no limit", () => {
    const db = upTo(LIMIT)
    db.exec(server)
    db.exec(`
      INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
        VALUES ('c', 's', 'Docs', 'docs', 'Write', 1, 1);
      INSERT INTO skill (id, server_id, name, name_key, description, instructions, agents, enabled, created_at)
        VALUES ('k', 's', 'Notes', 'notes', '', 'Do it.', NULL, 1, 1);
      INSERT INTO tool_connection (id, server_id, name, name_key, kind, command, agents, enabled, created_at)
        VALUES ('t', 's', 'Journal', 'journal', 'program', 'journal-server', NULL, 1, 1);
    `)
    db.exec(migrations[LIMIT] as string)
    expect(db.prepare("SELECT id, name, daily_token_limit FROM channel").all()).toEqual([
      { id: "c", name: "Docs", daily_token_limit: null },
    ])
    expect(db.prepare("SELECT id, name, agents, channels FROM skill").all()).toEqual([
      { id: "k", name: "Notes", agents: null, channels: "[]" },
    ])
    expect(db.prepare("SELECT id, name, agents, channels FROM tool_connection").all()).toEqual([
      { id: "t", name: "Journal", agents: null, channels: "[]" },
    ])
  })

  test("a change of the limit marks the channel for sync; the lists of skills and connections do not sync", () => {
    const db = upTo(LIMIT + 1)
    db.exec(server)
    db.exec(`
      INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
        VALUES ('c', 's', 'Docs', 'docs', '', 1, 1);
      INSERT INTO skill (id, server_id, name, name_key, description, instructions, agents, channels, enabled, created_at)
        VALUES ('k', 's', 'Notes', 'notes', '', 'Do it.', '[]', '[]', 1, 1);
      INSERT INTO tool_connection (id, server_id, name, name_key, kind, command, agents, channels, enabled, created_at)
        VALUES ('t', 's', 'Journal', 'journal', 'program', 'journal-server', '[]', '[]', 1, 1);
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
    `)
    db.exec("DELETE FROM sync_dirty")
    db.exec("UPDATE skill SET channels = '[\"c\"]' WHERE id = 'k'")
    db.exec("UPDATE tool_connection SET channels = '[\"c\"]' WHERE id = 't'")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([])
    db.exec("UPDATE channel SET daily_token_limit = 50000 WHERE id = 'c'")
    expect(db.prepare("SELECT kind, id FROM sync_dirty").all()).toEqual([
      { kind: "channel", id: "c" },
    ])
  })
})
