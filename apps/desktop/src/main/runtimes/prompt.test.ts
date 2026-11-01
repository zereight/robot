import { describe, expect, test } from "bun:test"
import { buildPrompt } from "./prompt.ts"

describe("buildPrompt", () => {
  test("one message goes as it is", () => {
    expect(buildPrompt([{ role: "user", content: "Hi" }])).toBe("Hi")
  })

  test("earlier messages come first, then the new one", () => {
    const text = buildPrompt([
      { role: "user", content: "Name a colour" },
      { role: "assistant", content: "Blue" },
      { role: "user", content: "Another" },
    ])
    expect(text).toContain("User: Name a colour")
    expect(text).toContain("You: Blue")
    expect(text.endsWith("Another")).toBe(true)
    expect(text.indexOf("Blue")).toBeLessThan(text.indexOf("Another"))
  })

  test("the oldest lines go first when the history is long", () => {
    const text = buildPrompt(
      [
        { role: "user", content: `old ${"x".repeat(200)}` },
        { role: "assistant", content: "recent" },
        { role: "user", content: "now" },
      ],
      50,
    )
    expect(text).not.toContain("old")
    expect(text).toContain("recent")
  })

  test("tool turns and empty turns are left out", () => {
    const text = buildPrompt([
      { role: "user", content: "a" },
      { role: "tool", callId: "1", name: "x", content: "result" },
      { role: "assistant", content: "  " },
      { role: "user", content: "b" },
    ])
    expect(text).not.toContain("result")
    expect(text).toContain("User: a")
  })

  test("no text at all gives a placeholder", () => {
    expect(buildPrompt([])).toBe("(no text)")
  })
})
