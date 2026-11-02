import { afterEach, describe, expect, test } from "bun:test"
import type { ModelInfo } from "@robot/shared"
import { effortsFromCapabilities, keepEffort, listModels, offeredEfforts } from "./client.ts"

const level = (supported: boolean) => ({ supported })

describe("effortsFromCapabilities", () => {
  test("lists the levels that the model says it takes, from low to max", () => {
    expect(
      effortsFromCapabilities({
        effort: {
          supported: true,
          low: level(true),
          medium: level(true),
          high: level(true),
          xhigh: level(true),
          max: level(true),
        },
      }),
    ).toEqual(["low", "medium", "high", "xhigh", "max"])
    // Sonnet 4.6 has "max" and no "xhigh". The API may give null for a level it does not know.
    expect(
      effortsFromCapabilities({
        effort: {
          supported: true,
          low: level(true),
          medium: level(true),
          high: level(true),
          xhigh: null,
          max: level(true),
        },
      }),
    ).toEqual(["low", "medium", "high", "max"])
  })

  test("a model that takes no effort has none", () => {
    expect(
      effortsFromCapabilities({
        effort: { supported: false, low: level(false), high: level(false) },
      }),
    ).toEqual([])
  })

  test("an entry that does not say gives null, so that the name decides", () => {
    expect(effortsFromCapabilities(undefined)).toBeNull()
    expect(effortsFromCapabilities(null)).toBeNull()
    expect(effortsFromCapabilities({ batch: level(true) })).toBeNull()
  })
})

describe("offeredEfforts", () => {
  const listed: ModelInfo[] = [
    { id: "claude-opus-5-5", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: ["low", "medium", "high", "max"] },
    { id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ]

  test("the list of the account decides for a model that it names", () => {
    expect(offeredEfforts("anthropic", "claude-sonnet-4-6", listed)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ])
    // The list wins over the name, also when it says that the model takes none.
    const none: ModelInfo[] = [{ id: "claude-opus-5-5", label: "Opus", efforts: [] }]
    expect(offeredEfforts("anthropic", "claude-opus-5-5", none)).toEqual([])
  })

  test("a model that the list does not name, or no list, leaves the documented levels", () => {
    expect(offeredEfforts("anthropic", "claude-fable-5-1", listed)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(offeredEfforts("anthropic", "claude-opus-4-5")).toEqual(["low", "medium", "high"])
    expect(offeredEfforts("openai", "o3-mini")).toEqual(["low", "medium", "high"])
  })

  test("an agent runtime and a custom address have only what the list says", () => {
    expect(offeredEfforts("claude_code", "opus", listed)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(offeredEfforts("claude_code", "sonnet", listed)).toEqual([])
    expect(offeredEfforts("custom", "anything")).toEqual([])
  })
})

describe("keepEffort", () => {
  const listed: ModelInfo[] = [
    { id: "claude-haiku-5-5", label: "Haiku", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] },
  ]

  test("keeps a level that the listed model takes, and drops one that it does not", () => {
    expect(keepEffort("anthropic", "claude-haiku-5-5", "max", listed)).toBe("max")
    expect(keepEffort("anthropic", "claude-haiku-4-5", "high", listed)).toBeNull()
  })

  test("without a list, the name of the model decides", () => {
    expect(keepEffort("anthropic", "claude-sonnet-4-6", "max")).toBe("max")
    expect(keepEffort("anthropic", "claude-sonnet-4-6", "xhigh")).toBeNull()
    expect(keepEffort("anthropic", "claude-haiku-4-5", "high")).toBeNull()
  })

  test("no level stays no level, and other providers are left as they are", () => {
    expect(keepEffort("anthropic", "claude-opus-5-5", null, listed)).toBeNull()
    expect(keepEffort("openai", "o3", "high")).toBe("high")
    expect(keepEffort("custom", "anything", "high")).toBe("high")
  })
})

describe("listModels for an Anthropic account", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const answer = (data: unknown[]) => {
    globalThis.fetch = (async () => Response.json({ data })) as unknown as typeof fetch
  }
  const conn = { kind: "anthropic" as const, baseUrl: "http://x", apiKey: "k" }

  test("takes the levels from the capabilities of each model", async () => {
    answer([
      {
        id: "claude-haiku-5-5",
        display_name: "Claude Haiku 5.5",
        capabilities: {
          effort: {
            supported: true,
            low: level(true),
            medium: level(true),
            high: level(true),
            xhigh: level(true),
            max: level(true),
          },
        },
      },
      { id: "claude-haiku-4-5", capabilities: { effort: { supported: false } } },
    ])
    const models = await listModels(conn)
    expect(models.find((m) => m.id === "claude-haiku-5-5")?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(models.find((m) => m.id === "claude-haiku-4-5")?.efforts).toEqual([])
  })

  test("goes by the model name when the list has no capabilities", async () => {
    answer([{ id: "claude-sonnet-5-5" }, { id: "claude-sonnet-4-5" }])
    const models = await listModels(conn)
    expect(models.find((m) => m.id === "claude-sonnet-5-5")?.efforts).toHaveLength(5)
    expect(models.find((m) => m.id === "claude-sonnet-4-5")?.efforts).toEqual([])
  })

  test("an OpenAI list ignores capabilities and goes by the name", async () => {
    answer([{ id: "o3", capabilities: { effort: { supported: false } } }])
    const models = await listModels({ ...conn, kind: "openai" })
    expect(models[0]?.efforts).toEqual(["low", "medium", "high"])
  })
})
