import { describe, expect, test } from "bun:test"
import {
  ageOnArrival,
  compareStamps,
  HybridClock,
  readStamp,
  STAMP_FUTURE_MS,
  type Stamp,
} from "./clock.ts"

const clock = (node: string, wall: { now: number }, start = { l: 0, c: 0 }) =>
  new HybridClock(
    node,
    start,
    () => {},
    () => wall.now,
  )

describe("the order of changes", () => {
  test("a later time wins; equal times break by the counter, then by the device id", () => {
    const a: Stamp = { l: 10, c: 0, n: "a" }
    expect(compareStamps({ l: 11, c: 0, n: "a" }, a)).toBeGreaterThan(0)
    expect(compareStamps({ l: 10, c: 1, n: "a" }, a)).toBeGreaterThan(0)
    expect(compareStamps({ l: 10, c: 0, n: "b" }, a)).toBeGreaterThan(0)
    expect(compareStamps(a, { ...a })).toBe(0)
  })

  test("both computers pick the same winner of two stamps", () => {
    const x: Stamp = { l: 5, c: 2, n: "mac-1" }
    const y: Stamp = { l: 5, c: 2, n: "mac-2" }
    expect(Math.sign(compareStamps(x, y))).toBe(-Math.sign(compareStamps(y, x)))
  })

  test("a stamp never goes down, also when the wall clock goes back", () => {
    const wall = { now: 1000 }
    const c = clock("a", wall)
    const first = c.tick()
    wall.now = 500
    const second = c.tick()
    const third = c.tick()
    expect(compareStamps(second, first)).toBeGreaterThan(0)
    expect(compareStamps(third, second)).toBeGreaterThan(0)
  })

  test("a change made after seeing another change always has the larger stamp", () => {
    // The clock of the other computer is 10 minutes ahead.
    const here = { now: 1_000 }
    const there = { now: 1_000 + 600_000 }
    const a = clock("a", here)
    const b = clock("b", there)
    const seen = b.tick()
    a.observe(seen)
    const after = a.tick()
    expect(compareStamps(after, seen)).toBeGreaterThan(0)
  })

  test("two changes made apart: the later wall time wins, whichever computer asks", () => {
    const a = clock("a", { now: 2_000 })
    const b = clock("b", { now: 3_000 })
    const x = a.tick()
    const y = b.tick()
    expect(compareStamps(y, x)).toBeGreaterThan(0)
  })

  test("the state is saved with every stamp", () => {
    const saved: { l: number; c: number }[] = []
    const c = new HybridClock(
      "a",
      { l: 0, c: 0 },
      (s) => saved.push(s),
      () => 7,
    )
    c.tick()
    c.tick()
    expect(saved).toEqual([
      { l: 7, c: 0 },
      { l: 7, c: 1 },
    ])
  })

  test("a stamp from the other computer must have the right shape and not lie far in the future", () => {
    const now = 1_700_000_000_000
    const limit = now + STAMP_FUTURE_MS
    expect(readStamp([now, 0, "dev"], limit)).toEqual({ l: now, c: 0, n: "dev" })
    expect(readStamp([limit + 1, 0, "dev"], limit)).toBeUndefined()
    expect(readStamp([now, 0], limit)).toBeUndefined()
    expect(readStamp([now, -1, "dev"], limit)).toBeUndefined()
    expect(readStamp([now, 0, ""], limit)).toBeUndefined()
    expect(readStamp([now, 0.5, "dev"], limit)).toBeUndefined()
    expect(readStamp(["1", 0, "dev"], limit)).toBeUndefined()
    expect(readStamp({ l: now, c: 0, n: "dev" }, limit)).toBeUndefined()
  })

  test("the age of a message uses the clock difference that was measured, not the raw stamps", () => {
    const now = 1_700_000_000_000
    const minute = 60_000
    // Clocks that agree: the age is the plain difference.
    expect(ageOnArrival(now - minute, now, 0)).toBe(minute)
    // The other clock is 2 hours ahead. A message made 30 seconds ago carries a stamp in the future
    // of this computer, but it is young.
    const ahead = 2 * 60 * minute
    expect(ageOnArrival(now + ahead - 30_000, now, ahead)).toBe(30_000)
    // The same clock, and a message made 10 minutes ago: it is old, though the raw stamp is ahead.
    expect(ageOnArrival(now + ahead - 10 * minute, now, ahead)).toBe(10 * minute)
    // The other clock is 2 hours behind. A message made 30 seconds ago looks 2 hours old.
    expect(ageOnArrival(now - ahead - 30_000, now, -ahead)).toBe(30_000)
  })
})
