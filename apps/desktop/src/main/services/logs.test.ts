import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendLog, LOG_MAX_BYTES, pruneLog } from "./logs.ts"

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
