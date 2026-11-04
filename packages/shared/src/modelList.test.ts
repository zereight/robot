import { describe, expect, test } from "bun:test"
import { modelMatches, orderModels } from "./modelList.ts"
import type { ModelInfo } from "./providers.ts"

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  label: id,
  efforts: [],
  ...extra,
})
const ids = (list: readonly ModelInfo[]) => list.map((x) => x.id)
const olderIds = (list: readonly ModelInfo[]) => list.filter((x) => x.older).map((x) => x.id)

describe("the order of the models (spec 006)", () => {
  test("the newest model by date comes first", () => {
    const list = orderModels([
      m("a", { created: 100 }),
      m("b", { created: 300 }),
      m("c", { created: 200 }),
    ])
    expect(ids(list)).toEqual(["b", "c", "a"])
  })

  test("a model with the same date keeps the place the provider gave it", () => {
    expect(ids(orderModels([m("x", { created: 1 }), m("y", { created: 1 })]))).toEqual(["x", "y"])
  })

  test("with no date, the list keeps its order and only the models of one family swap places", () => {
    const list = orderModels([m("mock-pro-1"), m("plain"), m("mock-pro-2"), m("mock-lite-1")])
    expect(ids(list)).toEqual(["mock-pro-2", "plain", "mock-pro-1", "mock-lite-1"])
    expect(olderIds(list)).toEqual(["mock-pro-1"])
  })

  test("with no date, the models of different makers are not sorted by the numbers in their ids", () => {
    const list = orderModels([
      m("anthropic/claude-haiku-4-5"),
      m("openai/gpt-5.1"),
      m("anthropic/claude-opus-5-5"),
    ])
    expect(ids(list)).toEqual([
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5.1",
      "anthropic/claude-opus-5-5",
    ])
  })

  test("a model with a date goes before one with none", () => {
    expect(ids(orderModels([m("plain"), m("dated", { created: 5 })]))).toEqual(["dated", "plain"])
  })

  test("with neither a date nor a version the list keeps its order and has no older model", () => {
    const list = orderModels([m("opus"), m("sonnet"), m("haiku")])
    expect(ids(list)).toEqual(["opus", "sonnet", "haiku"])
    expect(olderIds(list)).toEqual([])
  })

  test("a model is older when a newer model of the same family is listed", () => {
    const list = orderModels([
      m("claude-opus-4-1-20250805", { created: 100 }),
      m("claude-opus-5-5", { created: 500 }),
      m("claude-sonnet-4-5", { created: 300 }),
      m("claude-haiku-5-5", { created: 400 }),
    ])
    expect(ids(list)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-5-5",
      "claude-sonnet-4-5",
      "claude-opus-4-1-20250805",
    ])
    // Sonnet has no newer model in the list, so only the old Opus is older.
    expect(olderIds(list)).toEqual(["claude-opus-4-1-20250805"])
  })

  test("versions tell the family when the provider gives no date", () => {
    const list = orderModels([m("gpt-5"), m("gpt-5.1"), m("gpt-5-mini"), m("gpt-4o")])
    expect(olderIds(list)).toEqual(["gpt-5"])
  })

  test("a snapshot and its alias are not older than each other", () => {
    const list = orderModels([m("claude-opus-4-5"), m("claude-opus-4-5-20251101")])
    expect(olderIds(list)).toEqual([])
  })

  test("two snapshots of one version: the later date is newer", () => {
    const list = orderModels([m("claude-haiku-4-5-20251001"), m("claude-haiku-4-5-20260101")])
    expect(olderIds(list)).toEqual(["claude-haiku-4-5-20251001"])
  })

  test("a model whose family has no other member is never older", () => {
    const list = orderModels([m("o3-mini", { created: 1 }), m("mock-fast", { created: 2 })])
    expect(olderIds(list)).toEqual([])
  })

  test("six models, two of one family: the older one is marked", () => {
    const list = orderModels([
      m("mock-pro-1", { created: 10 }),
      m("mock-pro-2", { created: 20 }),
      m("mock-fast", { created: 30 }),
      m("o3-mini", { created: 5 }),
      m("mock-lite", { created: 15 }),
      m("mock-think", { created: 25 }),
    ])
    expect(ids(list)).toEqual([
      "mock-fast",
      "mock-think",
      "mock-pro-2",
      "mock-lite",
      "mock-pro-1",
      "o3-mini",
    ])
    expect(olderIds(list)).toEqual(["mock-pro-1"])
  })
})

describe("the search box of the picker", () => {
  test("every word must match the label or the id, in any case", () => {
    const model = m("claude-opus-4-1", { label: "Claude Opus 4.1" })
    expect(modelMatches(model, "Claude Opus 4.1", "")).toBe(true)
    expect(modelMatches(model, "Claude Opus 4.1", "OPUS 4.1")).toBe(true)
    expect(modelMatches(model, "Claude Opus 4.1", "opus-4-1")).toBe(true)
    expect(modelMatches(model, "Claude Opus 4.1", "sonnet")).toBe(false)
  })
})
