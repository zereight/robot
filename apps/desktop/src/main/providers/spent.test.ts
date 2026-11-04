import { describe, expect, test } from "bun:test"
import { spendTracker } from "./spent.ts"

describe("spendTracker (spec 005, Usage of a task)", () => {
  test("totals so far turn into what was spent since the last report", () => {
    const spend = spendTracker()
    expect(spend({ input: 1000 })).toEqual({ type: "spent", input: 1000 })
    expect(spend({ input: 1000, output: 100 })).toEqual({ type: "spent", input: 0, output: 100 })
    expect(spend({ output: 250 })).toEqual({ type: "spent", output: 150 })
  })

  test("a field that no report named stays out, so the task keeps null", () => {
    const spend = spendTracker()
    const first = spend({ input: 10, output: 2 })
    expect(first).toEqual({ type: "spent", input: 10, output: 2 })
    expect(first && "cached" in first).toBe(false)
    expect(spend({})).toBeUndefined()
  })

  test("a field that a report named as 0 is 0", () => {
    const spend = spendTracker()
    expect(spend({ input: 0, cached: 0 })).toEqual({ type: "spent", input: 0, cached: 0 })
  })

  test("a total that goes down takes nothing away", () => {
    const spend = spendTracker()
    spend({ input: 500 })
    expect(spend({ input: 300 })).toEqual({ type: "spent", input: 0 })
    expect(spend({ input: 600 })).toEqual({ type: "spent", input: 100 })
  })

  test("the cached part and the cost follow the same rule", () => {
    const spend = spendTracker()
    expect(spend({ input: 8000, cached: 6000, costMicros: 1200 })).toEqual({
      type: "spent",
      input: 8000,
      cached: 6000,
      costMicros: 1200,
    })
    expect(spend({ costMicros: 1500 })).toEqual({ type: "spent", costMicros: 300 })
  })
})
