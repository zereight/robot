import type { DatabaseService } from "./Database.ts"

/**
 * Reads and writes an object as one row per field in a two-column table. Fields that are
 * missing or have the wrong type take their default, so new fields need no migration.
 */
export const keyValueTable = <T extends object>(
  db: DatabaseService,
  table: "setting" | "ui_state",
  defaults: T,
  isValid: (value: T) => boolean,
) => {
  const read = (): T => {
    const rows = db.all<{ key: string; value: string }>(`SELECT key, value FROM ${table}`)
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]))
    const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) }
    for (const key of Object.keys(defaults)) {
      if (!(key in stored)) continue
      const candidate = { ...result, [key]: stored[key] }
      if (isValid(candidate as T)) result[key] = stored[key]
    }
    return result as T
  }

  const write = (patch: Partial<T>) =>
    db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        db.run(
          `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          key,
          JSON.stringify(value),
        )
      }
    })

  return { read, write }
}
