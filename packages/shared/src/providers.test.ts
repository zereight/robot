import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  effortsFor,
  isBlockingState,
  isRuntimeKind,
  ProviderConnect,
  RUNTIME_CHECK_MS,
  RUNTIME_KINDS,
  RUNTIME_STATES,
  runtimeModel,
  runtimeModels,
  runtimeSupport,
  takesAdaptiveThinking,
  takesThinkingBudget,
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
    expect(effortsFor("anthropic", "claude-3-5-haiku-latest")).toEqual([])
    expect(effortsFor("custom", "o3")).toEqual([])
  })

  test("Claude models take the levels that Anthropic documents for each", () => {
    const five = ["low", "medium", "high", "xhigh", "max"]
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "CLAUDE-HAIKU-5-5-20261001",
    ])
      expect(effortsFor("anthropic", id)).toEqual(five)
    // 4.6 has "max" but not "xhigh". Opus 4.5 has the first three only.
    expect(effortsFor("anthropic", "claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"])
    expect(effortsFor("anthropic", "claude-opus-4-6")).toEqual(["low", "medium", "high", "max"])
    expect(effortsFor("anthropic", "claude-opus-4-5-20251101")).toEqual(["low", "medium", "high"])
    // These think with a budget: the three levels set the budget.
    for (const id of [
      "claude-sonnet-4-5",
      "claude-haiku-4-5-20251001",
      "claude-3-7-sonnet-latest",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-sonnet-4-0",
    ])
      expect(effortsFor("anthropic", id)).toEqual(["low", "medium", "high"])
    // These do not think at all.
    for (const id of ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-2.1"])
      expect(effortsFor("anthropic", id)).toEqual([])
  })

  test("the thinking budget is for the older models only", () => {
    for (const id of [
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-1",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
    ])
      expect(takesThinkingBudget(id)).toBe(true)
    // Opus 4.5 and later take an effort setting; the 3.5 models do not think.
    for (const id of [
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-haiku-5-5",
      "claude-3-5-haiku-latest",
      "gpt-5",
    ])
      expect(takesThinkingBudget(id)).toBe(false)
  })

  test("only Claude 4.6 and later models take adaptive thinking", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-haiku-5-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ])
      expect(takesAdaptiveThinking(id)).toBe(true)
    for (const id of ["claude-opus-4-5-20251101", "claude-haiku-4-5", "claude-3-7-sonnet", "gpt-5"])
      expect(takesAdaptiveThinking(id)).toBe(false)
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

  test("each runtime has models, and the Claude models take five effort levels", () => {
    expect(runtimeModels("claude_code").map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"])
    // Each one shows its version. The id stays the name that the program takes.
    expect(runtimeModels("claude_code").map((m) => m.label)).toEqual([
      "Opus 5.5",
      "Sonnet 5.5",
      "Haiku 5.5",
    ])
    // All three Claude models take the five levels, up to "xhigh" and "max".
    for (const id of ["opus", "sonnet", "haiku"])
      expect(runtimeModels("claude_code").find((m) => m.id === id)?.efforts).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ])
    const [codex] = runtimeModels("codex")
    expect(codex).toMatchObject({ id: "default", labelKey: "providers.model.default" })
    expect(runtimeModels("muse").map((m) => m.id)).toEqual(["default"])
    // pi lists its own models, so the app has none to give.
    expect(runtimeModels("pi")).toEqual([])
  })

  test("a model of a runtime is found by its id; other models are not", () => {
    expect(runtimeModel("claude_code", "sonnet")?.label).toBe("Sonnet 5.5")
    expect(runtimeModel("codex", "default")?.labelKey).toBe("providers.model.default")
    expect(runtimeModel("claude_code", "claude-sonnet-5-5")).toBeUndefined()
    expect(runtimeModel("pi", "anthropic/fake-large")).toBeUndefined()
    expect(runtimeModel("anthropic", "sonnet")).toBeUndefined()
    expect(runtimeModel(undefined, "sonnet")).toBeUndefined()
  })

  test("the app downloads only the programs whose vendor publishes a checksum", () => {
    expect(runtimeSupport("claude_code")).toEqual({ install: "download", signIn: "app" })
    expect(runtimeSupport("codex")).toEqual({ install: "download", signIn: "app" })
    expect(runtimeSupport("muse")).toEqual({ install: "manual", signIn: "app" })
    expect(runtimeSupport("pi")).toEqual({ install: "manual", signIn: "manual" })
  })
})

describe("the states of a runtime (spec 006)", () => {
  test("a program has five states, and a check ends within 15 seconds", () => {
    expect(RUNTIME_STATES).toEqual([
      "checking",
      "ready",
      "needs_sign_in",
      "needs_repair",
      "not_installed",
    ])
    expect(RUNTIME_CHECK_MS).toBeLessThanOrEqual(15_000)
  })

  test("only Needs repair and Not installed stop an agent", () => {
    expect(RUNTIME_STATES.filter(isBlockingState)).toEqual(["needs_repair", "not_installed"])
  })
})
