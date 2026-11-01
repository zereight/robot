import { describe, expect, test } from "bun:test"
import { type UsageRow, usageByAgent, usageByDay, usageTotal } from "./usage.ts"

const row = (day: string, agentId: string, input: number, output: number): UsageRow => ({
  day,
  agentId,
  agentName: agentId.toUpperCase(),
  replies: 1,
  inputTokens: input,
  outputTokens: output,
})

const rows = [
  row("2026-10-30", "a", 10, 5),
  row("2026-10-31", "a", 20, 5),
  row("2026-10-31", "b", 100, 1),
]

describe("usage", () => {
  test("totals all rows", () => {
    expect(usageTotal(rows)).toEqual({ replies: 3, inputTokens: 130, outputTokens: 11 })
    expect(usageTotal([])).toEqual({ replies: 0, inputTokens: 0, outputTokens: 0 })
  })

  test("sums per agent, the biggest user first", () => {
    const list = usageByAgent(rows)
    expect(list.map((a) => a.agentId)).toEqual(["b", "a"])
    expect(list[1]).toMatchObject({ replies: 2, inputTokens: 30, outputTokens: 10 })
  })

  test("groups per day, newest day first", () => {
    const list = usageByDay(rows)
    expect(list.map((d) => d.day)).toEqual(["2026-10-31", "2026-10-30"])
    expect(list[0]?.agents).toHaveLength(2)
    expect(list[0]).toMatchObject({ inputTokens: 120, outputTokens: 6 })
  })
})
