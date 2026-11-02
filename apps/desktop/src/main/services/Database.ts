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

const open = (file: string) => {
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)
  return db
}

export const migrate = (db: DatabaseSync) => {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
  for (let version = row.user_version; version < migrations.length; version++) {
    db.exec("BEGIN")
    try {
      db.exec(migrations[version] ?? "")
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
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
