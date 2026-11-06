import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openDatabase, SCHEMA_ID } from "./services/Database.ts"
import { migrations } from "./services/migrations.ts"
import { describeStartFailure } from "./startup.ts"

const folder = () => mkdtempSync(join(tmpdir(), "robot-start-"))

/** The error that the app meets when it opens the file, or undefined when the file opens. */
const openError = (file: string): unknown => {
  try {
    openDatabase(file)
  } catch (error) {
    return error
  }
  return undefined
}

describe("a data file that cannot be opened at the start", () => {
  test("a damaged file gives the text about a damaged file, with the path", () => {
    const file = join(folder(), "robot.db")
    writeFileSync(file, "this is not a database, it is only text ".repeat(50))
    const error = openError(file)
    expect(error).toBeDefined()
    const problem = describeStartFailure(file, error)
    expect(problem.message).toBe("error.database_failed")
    expect(problem.title).toBe("error.database_failed.title")
    expect(problem.params.path).toBe(file)
    expect(problem.params.detail).not.toBe("")
  })

  test("a file that this account may not read gives the same text", () => {
    if (process.getuid?.() === 0) return // root reads every file
    const dir = folder()
    const file = join(dir, "robot.db")
    openDatabase(file)
    chmodSync(file, 0o000)
    try {
      const error = openError(file)
      expect(error).toBeDefined()
      expect(describeStartFailure(file, error).message).toBe("error.database_failed")
    } finally {
      chmodSync(file, 0o600)
    }
  })

  test("a folder that this account may not write gives the same text", () => {
    if (process.getuid?.() === 0) return
    const dir = join(folder(), "locked")
    mkdirSync(dir)
    chmodSync(dir, 0o500)
    try {
      const file = join(dir, "robot.db")
      const error = openError(file)
      expect(error).toBeDefined()
      expect(describeStartFailure(file, error).message).toBe("error.database_failed")
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  test("data from a newer version gets its own text, and the file is not changed", () => {
    const file = join(folder(), "robot.db")
    const made = new DatabaseSync(file)
    made.exec(
      `PRAGMA application_id = ${SCHEMA_ID}; PRAGMA user_version = ${migrations.length + 5}`,
    )
    made.close()
    const error = openError(file)
    expect(error).toBeDefined()
    expect(describeStartFailure(file, error).message).toBe("error.database_newer")
    const again = new DatabaseSync(file)
    expect(
      (again.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(migrations.length + 5)
    again.close()
  })
})
