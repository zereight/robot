import { afterEach, describe, expect, it, test } from "bun:test"
import type { ModelInfo } from "@robot/shared"
import {
  anthropicEfforts,
  createdOf,
  effortsFromCapabilities,
  effortToSend,
  failureFrom,
  listModels,
  modelEfforts,
  offeredEfforts,
} from "./client.ts"

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

describe("anthropicEfforts", () => {
  const none = { effort: { supported: false } }
  test("a model that takes no effort setting but thinks with a budget has three levels", () => {
    expect(anthropicEfforts("claude-haiku-4-5", none)).toEqual(["low", "medium", "high"])
    expect(anthropicEfforts("claude-sonnet-4-5-20250929", none)).toEqual(["low", "medium", "high"])
  })

  test("a model that does not think has none", () => {
    expect(anthropicEfforts("claude-3-5-haiku-latest", none)).toEqual([])
  })

  test("the list wins over the name, for a model that takes an effort setting", () => {
    const caps = {
      effort: { supported: true, low: level(true), medium: level(true), high: level(true) },
    }
    expect(anthropicEfforts("claude-opus-5-5", caps)).toEqual(["low", "medium", "high"])
  })

  test("a list that says nothing leaves it to the name", () => {
    expect(anthropicEfforts("claude-opus-5-5", undefined)).toHaveLength(5)
    expect(anthropicEfforts("claude-haiku-4-5", undefined)).toEqual(["low", "medium", "high"])
  })
})

describe("effortToSend", () => {
  const listed: ModelInfo[] = [
    { id: "claude-haiku-5-5", label: "Haiku", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-3-5-haiku-latest", label: "Haiku 3.5", efforts: [] },
    { id: "stand-in", label: "Stand-in", efforts: ["minimal", "high", "ultra"] },
  ]

  test("sends a level that the listed model takes, and the nearest level when it does not", () => {
    expect(effortToSend("anthropic", "claude-haiku-5-5", "max", listed)).toBe("max")
    expect(effortToSend("anthropic", "claude-3-5-haiku-latest", "high", listed)).toBeNull()
    // The list of any provider counts, also for Minimal and Ultra.
    expect(effortToSend("custom", "stand-in", "ultra", listed)).toBe("ultra")
    expect(effortToSend("custom", "stand-in", "max", listed)).toBe("ultra")
    expect(effortToSend("custom", "stand-in", "none", listed)).toBe("minimal")
    // Low is one step from Minimal and two from High.
    expect(effortToSend("custom", "stand-in", "low", listed)).toBe("minimal")
  })

  test("two levels equally near: the lower one is sent", () => {
    expect(effortToSend("custom", "stand-in", "xhigh", listed)).toBe("high")
  })

  test("without a list, the name of the model decides an Anthropic model", () => {
    expect(effortToSend("anthropic", "claude-sonnet-4-6", "max")).toBe("max")
    // Sonnet 4.6 lists low, medium, high and max: xhigh is between high and max, so the lower one.
    expect(effortToSend("anthropic", "claude-sonnet-4-6", "xhigh")).toBe("high")
    expect(effortToSend("anthropic", "claude-3-5-haiku-latest", "high")).toBeNull()
    // An older model that thinks with a budget keeps its three levels, and takes the nearest.
    expect(effortToSend("anthropic", "claude-haiku-4-5", "high")).toBe("high")
    expect(effortToSend("anthropic", "claude-haiku-4-5", "max")).toBe("high")
  })

  test("no level stays no level, and a model that the list does not name goes as it is", () => {
    expect(effortToSend("anthropic", "claude-opus-5-5", null, listed)).toBeNull()
    expect(effortToSend("openai", "o3", "high")).toBe("high")
    expect(effortToSend("custom", "anything", "high")).toBe("high")
    expect(effortToSend("custom", "anything", "ultra", listed)).toBe("ultra")
  })
})

describe("modelEfforts and the dates of a list", () => {
  test("a list of any provider can name None, Minimal and Ultra", () => {
    const caps = { effort: { supported: true, minimal: level(true), ultra: level(true) } }
    expect(modelEfforts("custom", "m", caps)).toEqual(["minimal", "ultra"])
    expect(modelEfforts("openai", "m", caps)).toEqual(["minimal", "ultra"])
    expect(
      effortsFromCapabilities({
        effort: { supported: true, none: level(true), low: level(true), ultra: level(false) },
      }),
    ).toEqual(["none", "low"])
  })

  test("a list that names no level leaves the name to decide", () => {
    expect(modelEfforts("custom", "m", undefined)).toEqual([])
    expect(modelEfforts("openai", "o3", { effort: { supported: false } })).toEqual([
      "low",
      "medium",
      "high",
    ])
  })

  test("the time that a provider gives is read as ms", () => {
    expect(createdOf({ created_at: "2026-01-02T00:00:00Z" })).toBe(
      Date.parse("2026-01-02T00:00:00Z"),
    )
    expect(createdOf({ created: 1_700_000_000 })).toBe(1_700_000_000_000)
    expect(createdOf({ created: 1_700_000_000_000 })).toBe(1_700_000_000_000)
    for (const bad of [{}, { created: 0 }, { created: "x" }, { created_at: "soon" }])
      expect(createdOf(bad)).toBeUndefined()
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
      { id: "claude-3-5-haiku-latest", capabilities: { effort: { supported: false } } },
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
    expect(models.find((m) => m.id === "claude-3-5-haiku-latest")?.efforts).toEqual([])
    // This one takes no effort setting but thinks with a budget, so the picker has three levels.
    expect(models.find((m) => m.id === "claude-haiku-4-5")?.efforts).toEqual([
      "low",
      "medium",
      "high",
    ])
  })

  test("goes by the model name when the list has no capabilities", async () => {
    answer([{ id: "claude-sonnet-5-5" }, { id: "claude-sonnet-4-5" }])
    const models = await listModels(conn)
    expect(models.find((m) => m.id === "claude-sonnet-5-5")?.efforts).toHaveLength(5)
    expect(models.find((m) => m.id === "claude-sonnet-4-5")?.efforts).toEqual([
      "low",
      "medium",
      "high",
    ])
  })

  test("the list keeps the order of the provider and tells when each model was made", async () => {
    answer([
      { id: "z-model", created_at: "2026-02-01T00:00:00Z" },
      { id: "a-model", created_at: "2025-02-01T00:00:00Z" },
    ])
    const models = await listModels(conn)
    expect(models.map((m) => m.id)).toEqual(["z-model", "a-model"])
    expect(models[0]?.created).toBe(Date.parse("2026-02-01T00:00:00Z"))
  })

  test("an OpenAI list ignores capabilities that name no level and goes by the name", async () => {
    answer([{ id: "o3", capabilities: { effort: { supported: false } } }])
    const models = await listModels({ ...conn, kind: "openai" })
    expect(models[0]?.efforts).toEqual(["low", "medium", "high"])
  })
})

const failed = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status })

describe("When a provider answers with an error", () => {
  describe("with too many requests", () => {
    it("should call the provider busy", async () => {
      expect((await failureFrom(failed(429, "Too many requests"))).code).toBe("provider_busy")
    })
  })

  describe("with a usage limit", () => {
    it("should call the provider limited", async () => {
      expect((await failureFrom(failed(429, "You have hit your usage limit."))).code).toBe(
        "provider_limit",
      )
    })
  })

  describe("with a plain 429", () => {
    it("should call the provider limited", async () => {
      expect((await failureFrom(failed(429, "slow down"))).code).toBe("provider_limit")
    })
  })

  describe("with an overloaded model", () => {
    it("should call the provider busy", async () => {
      expect((await failureFrom(failed(503, "The engine is overloaded"))).code).toBe(
        "provider_busy",
      )
    })
  })
})
