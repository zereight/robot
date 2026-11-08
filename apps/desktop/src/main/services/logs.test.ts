import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendLog,
  LINK_LOG_KEEP_MS,
  LOG_MAX_BYTES,
  logOutsideCall,
  logTeamsEvent,
  pruneLog,
  pruneOldLogs,
} from "./logs.ts"

/** A data folder of the test, apart from the data of the user. */
const dataDir = () => mkdtempSync(join(tmpdir(), "robot-logs-"))

/** The event of a log line, or the line itself when it holds no event. */
const eventOf = (line: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed !== null && typeof parsed === "object" && "event" in parsed) return parsed.event
    return line
  } catch {
    return line
  }
}

const timeOf = (line: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed !== null && typeof parsed === "object" && "time" in parsed) return parsed.time
    return undefined
  } catch {
    return undefined
  }
}

describe("appendLog rotation (spec 014)", () => {
  test("a line holds the time and the entry", () => {
    const dir = dataDir()
    appendLog(dir, "workflows", { event: "one", n: 1 })
    const [line] = readFileSync(join(dir, "logs", "workflows.log"), "utf8")
      .split("\n")
      .filter(Boolean)
    expect(JSON.parse(line ?? "{}")).toMatchObject({ event: "one", n: 1 })
    expect(typeof timeOf(line ?? "")).toBe("string")
    expect(LOG_MAX_BYTES).toBeGreaterThan(0)
  })

  test("past the size limit the oldest lines go first and the newest stay", () => {
    const dir = dataDir()
    appendLog(dir, "workflows", { event: "first" })
    for (let i = 0; i < 400; i++)
      appendLog(dir, "workflows", { event: "line", n: i, pad: "x".repeat(1000) }, 64 * 1024)
    const text = readFileSync(join(dir, "logs", "workflows.log"), "utf8")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024)
    const lines = text.trim().split("\n")
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ n: 399 })
    expect(text).not.toContain('"event":"first"')
  })
})

describe("pruneLog dates (spec 014: the link log keeps 90 days)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const now = Date.parse("2026-11-09T00:00:00.000Z")

  /** A log with one old line, one fresh line, one line with no time, and one broken line. */
  const seed = (dir: string) => {
    mkdirSync(join(dir, "logs"), { recursive: true })
    writeFileSync(
      join(dir, "logs", "teams.log"),
      [
        JSON.stringify({ time: new Date(now - 91 * DAY_MS).toISOString(), event: "old" }),
        JSON.stringify({ time: new Date(now - 89 * DAY_MS).toISOString(), event: "fresh" }),
        JSON.stringify({ event: "no-time" }),
        "not-json{",
      ]
        .join("\n")
        .concat("\n"),
    )
  }

  const eventsOf = (dir: string): unknown[] =>
    readFileSync(join(dir, "logs", "teams.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(eventOf)

  test("lines older than the limit go, the rest stays", () => {
    const dir = dataDir()
    seed(dir)
    pruneLog(dir, "teams", 90 * DAY_MS, now)
    const events = eventsOf(dir)
    expect(events).toContain("fresh")
    expect(events).toContain("no-time")
    expect(events).toContain("not-json{")
    expect(events).not.toContain("old")
  })

  test("a line on the edge of the limit stays", () => {
    const dir = dataDir()
    seed(dir)
    pruneLog(dir, "teams", 91 * DAY_MS, now)
    expect(eventsOf(dir)).toContain("old")
  })
})

describe("audit logs (spec 014, 023, 028)", () => {
  test("an outside call writes the entry, the tool, the place, and the result", () => {
    const dir = dataDir()
    logOutsideCall(dir, {
      entry: "helper",
      tool: "List workflows",
      workflow: "Weekly report",
      result: "ok",
    })
    const [line] = readFileSync(join(dir, "logs", "outside.log"), "utf8")
      .split("\n")
      .filter(Boolean)
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      entry: "helper",
      tool: "List workflows",
      workflow: "Weekly report",
      result: "ok",
    })
  })

  test("an outside call hides a key in the result", () => {
    const dir = dataDir()
    logOutsideCall(dir, {
      entry: "helper",
      tool: "Read a task",
      task: "task-1",
      result: "key sk-abcdefgh12345678 here",
    })
    const text = readFileSync(join(dir, "logs", "outside.log"), "utf8")
    expect(text).not.toContain("sk-abcdefgh12345678")
    expect(text).toContain("[redacted]")
  })

  test("a Teams event writes the event, the reason, and the place, with no name and no text", () => {
    const dir = dataDir()
    logTeamsEvent(dir, { event: "answered", reason: "call", place: "Work chat" })
    const [line] = readFileSync(join(dir, "logs", "teams.log"), "utf8")
      .split("\n")
      .filter(Boolean)
    const entry = JSON.parse(line ?? "{}") as Record<string, unknown>
    expect(entry).toMatchObject({ event: "answered", reason: "call", place: "Work chat" })
    expect("text" in entry).toBe(false)
    expect("sender" in entry).toBe(false)
    expect("name" in entry).toBe(false)
  })

  test("pruneOldLogs drops lines older than 90 days from both link logs", () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const now = Date.parse("2026-11-09T00:00:00.000Z")
    expect(LINK_LOG_KEEP_MS).toBe(90 * DAY_MS)
    const dir = dataDir()
    mkdirSync(join(dir, "logs"), { recursive: true })
    for (const name of ["outside", "teams"]) {
      const oldLine = JSON.stringify({
        time: new Date(now - 91 * DAY_MS).toISOString(),
        event: "old",
      })
      const freshLine = JSON.stringify({
        time: new Date(now - DAY_MS).toISOString(),
        event: "fresh",
      })
      writeFileSync(join(dir, "logs", `${name}.log`), `${oldLine}\n${freshLine}\n`)
    }
    pruneOldLogs(dir, now)
    for (const name of ["outside", "teams"]) {
      const text = readFileSync(join(dir, "logs", `${name}.log`), "utf8")
      expect(text).not.toContain('"event":"old"')
      expect(text).toContain('"event":"fresh"')
    }
  })
})
