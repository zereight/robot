import { describe, expect, test } from "bun:test"
import { openDatabase } from "./Database.ts"

describe("Database", () => {
  test("a frozen database reads, takes no writes, and calls no write listener", () => {
    const db = openDatabase(":memory:")
    db.run("INSERT INTO mute (kind, id, until) VALUES ('server', 'a', 1)")
    let writes = 0
    db.onWrite(() => writes++)
    db.freeze()
    db.run("INSERT INTO mute (kind, id, until) VALUES ('server', 'b', 2)")
    db.run("UPDATE mute SET until = 9 WHERE id = 'a'")
    expect(db.all<{ id: string; until: number }>("SELECT id, until FROM mute")).toEqual([
      { id: "a", until: 1 },
    ])
    expect(writes).toBe(0)
    // A transaction still runs and ends; its writes do nothing.
    expect(db.transaction(() => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mute")?.n)).toBe(1)
  })
})
