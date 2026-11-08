import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { redactSecrets } from "@robot/shared"

/** The logs that the app writes. */
export type LogName =
  | "channels"
  | "organizations"
  | "teams"
  | "outside"
  | "browser"
  | "app"
  | "workflows"

/** How long the outside-programs log and the Teams-link log keep a line (spec 014, 023, 028). */
export const LINK_LOG_KEEP_MS = 90 * 24 * 60 * 60 * 1000

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
 * One call of an outside program (spec 023): the entry, the tool, the workflow or task, and the
 * result. The line holds no message text and no key (spec 014).
 */
export const logOutsideCall = (
  dataDir: string,
  call: { entry: string; tool: string; workflow?: string; task?: string; result: string },
) => {
  appendLog(dataDir, "outside", {
    event: "call",
    entry: call.entry,
    tool: call.tool,
    ...(call.workflow === undefined ? {} : { workflow: call.workflow }),
    ...(call.task === undefined ? {} : { task: call.task }),
    result: redactSecrets(call.result),
  })
}

/**
 * One event of the Teams link (spec 028): the event, the reason, and the place. The line holds
 * no message text and no sender name (spec 014).
 */
export const logTeamsEvent = (
  dataDir: string,
  event: { event: string; reason: string; place: string },
) => {
  // Each field is picked by hand: a wider caller object must not leak text or a name
  // into the log (spec 014, 028).
  appendLog(dataDir, "teams", {
    event: event.event,
    reason: redactSecrets(event.reason),
    place: event.place,
  })
}

/**
 * Drops the lines older than 90 days from the outside-programs log and the Teams-link log
 * (spec 014, 023, 028). The app runs this at startup. A prune that fails is dropped.
 */
export const pruneOldLogs = (dataDir: string, now: number = Date.now()) => {
  pruneLog(dataDir, "outside", LINK_LOG_KEEP_MS, now)
  pruneLog(dataDir, "teams", LINK_LOG_KEEP_MS, now)
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
