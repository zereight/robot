import { existsSync, rmSync } from "node:fs"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Context, Effect, Layer } from "effect"
import { migrations } from "./migrations.ts"

export type Row = Record<string, SQLInputValue>
type Params = readonly SQLInputValue[]

export interface DatabaseService {
  /** Runs a statement that returns no rows. */
  run(sql: string, ...params: Params): void
  all<T = Row>(sql: string, ...params: Params): T[]
  get<T = Row>(sql: string, ...params: Params): T | undefined
  /** Runs `body` in one transaction. A thrown error rolls it back. */
  transaction<T>(body: () => T): T
  /** Calls `listener` after every statement that wrote. Sync uses it to look for changes. */
  onWrite(listener: () => void): void
  /**
   * From now on `run` writes nothing. The app calls it when it starts to close: work that the
   * quit cuts off must not record itself as stopped or failed, because the next start reads the
   * data as it was (spec 005, a card that waits stays).
   */
  freeze(): void
}

/**
 * The local SQLite database. All calls are synchronous: `node:sqlite` is synchronous and
 * the main process owns the only connection.
 */
export class Database extends Context.Service<Database, DatabaseService>()("robot/main/Database") {
  static readonly layer = (file: string) =>
    Layer.effect(
      Database,
      Effect.acquireRelease(
        Effect.sync(() => open(file)),
        (db) => Effect.sync(() => db.close()),
      ).pipe(Effect.map(wrap)),
    )
}

/**
 * The application id of a database in the workflow schema ("ROB1"). A database from before has no
 * id and a user version above 0: it holds agents, routines and chats of the old model.
 */
export const SCHEMA_ID = 0x524f4231

/**
 * What a database file holds:
 * - `fresh`: no file, or an empty one.
 * - `legacy`: the old model (no workflow id, user version above 0).
 * - `current`: the workflow model, with a version that this app knows.
 * - `newer`: the workflow model, with a version that a later app made.
 */
export type FileState = "fresh" | "legacy" | "current" | "newer"

/** The data in the file comes from a newer version of the app. The app does not touch it. */
export class NewerDatabaseError extends Error {
  readonly code = "database.newer"
  constructor() {
    super("The data folder comes from a newer version of the app.")
    this.name = "NewerDatabaseError"
  }
}

/** Reads the state of a database file. It changes nothing. */
export const fileState = (file: string): FileState => {
  if (file === ":memory:" || file === "" || !existsSync(file)) return "fresh"
  const db = new DatabaseSync(file)
  try {
    const id = (db.prepare("PRAGMA application_id").get() as { application_id: number })
      .application_id
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version
    if (id === SCHEMA_ID) return version > migrations.length ? "newer" : "current"
    return version > 0 ? "legacy" : "fresh"
  } finally {
    db.close()
  }
}

/**
 * Erases a database from before the workflow model. Owner decision (2026-11-07): the whole
 * database goes at the first start of the new version, with the settings, the provider accounts,
 * the skills, the connections and the linked devices. No backup stays, and a phone pairs again. The
 * file and its journal files go, so no old row stays on the disk. Only the database goes. The
 * folders of workflows and the attachments next to it stay. The secrets in the keychain stay too,
 * and nothing refers to them any more. A database from a newer app is never erased.
 */
const eraseLegacy = (file: string) => {
  const state = fileState(file)
  if (state === "newer") throw new NewerDatabaseError()
  if (state !== "legacy") return
  for (const name of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    rmSync(name, { force: true })
  }
}

const open = (file: string) => {
  eraseLegacy(file)
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)
  return db
}

export const migrate = (db: DatabaseSync) => {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
  if (row.user_version === 0) db.exec(`PRAGMA application_id = ${SCHEMA_ID}`)
  for (let version = row.user_version; version < migrations.length; version++) {
    // A migration that makes a table again (SQLite has no way to change a CHECK) drops the old
    // table. With the foreign keys on, the drop would delete the rows that refer to it, so the
    // keys stay off while a migration runs. `foreign_key_check` before the commit keeps the guard:
    // a migration that breaks a key is rolled back.
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN")
    try {
      db.exec(migrations[version] ?? "")
      const broken = db.prepare("PRAGMA foreign_key_check").get()
      if (broken !== undefined) throw new Error(`Migration ${version + 1} breaks a foreign key.`)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    } finally {
      db.exec("PRAGMA foreign_keys = ON")
    }
  }
}

/** Opens a database and runs the migrations. Tests use it to make a database of their own. */
export const openDatabase = (file: string): DatabaseService => wrap(open(file))

const wrap = (db: DatabaseSync): DatabaseService => {
  let depth = 0
  let frozen = false
  const writeListeners: (() => void)[] = []
  return {
    freeze: () => {
      frozen = true
    },
    run: (sql, ...params) => {
      if (frozen) return
      db.prepare(sql).run(...params)
      for (const listener of writeListeners) listener()
    },
    onWrite: (listener) => {
      writeListeners.push(listener)
    },
    all: <T>(sql: string, ...params: Params) => db.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, ...params: Params) => db.prepare(sql).get(...params) as T | undefined,
    transaction: (body) => {
      if (depth > 0) return body()
      depth++
      db.exec("BEGIN")
      try {
        const result = body()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      } finally {
        depth--
      }
    },
  }
}
