import { describe, expect, test } from "bun:test"
import { cacheMarker, takesCacheMarker } from "./cache.ts"
import type { Connection } from "./client.ts"

const account = (kind: Connection["kind"], baseUrl: string): Connection => ({
  kind,
  baseUrl,
  apiKey: "k",
})

describe("takesCacheMarker", () => {
  test("an Anthropic account on the official host takes it", () => {
    expect(takesCacheMarker(account("anthropic", "https://api.anthropic.com"))).toBe(true)
    expect(takesCacheMarker(account("anthropic", "https://api.anthropic.com/"))).toBe(true)
    expect(takesCacheMarker(account("anthropic", "https://API.Anthropic.com"))).toBe(true)
  })

  test("the official host over plain http does not", () => {
    expect(takesCacheMarker(account("anthropic", "http://api.anthropic.com"))).toBe(false)
  })

  test("a proxy or another host does not, whatever its address looks like", () => {
    for (const baseUrl of [
      "https://proxy.example.com",
      "https://api.anthropic.com.example.com",
      "https://example.com/api.anthropic.com",
      "https://api.anthropic.com@example.com",
      "https://bedrock-runtime.us-east-1.amazonaws.com",
      "http://127.0.0.1:4000",
      "http://localhost:11434",
    ])
      expect(takesCacheMarker(account("anthropic", baseUrl))).toBe(false)
  })

  test("an address that is not a URL does not", () => {
    for (const baseUrl of ["", "api.anthropic.com", "not a url"])
      expect(takesCacheMarker(account("anthropic", baseUrl))).toBe(false)
  })

  test("an account that speaks the OpenAI API never does, on any host", () => {
    for (const kind of ["openai", "custom"] as const)
      for (const baseUrl of ["https://api.anthropic.com", "https://api.openai.com/v1"])
        expect(takesCacheMarker(account(kind, baseUrl), ["api.openai.com"])).toBe(false)
  })

  test("a host that a test run adds takes it, only for the kind Anthropic", () => {
    const stand = "http://127.0.0.1:5555/anthropic"
    expect(takesCacheMarker(account("anthropic", stand))).toBe(false)
    expect(takesCacheMarker(account("anthropic", stand), ["127.0.0.1"])).toBe(true)
    expect(takesCacheMarker(account("anthropic", stand), ["other.test"])).toBe(false)
    expect(takesCacheMarker(account("custom", stand), ["127.0.0.1"])).toBe(false)
  })
})

describe("cacheMarker", () => {
  test("the short lifetime is the default of the provider: no lifetime in the marker", () => {
    expect(cacheMarker("short")).toEqual({ type: "ephemeral" })
    expect("ttl" in cacheMarker("short")).toBe(false)
  })

  test("the long lifetime is 1 hour", () => {
    expect(cacheMarker("long")).toEqual({ type: "ephemeral", ttl: "1h" })
  })
})
