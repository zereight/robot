import { describe, expect, test } from "bun:test"
import { HOLD_MAX_MS, HOLD_UNKNOWN_MS, holdEnd, safeResetTime } from "./backup.ts"

const now = 1_800_000_000_000

describe("the end of a hold (spec 006)", () => {
  test("a reset time in the near future is the end", () => {
    expect(holdEnd(now, now + 7_200_000)).toBe(now + 7_200_000)
  })

  test("no time, null, a past time and the present give 15 minutes", () => {
    for (const value of [undefined, null, now - 1, now, 0, -1])
      expect(holdEnd(now, value)).toBe(now + HOLD_UNKNOWN_MS)
  })

  test("a time that is not a number, not finite or negative gives 15 minutes", () => {
    for (const value of [
      Number.NaN,
      Infinity,
      -Infinity,
      -1e17,
      "2999-01-01",
      {},
      "1e17",
    ] as unknown as number[])
      expect(holdEnd(now, value)).toBe(now + HOLD_UNKNOWN_MS)
  })

  test("a time past one day is cut to one day, whatever its size", () => {
    for (const value of [
      now + HOLD_MAX_MS + 1,
      now + 365 * 86_400_000,
      8.64e15,
      9e15,
      2 ** 53,
      1e17,
      1e300,
      Number.MAX_VALUE,
    ])
      expect(holdEnd(now, value)).toBe(now + HOLD_MAX_MS)
  })

  test("exactly one day is kept, and a float is made whole", () => {
    expect(holdEnd(now, now + HOLD_MAX_MS)).toBe(now + HOLD_MAX_MS)
    expect(holdEnd(now, now + 1000.2)).toBe(now + 1001)
    expect(Number.isInteger(holdEnd(now, now + 0.5))).toBe(true)
  })

  test("the end is always a time that a date can hold", () => {
    for (const value of [1e17, 1e300, Infinity, Number.NaN, -1])
      expect(Number.isNaN(new Date(holdEnd(now, value)).getTime())).toBe(false)
  })
})

describe("a reset time that a provider names", () => {
  test("is null when it cannot be used", () => {
    for (const value of [undefined, null, "x", Number.NaN, Infinity, now - 5])
      expect(safeResetTime(now, value)).toBeNull()
  })
  test("is cut to one day ahead", () => {
    expect(safeResetTime(now, now + 10 * HOLD_MAX_MS)).toBe(now + HOLD_MAX_MS)
  })
})
