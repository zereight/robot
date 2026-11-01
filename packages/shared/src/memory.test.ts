import { describe, expect, test } from "bun:test"
import { type MemoryItem, relevantMemory } from "./memory.ts"

const item = (id: string, text: string, createdAt = 0): MemoryItem => ({
  id,
  agentId: "a",
  text,
  source: "agent",
  createdAt,
  updatedAt: createdAt,
})

describe("relevantMemory", () => {
  const many = [
    item("1", "The user likes green tea", 1),
    item("2", "The deploy target is Fly.io", 2),
    item("3", "Name of the cat is Miso", 3),
    item("4", "Prefers short answers", 4),
    item("5", "Lives in Busan", 5),
    item("6", "Works on the billing service", 6),
  ]
  test("picks items that share words with the message", () => {
    expect(relevantMemory(many, "what tea should I drink?").map((i) => i.id)).toEqual(["1"])
    expect(relevantMemory(many, "unrelated zzz")).toEqual([])
  })
  test("a small memory is given whole, newest first", () => {
    expect(relevantMemory(many.slice(0, 3), "hello").map((i) => i.id)).toEqual(["3", "2", "1"])
  })
  test("respects the size limits", () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      item(String(i), `topic note ${i} ${"x".repeat(400)}`, i),
    )
    const out = relevantMemory(big, "topic note")
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(4000)
  })
  test("matches Korean words", () => {
    expect(
      relevantMemory([...many, item("7", "녹차를 좋아함")], "녹차 추천해줘").map((i) => i.id),
    ).toEqual(["7"])
  })
})
