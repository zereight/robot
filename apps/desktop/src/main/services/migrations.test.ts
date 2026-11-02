import { describe, expect, test } from "bun:test"
import { DatabaseSync } from "node:sqlite"
import { migrations } from "./migrations.ts"

/** The index of the migration that S27 added: the notes of a workflow. */
const NOTES = 13

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
    expect(migrations).toHaveLength(NOTES + 1)
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
