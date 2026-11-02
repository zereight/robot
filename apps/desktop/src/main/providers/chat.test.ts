import { describe, expect, test } from "bun:test"
import { anthropicBody, normaliseTurns } from "./chat.ts"

describe("normaliseTurns", () => {
  test("joins turns of one role and drops empty ones", () => {
    expect(
      normaliseTurns([
        { role: "assistant", content: "hello" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "  " },
        { role: "assistant", content: "c" },
      ]),
    ).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
    ])
  })
})

describe("anthropicBody", () => {
  const base = {
    connection: { kind: "anthropic" as const, baseUrl: "http://x", apiKey: "k" },
    system: "",
    turns: [{ role: "user" as const, content: "hi" }],
    signal: new AbortController().signal,
  }

  test("a chosen level goes in the output setting, never as a thinking budget", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const body = anthropicBody({ ...base, model: "claude-sonnet-5-5", effort })
      expect(body.output_config).toEqual({ effort })
      expect(JSON.stringify(body)).not.toContain("budget_tokens")
    }
  })

  test("a model that takes adaptive thinking gets it, with the text of the thinking", () => {
    const body = anthropicBody({ ...base, model: "claude-haiku-5-5", effort: "max" })
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" })
  })

  test("a model that does not take it gets the level and no thinking setting", () => {
    const body = anthropicBody({ ...base, model: "claude-opus-4-5-20251101", effort: "high" })
    expect(body.output_config).toEqual({ effort: "high" })
    expect("thinking" in body).toBe(false)
  })

  test("with no level the body has no output setting and no thinking setting", () => {
    const body = anthropicBody({ ...base, model: "claude-opus-5-5", effort: null })
    expect("output_config" in body).toBe(false)
    expect("thinking" in body).toBe(false)
    expect(body.max_tokens).toBe(8192)
  })

  test("a higher level leaves more room for the reply, within what the models allow", () => {
    const room = (effort: string) =>
      anthropicBody({ ...base, model: "claude-opus-5-5", effort }).max_tokens
    expect(room("low")).toBeLessThan(room("medium"))
    expect(room("medium")).toBeLessThan(room("high"))
    expect(room("high")).toBeLessThan(room("xhigh"))
    expect(room("xhigh")).toBeLessThan(room("max"))
    expect(room("max")).toBeLessThanOrEqual(64000)
  })
})
