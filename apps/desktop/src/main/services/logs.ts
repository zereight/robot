import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The logs that the app writes. */
export type LogName = "channels" | "teams" | "browser"

/** The size limit of one log file. When a file grows past it, the oldest lines go first. */
export const LOG_MAX_BYTES = 256 * 1024

/**
 * Adds one line to a log file in the logs folder of the data folder (spec 014). A log never
 * breaks the work that it records: a write that fails is dropped.
 */
export const appendLog = (
  dataDir: string,
  name: LogName,
  entry: Record<string, unknown>,
  maxBytes = LOG_MAX_BYTES,
) => {
  try {
    const dir = join(dataDir, "logs")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.log`)
    appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
    if (statSync(file).size <= maxBytes) return
    // Keep the newest lines in three quarters of the limit, so the next line does not cut again.
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    const kept: string[] = []
    let size = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as string
      const bytes = Buffer.byteLength(line) + 1
      if (size + bytes > maxBytes * 0.75) break
      kept.unshift(line)
      size += bytes
    }
    writeFileSync(file, kept.length ? `${kept.join("\n")}\n` : "")
  } catch {
    // Dropped on purpose.
  }
}

/**
 * Removes the lines of a log that are older than `maxAgeMs`, as the time of the line tells
 * (spec 014: the link log keeps 90 days). A line with no readable time stays. A log that cannot be
 * read or written is left as it is.
 */
export const pruneLog = (dataDir: string, name: LogName, maxAgeMs: number, now: number) => {
  try {
    const file = join(dataDir, "logs", `${name}.log`)
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    const kept = lines.filter((line) => {
      try {
        const time = Date.parse(String((JSON.parse(line) as { time?: unknown }).time))
        return Number.isNaN(time) || now - time <= maxAgeMs
      } catch {
        return true
      }
    })
    if (kept.length !== lines.length) writeFileSync(file, kept.length ? `${kept.join("\n")}\n` : "")
  } catch {
    // Dropped on purpose.
  }
}

/**
 * The newest `count` lines of a log, oldest first. A log that is not there, or cannot be read, has
 * no lines.
 */
export const readLogTail = (dataDir: string, name: LogName, count: number): string[] => {
  try {
    const lines = readFileSync(join(dataDir, "logs", `${name}.log`), "utf8").split("\n")
    return lines.filter(Boolean).slice(-count)
  } catch {
    return []
  }
}
