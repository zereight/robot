import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The size limit of one log file. When a file grows past it, the oldest lines go first. */
export const LOG_MAX_BYTES = 256 * 1024

/**
 * Adds one line to a log file in the logs folder of the data folder (spec 014). A log never
 * breaks the work that it records: a write that fails is dropped.
 */
export const appendLog = (
  dataDir: string,
  name: "channels",
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
