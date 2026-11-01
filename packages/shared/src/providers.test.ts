import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  effortsFor,
  isRuntimeKind,
  ProviderConnect,
  RUNTIME_KINDS,
  runtimeModels,
  runtimeSupport,
} from "./providers.ts"

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

  test("a subscription account needs a name only: no address and no key", () => {
    for (const kind of RUNTIME_KINDS)
      expect(Schema.is(ProviderConnect)({ kind, name: "Mine" })).toBe(true)
    expect(Schema.is(ProviderConnect)({ kind: "codex", name: "" })).toBe(false)
    expect(Schema.is(ProviderConnect)({ kind: "other", name: "x" })).toBe(false)
  })

  test("runtime kinds are told from API kinds", () => {
    expect(isRuntimeKind("claude_code")).toBe(true)
    expect(isRuntimeKind("codex")).toBe(true)
    expect(isRuntimeKind("openai")).toBe(false)
  })

  test("each runtime has models, and only some take an effort level", () => {
    expect(runtimeModels("claude_code").map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"])
    expect(runtimeModels("claude_code").find((m) => m.id === "haiku")?.efforts).toEqual([])
    expect(runtimeModels("claude_code").find((m) => m.id === "opus")?.efforts).toEqual([
      "low",
      "medium",
      "high",
    ])
    const [codex] = runtimeModels("codex")
    expect(codex).toMatchObject({ id: "default", labelKey: "providers.model.default" })
    expect(runtimeModels("muse").map((m) => m.id)).toEqual(["default"])
    // pi lists its own models, so the app has none to give.
    expect(runtimeModels("pi")).toEqual([])
  })

  test("the app downloads only the programs whose vendor publishes a checksum", () => {
    expect(runtimeSupport("claude_code")).toEqual({ install: "download", signIn: "app" })
    expect(runtimeSupport("codex")).toEqual({ install: "download", signIn: "app" })
    expect(runtimeSupport("muse")).toEqual({ install: "manual", signIn: "app" })
    expect(runtimeSupport("pi")).toEqual({ install: "manual", signIn: "manual" })
  })
})
