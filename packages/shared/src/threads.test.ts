import { describe, expect, test } from "bun:test"
import {
  COMPACT_AT_TOKENS,
  COMPACT_PAUSE_TURNS,
  canAddThread,
  compactCut,
  compactDue,
  meterShare,
  nextPause,
  shouldAutoCompact,
  THREAD_MAX,
  threadTitle,
} from "./threads.ts"

describe("threadTitle", () => {
  test("the first line that is not empty, at most 60 characters", () => {
    expect(threadTitle("\n  Plan the trip  \nmore")).toBe("Plan the trip")
    expect(threadTitle("가".repeat(70))).toBe("가".repeat(60))
    expect(threadTitle("  \n ")).toBeNull()
  })
})

describe("canAddThread", () => {
  test("the main thread counts as one of the 50", () => {
    expect(canAddThread(THREAD_MAX - 2)).toBe(true)
    expect(canAddThread(THREAD_MAX - 1)).toBe(false)
  })
})

describe("compactCut", () => {
  test("keeps the newest 2 turns", () => {
    const u = "user" as const
    const a = "agent" as const
    expect(compactCut([u, a, u, a])).toBeNull()
    expect(compactCut([u, a, u, a, u, a])).toBe(2)
    // Two messages of the user in a row are one turn.
    expect(compactCut([u, a, u, u, a, u, a])).toBe(2)
    // The open turn of the user counts as a turn.
    expect(compactCut([u, a, u, a, u])).toBe(2)
  })
})

describe("automatic compact", () => {
  const base = { setting: true, selfCompacts: false, used: 850, size: 1000, pause: 0 }
  test("at 85 percent or more", () => {
    expect(meterShare(850, 1000)).toBe(0.85)
    expect(meterShare(null, 1000)).toBeNull()
    expect(shouldAutoCompact(base)).toBe(true)
    expect(shouldAutoCompact({ ...base, used: 849 })).toBe(false)
  })
  test("at 400000 tokens or more, whichever comes first (spec 003)", () => {
    const big = { ...base, size: 1_000_000 }
    expect(shouldAutoCompact({ ...big, used: 399_999 })).toBe(false)
    expect(shouldAutoCompact({ ...big, used: COMPACT_AT_TOKENS })).toBe(true)
    // A model of 200000 tokens: the 85 percent rule comes first.
    expect(shouldAutoCompact({ ...base, size: 200_000, used: 170_000 })).toBe(true)
    expect(shouldAutoCompact({ ...base, size: 200_000, used: 169_999 })).toBe(false)
    // The limit needs a known size too.
    expect(compactDue(COMPACT_AT_TOKENS, null)).toBe(false)
    expect(compactDue(null, 1_000_000)).toBe(false)
    // The setting turns both rules off.
    expect(shouldAutoCompact({ ...big, used: COMPACT_AT_TOKENS, setting: false })).toBe(false)
  })
  test("never when off, when the provider compacts by itself, when not known, or in a pause", () => {
    expect(shouldAutoCompact({ ...base, setting: false })).toBe(false)
    expect(shouldAutoCompact({ ...base, selfCompacts: true })).toBe(false)
    expect(shouldAutoCompact({ ...base, size: null })).toBe(false)
    expect(shouldAutoCompact({ ...base, used: null })).toBe(false)
    expect(shouldAutoCompact({ ...base, pause: 1 })).toBe(false)
  })
  test("the pause of 5 turns", () => {
    expect(nextPause(0, "compact_failed")).toBe(COMPACT_PAUSE_TURNS)
    expect(nextPause(2, "full_after_compact")).toBe(COMPACT_PAUSE_TURNS)
    expect(nextPause(1, "turn")).toBe(0)
    expect(nextPause(0, "turn")).toBe(0)
  })
})
