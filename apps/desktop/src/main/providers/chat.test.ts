import { describe, expect, test } from "bun:test"
import { normaliseTurns } from "./chat.ts"

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
