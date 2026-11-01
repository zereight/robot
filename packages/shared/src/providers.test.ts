import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { effortsFor, ProviderConnect } from "./providers.ts"

describe("providers", () => {
  test("connect input needs a name, an http(s) base URL and a key", () => {
    const ok = (v: object) =>
      Schema.is(ProviderConnect)({
        kind: "custom",
        name: "Local",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "k",
        ...v,
      })
    expect(ok({})).toBe(true)
    expect(ok({ baseUrl: "file:///etc" })).toBe(false)
    expect(ok({ baseUrl: "nope" })).toBe(false)
    expect(ok({ apiKey: "" })).toBe(false)
    expect(ok({ name: "" })).toBe(false)
  })

  test("effort levels only for model families that take them", () => {
    expect(effortsFor("openai", "o3-mini")).toEqual(["low", "medium", "high"])
    expect(effortsFor("openai", "gpt-4o")).toEqual([])
    expect(effortsFor("anthropic", "claude-sonnet-4-5")).toEqual(["low", "medium", "high"])
    expect(effortsFor("anthropic", "claude-3-5-haiku-latest")).toEqual([])
    expect(effortsFor("custom", "o3")).toEqual([])
  })
})
