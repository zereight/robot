import { describe, expect, test } from "bun:test"
import { findHits, locate, stepHit } from "./find.ts"

describe("find in the chat (spec 003, flow 10)", () => {
  test("it ignores letter case and counts every match", () => {
    expect(findHits("Budget, budget and BUDGET", "budget")).toHaveLength(3)
    expect(findHits("nothing here", "budget")).toEqual([])
    expect(findHits("anything", "")).toEqual([])
  })

  test("a match does not overlap the one before", () => {
    expect(findHits("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  test("a position in the joined text finds its text node, also across a split word", () => {
    const parts = ["bu", "dget plan"]
    const [hit] = findHits(parts.join(""), "budget")
    expect(hit).toEqual({ start: 0, end: 6 })
    expect(locate(parts, 0)).toEqual({ segment: 0, offset: 0 })
    expect(locate(parts, 6, true)).toEqual({ segment: 1, offset: 4 })
    expect(locate(parts, 2, true)).toEqual({ segment: 0, offset: 2 })
  })

  test("Next and Previous go round the matches", () => {
    expect(stepHit(3, 4, 1)).toBe(0)
    expect(stepHit(0, 4, -1)).toBe(3)
    expect(stepHit(0, 0, 1)).toBe(0)
  })
})
