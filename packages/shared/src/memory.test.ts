import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MEMORY_MODE,
  isMemoryMode,
  MEMORY_HISTORY_DAYS,
  MEMORY_HISTORY_MAX,
  MEMORY_PROPOSAL_DAYS,
  MEMORY_PROPOSALS_MAX,
  MEMORY_TEXT_MAX,
  MEMORY_USER_TEXT_MAX,
  type MemoryItem,
  memoryUndo,
  relevantMemory,
  sameMemoryText,
} from "./memory.ts"

const item = (id: string, text: string, createdAt = 0): MemoryItem => ({
  id,
  agentId: "a",
  text,
  source: "agent",
  createdAt,
  updatedAt: createdAt,
  channel: null,
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

describe("the limits of spec 008", () => {
  test("the numbers are the ones of the spec", () => {
    expect(MEMORY_TEXT_MAX).toBe(500)
    expect(MEMORY_PROPOSALS_MAX).toBe(20)
    expect(MEMORY_PROPOSAL_DAYS).toBe(30)
    expect(MEMORY_HISTORY_DAYS).toBe(90)
    expect(MEMORY_HISTORY_MAX).toBe(1000)
    // A text typed by hand may be longer than the tool takes.
    expect(MEMORY_USER_TEXT_MAX).toBeGreaterThan(MEMORY_TEXT_MAX)
  })

  test("an agent saves at once until the user chooses otherwise", () => {
    expect(DEFAULT_MEMORY_MODE).toBe("now")
    expect(isMemoryMode("now")).toBe(true)
    expect(isMemoryMode("ask")).toBe(true)
    expect(isMemoryMode("later")).toBe(false)
    expect(isMemoryMode(undefined)).toBe(false)
  })
})

describe("sameMemoryText", () => {
  test("spaces at both ends and the case of letters do not matter", () => {
    expect(sameMemoryText("Likes tea", "  likes TEA\n")).toBe(true)
    expect(sameMemoryText("Likes tea", "Likes  tea")).toBe(false)
    expect(sameMemoryText("Likes tea", "Likes coffee")).toBe(false)
    expect(sameMemoryText("ÀBC", "àbc")).toBe(true)
  })
})

describe("memoryUndo", () => {
  const facts = {
    kind: "edited" as const,
    after: "New",
    itemText: "New",
    revived: false,
    secret: false,
  }
  test("added and edited: on only while the item has the text that the change left", () => {
    expect(memoryUndo(facts)).toEqual({ on: true })
    expect(memoryUndo({ ...facts, kind: "added" })).toEqual({ on: true })
    expect(memoryUndo({ ...facts, itemText: "Newer" })).toEqual({ on: false, why: "newer" })
    expect(memoryUndo({ ...facts, kind: "added", itemText: null })).toEqual({
      on: false,
      why: "newer",
    })
    // Not the same text: the case counts, because the item must be exactly as it was left.
    expect(memoryUndo({ ...facts, itemText: "new" })).toEqual({ on: false, why: "newer" })
  })

  test("deleted: on while nothing has put the item back", () => {
    const deleted = { ...facts, kind: "deleted" as const, after: null, itemText: null }
    expect(memoryUndo(deleted)).toEqual({ on: true })
    expect(memoryUndo({ ...deleted, revived: true })).toEqual({ on: false, why: "newer" })
  })

  test("a row whose text looks like a secret has no Undo, whatever the state", () => {
    expect(memoryUndo({ ...facts, secret: true })).toEqual({ on: false, why: "secret" })
    expect(
      memoryUndo({ ...facts, kind: "deleted", after: null, itemText: null, secret: true }),
    ).toEqual({ on: false, why: "secret" })
  })

  test("the channel counts: an item that was moved is not as the change left it (spec 008)", () => {
    const added = { ...facts, kind: "added" as const, afterChannel: "c1", itemChannel: "c1" }
    expect(memoryUndo(added)).toEqual({ on: true })
    // A move after the add: the text is the same, the channel is not.
    expect(memoryUndo({ ...added, itemChannel: null })).toEqual({ on: false, why: "newer" })
    expect(memoryUndo({ ...added, itemChannel: "c2" })).toEqual({ on: false, why: "newer" })
    // Older rows and callers that name no channel mean a general item.
    expect(memoryUndo({ ...facts, kind: "added" })).toEqual({ on: true })
  })

  test("moved: on while the item is where the move left it, and the old place is there", () => {
    const moved = {
      ...facts,
      kind: "moved" as const,
      afterChannel: null,
      itemChannel: null,
      backExists: true,
    }
    expect(memoryUndo(moved)).toEqual({ on: true })
    expect(memoryUndo({ ...moved, itemChannel: "c1" })).toEqual({ on: false, why: "newer" })
    expect(memoryUndo({ ...moved, itemText: "Edited after" })).toEqual({ on: false, why: "newer" })
    expect(memoryUndo({ ...moved, backExists: false })).toEqual({
      on: false,
      why: "channel_gone",
    })
  })
})
