import { describe, expect, test } from "bun:test"
import {
  dueRuns,
  MISSED_MAX_MS,
  parseCron,
  parseTime,
  runsPerDayNote,
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

describe("runsPerDayNote (spec 009: a schedule under 15 minutes shows how often it runs)", () => {
  const now = at(2026, 3, 4, 10, 0)
  const note = (s: Schedule) => runsPerDayNote(s, now)

  test("every 5 minutes runs about 288 times a day", () => {
    expect(note({ kind: "every", minutes: 5, from: now })).toBe(288)
  })
  test("every minute and every 14 minutes show it; every 15 minutes does not", () => {
    expect(note({ kind: "every", minutes: 1, from: now })).toBe(1440)
    expect(note({ kind: "every", minutes: 14, from: now })).toBe(103)
    expect(note({ kind: "every", minutes: 15, from: now })).toBeNull()
    expect(note({ kind: "every", minutes: 60, from: now })).toBeNull()
  })
  test("a daily schedule shows it only when two times are under 15 minutes apart", () => {
    expect(note({ kind: "daily", times: ["09:00"] })).toBeNull()
    expect(note({ kind: "daily", times: ["09:00", "18:30"] })).toBeNull()
    expect(note({ kind: "daily", times: ["09:00", "09:15"] })).toBeNull()
    expect(note({ kind: "daily", times: ["09:00", "09:14", "18:00"] })).toBe(3)
    // The same time twice is one run time.
    expect(note({ kind: "daily", times: ["09:00", "09:00"] })).toBeNull()
  })
  test("the last time of a day and the first of the next count as two runs in a row", () => {
    expect(note({ kind: "daily", times: ["00:05", "23:55"] })).toBe(2)
  })
  test("a cron schedule counts the runs of a full day", () => {
    expect(note({ kind: "cron", expr: "*/5 * * * *" })).toBe(288)
    expect(note({ kind: "cron", expr: "* * * * *" })).toBe(1440)
    // The busiest day: 9:00 to 9:59 every 10 minutes, on weekdays and weekends alike.
    expect(note({ kind: "cron", expr: "*/10 9 * * *" })).toBe(6)
    expect(note({ kind: "cron", expr: "0 9 * * 1-5" })).toBeNull()
    expect(note({ kind: "cron", expr: "*/30 * * * *" })).toBeNull()
  })
  test("a cron schedule that runs on some days counts the busiest of them", () => {
    // 2026-03-04 is a Wednesday. Only Mondays run, and the next Monday is inside 7 days.
    expect(note({ kind: "cron", expr: "*/5 9-10 * * 1" })).toBe(24)
  })
  test("once, weekly and a schedule that is not valid never show it", () => {
    expect(note({ kind: "once", at: now + 1000 })).toBeNull()
    expect(note({ kind: "weekly", days: [1, 2, 3], time: "09:00" })).toBeNull()
    expect(note({ kind: "every", minutes: 0, from: now })).toBeNull()
    expect(note({ kind: "cron", expr: "nope" })).toBeNull()
  })
})
