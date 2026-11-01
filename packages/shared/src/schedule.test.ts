import { describe, expect, test } from "bun:test"
import {
  dueRuns,
  MISSED_MAX_MS,
  parseCron,
  parseTime,
  runTimes,
  type Schedule,
  validSchedule,
} from "./schedule.ts"

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime()
const MIN = 60_000

describe("runTimes", () => {
  test("every N minutes counts from the start time", () => {
    const s: Schedule = { kind: "every", minutes: 2, from: at(2026, 1, 1, 10, 0) }
    expect(runTimes(s, at(2026, 1, 1, 10, 0), 3)).toEqual([
      at(2026, 1, 1, 10, 2),
      at(2026, 1, 1, 10, 4),
      at(2026, 1, 1, 10, 6),
    ])
    expect(runTimes(s, at(2026, 1, 1, 9, 0), 1)).toEqual([at(2026, 1, 1, 10, 0)])
  })
  test("daily at several times, sorted, in the local zone", () => {
    const s: Schedule = { kind: "daily", times: ["18:30", "09:00"] }
    expect(runTimes(s, at(2026, 3, 1, 10, 0), 3)).toEqual([
      at(2026, 3, 1, 18, 30),
      at(2026, 3, 2, 9, 0),
      at(2026, 3, 2, 18, 30),
    ])
  })
  test("weekly on days at a time", () => {
    // 2026-03-02 is a Monday.
    const s: Schedule = { kind: "weekly", days: [1, 3], time: "08:15" }
    expect(runTimes(s, at(2026, 3, 2, 9, 0), 2)).toEqual([
      at(2026, 3, 4, 8, 15),
      at(2026, 3, 9, 8, 15),
    ])
  })
  test("once runs one time, and not after it passed", () => {
    const s: Schedule = { kind: "once", at: at(2026, 5, 5, 12, 0) }
    expect(runTimes(s, at(2026, 5, 5, 11, 0), 3)).toEqual([s.at])
    expect(runTimes(s, s.at, 3)).toEqual([])
  })
  test("cron: lists, ranges and steps", () => {
    const s: Schedule = { kind: "cron", expr: "*/15 9-10 * * 1-5" }
    expect(runTimes(s, at(2026, 3, 2, 9, 40), 3)).toEqual([
      at(2026, 3, 2, 9, 45),
      at(2026, 3, 2, 10, 0),
      at(2026, 3, 2, 10, 15),
    ])
    // Saturday and Sunday are skipped.
    expect(runTimes(s, at(2026, 3, 6, 10, 50), 1)).toEqual([at(2026, 3, 9, 9, 0)])
  })
  test("until limits the list", () => {
    const s: Schedule = { kind: "every", minutes: 10, from: 0 }
    expect(runTimes(s, 0, 100, 35 * MIN)).toEqual([10 * MIN, 20 * MIN, 30 * MIN])
  })
})

describe("validation", () => {
  test("rejects bad input", () => {
    expect(parseTime("24:00")).toBeNull()
    expect(parseTime("9:05")).toBe(545)
    expect(parseCron("* * * *")).toBeNull()
    expect(parseCron("61 * * * *")).toBeNull()
    expect(validSchedule({ kind: "every", minutes: 0, from: 0 })).toBe(false)
    expect(validSchedule({ kind: "weekly", days: [], time: "09:00" })).toBe(false)
    expect(validSchedule({ kind: "daily", times: ["25:00"] })).toBe(false)
  })
})

describe("dueRuns", () => {
  const s: Schedule = { kind: "every", minutes: 10, from: 0 }
  test("a normal check starts the one run", () => {
    expect(dueRuns(s, 9 * MIN, 10 * MIN + 5000)).toEqual({ start: 10 * MIN, missed: [] })
  })
  test("after sleeping through 3 runs, one starts and two are missed", () => {
    expect(dueRuns(s, 9 * MIN, 31 * MIN)).toEqual({ start: 30 * MIN, missed: [10 * MIN, 20 * MIN] })
  })
  test("a run more than 12 hours late is missed, not started", () => {
    const late = 13 * 60 * MIN
    const r = dueRuns({ kind: "once", at: 5 * MIN }, 0, late)
    expect(r).toEqual({ start: null, missed: [5 * MIN] })
    expect(MISSED_MAX_MS).toBe(12 * 60 * MIN)
  })
})
