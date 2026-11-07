import { describe, expect, test } from "bun:test"
import { HOLD_MAX_MS, holdEnd } from "@robot/shared"
import { formatDateTime, isCalendarTime } from "./format.ts"

describe("the format of a date and a time", () => {
  test("a hold that is cut to one day shows a time", () => {
    const now = Date.now()
    const until = holdEnd(now, 1e17)
    expect(until).toBe(now + HOLD_MAX_MS)
    expect(formatDateTime("en", until)).not.toBe("")
    expect(formatDateTime("ko", until)).not.toBe("")
  })

  test("a number that no date can hold gives an empty text and never throws", () => {
    for (const value of [8.64e15 + 1, 1e17, 1e300, Number.NaN, Infinity, -Infinity, -1e17])
      expect(formatDateTime("en", value)).toBe("")
    expect(isCalendarTime(8.64e15)).toBe(true)
    expect(isCalendarTime(8.64e15 + 1)).toBe(false)
  })
})
