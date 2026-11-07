import { describe, expect, test } from "bun:test"
import { type DiffSegment, textDiff } from "./diff.ts"

const rebuild = (segments: readonly DiffSegment[], keep: "removed" | "added") =>
  segments
    .filter((s) => s.kind === "same" || s.kind === keep)
    .map((s) => s.text)
    .join("")

describe("textDiff (spec 002, the card of a text change)", () => {
  test("the segments give back both texts", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["", "new text"],
      ["old text", ""],
      ["same", "same"],
      ["Write five lines. Be short.", "Write three lines.  Be very short."],
      ["a b c d e f", "a x c y e z"],
      ["line one\nline two\n", "line one\nline 2\nline three\n"],
      ["하나 둘 셋", "하나 셋 넷"],
    ]
    for (const [before, after] of cases) {
      const d = textDiff(before, after, 2000)
      expect(d).not.toBeNull()
      expect(rebuild(d?.segments ?? [], "removed")).toBe(before)
      expect(rebuild(d?.segments ?? [], "added")).toBe(after)
    }
  })

  test("a change that is the same text has no removed and no added part", () => {
    const d = textDiff("same words here", "same words here", 100)
    expect(d?.removed).toBe(0)
    expect(d?.added).toBe(0)
  })

  test("the sizes count the characters of the removed and the added parts", () => {
    const d = textDiff("keep old keep", "keep new keep", 100)
    expect(d).toMatchObject({ removed: 3, added: 3 })
  })

  test("a change above the cap gives null", () => {
    expect(textDiff("a ".repeat(50), "b ".repeat(50), 20)).toBeNull()
    expect(textDiff("a ".repeat(50), "b ".repeat(50), 2000)).not.toBeNull()
  })

  test("a change in the middle of a long text keeps the shared start and end", () => {
    const head = "word ".repeat(3000)
    const tail = " end".repeat(3000)
    const d = textDiff(`${head}old${tail}`, `${head}new${tail}`, 2000)
    expect(d).toMatchObject({ removed: 3, added: 3 })
  })
})
