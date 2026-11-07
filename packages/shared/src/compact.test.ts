import { describe, expect, test } from "bun:test"
import {
  COMPACT_AT_TOKENS,
  COMPACT_PAUSE_TURNS,
  compactCut,
  compactDue,
  HOUR_CACHE_MS,
  hourCacheEnded,
  meterShare,
  pauseLeft,
  shouldAutoCompact,
} from "./compact.ts"

describe("compactCut", () => {
  const u = "user" as const
  const a = "assistant" as const
  test("keeps the newest 2 turns, and nothing to compact at 2 turns or fewer", () => {
    expect(compactCut([])).toBeNull()
    expect(compactCut([u, a, u, a])).toBeNull()
    expect(compactCut([u, a, u, a, u, a])).toBe(2)
    expect(compactCut([u, a, u, a, u, a, u, a, u, a, u, a])).toBe(8)
  })
  test("two messages of the user in a row are one turn", () => {
    expect(compactCut([u, a, u, u, a, u, a])).toBe(2)
  })
  test("the open turn of the user counts as a turn (the turn that starts now is one of the 2)", () => {
    expect(compactCut([u, a, u, a, u])).toBe(2)
    expect(compactCut([u, a, u])).toBeNull()
  })
})

describe("thresholds (spec 003, Automatic compact)", () => {
  const base = { setting: true, selfCompacts: false, used: 850, size: 1000, pause: 0 }
  test("85 percent of a small context", () => {
    expect(meterShare(850, 1000)).toBe(0.85)
    expect(meterShare(null, 1000)).toBeNull()
    expect(meterShare(5, 0)).toBeNull()
    expect(shouldAutoCompact(base)).toBe(true)
    expect(shouldAutoCompact({ ...base, used: 849 })).toBe(false)
    expect(shouldAutoCompact({ ...base, size: 200_000, used: 170_000 })).toBe(true)
    expect(shouldAutoCompact({ ...base, size: 200_000, used: 169_999 })).toBe(false)
  })
  test("400000 tokens of a large context, whichever comes first", () => {
    const big = { ...base, size: 1_000_000 }
    expect(COMPACT_AT_TOKENS).toBe(400_000)
    expect(shouldAutoCompact({ ...big, used: 399_999 })).toBe(false)
    expect(shouldAutoCompact({ ...big, used: 400_000 })).toBe(true)
    // About 470000 tokens is where both rules meet: below it the share comes first.
    expect(shouldAutoCompact({ ...base, size: 470_000, used: 399_500 })).toBe(true)
    expect(shouldAutoCompact({ ...base, size: 470_000, used: 399_499 })).toBe(false)
  })
  test("never with the setting off, a program that compacts itself, an unknown size or use, or a pause", () => {
    const big = { ...base, size: 1_000_000, used: 900_000 }
    expect(shouldAutoCompact({ ...big, setting: false })).toBe(false)
    expect(shouldAutoCompact({ ...big, selfCompacts: true })).toBe(false)
    expect(shouldAutoCompact({ ...big, size: null })).toBe(false)
    expect(shouldAutoCompact({ ...big, used: null })).toBe(false)
    expect(shouldAutoCompact({ ...big, pause: 1 })).toBe(false)
    expect(compactDue(COMPACT_AT_TOKENS, null)).toBe(false)
    expect(compactDue(null, 1_000_000)).toBe(false)
  })
})

describe("the pause of 5 turns", () => {
  test("starts at 5 and each ended turn takes one off", () => {
    expect(COMPACT_PAUSE_TURNS).toBe(5)
    expect(pauseLeft(null)).toBe(0)
    expect(pauseLeft(0)).toBe(5)
    expect(pauseLeft(4)).toBe(1)
    expect(pauseLeft(5)).toBe(0)
    expect(pauseLeft(9)).toBe(0)
  })
})

describe("the 1 hour cache", () => {
  const hour = { setting: true, pause: 0, lastReplyAt: 1_000, now: 1_000 + HOUR_CACHE_MS }
  test("ends 1 hour after the last reply", () => {
    expect(hourCacheEnded(hour)).toBe(true)
    expect(hourCacheEnded({ ...hour, now: hour.lastReplyAt + HOUR_CACHE_MS - 1 })).toBe(false)
  })
  test("does not end with the setting off, in a pause, or when no reply has ended", () => {
    expect(hourCacheEnded({ ...hour, setting: false })).toBe(false)
    expect(hourCacheEnded({ ...hour, pause: 1 })).toBe(false)
    expect(hourCacheEnded({ ...hour, lastReplyAt: null })).toBe(false)
  })
})
