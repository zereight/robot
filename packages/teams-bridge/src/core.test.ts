import { describe, expect, test } from "bun:test"
import {
  chunkText,
  isBotText,
  keyOf,
  markedChunks,
  RateLimiter,
  SeenKeys,
  withMarker,
} from "./core.ts"

describe("marker", () => {
  test("detects the bridge's own text, also after leading space", () => {
    expect(isBotText("[ROBot] hi", "[ROBot]")).toBe(true)
    expect(isBotText("  [ROBot] hi", "[ROBot]")).toBe(true)
    expect(isBotText("hi [ROBot]", "[ROBot]")).toBe(false)
    expect(isBotText("hello", "[ROBot]")).toBe(false)
  })

  test("adds the marker in front", () => {
    expect(withMarker("x", "[ROBot]")).toBe("[ROBot] x")
  })
})

describe("chunkText", () => {
  test("returns one piece when the text fits", () => {
    expect(chunkText("abc", 10)).toEqual(["abc"])
  })

  test("returns one empty piece for empty text", () => {
    expect(chunkText("", 10)).toEqual([""])
  })

  test("cuts at a line break when it can", () => {
    expect(chunkText("aaaa\nbbbb\ncccc", 10)).toEqual(["aaaa\nbbbb", "cccc"])
  })

  test("cuts at a space when there is no line break", () => {
    expect(chunkText("aaaa bbbb cccc", 10)).toEqual(["aaaa bbbb", "cccc"])
  })

  test("cuts hard when there is neither", () => {
    expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  })

  test("never returns a piece longer than max, and loses no characters", () => {
    const text = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ")
    const pieces = chunkText(text, 37)
    expect(pieces.every((p) => p.length <= 37)).toBe(true)
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(text)
  })
})

describe("markedChunks", () => {
  test("puts the marker on every piece, so the reader skips all of them", () => {
    const pieces = markedChunks("x ".repeat(100).trim(), "[ROBot]", 50)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((p) => isBotText(p, "[ROBot]") && p.length <= 50)).toBe(true)
  })

  test("refuses a size that leaves no room", () => {
    expect(() => markedChunks("x", "[ROBot]", 8)).toThrow()
  })
})

describe("SeenKeys", () => {
  test("is true once for a key", () => {
    const s = new SeenKeys()
    expect(s.add("a")).toBe(true)
    expect(s.add("a")).toBe(false)
  })

  test("forgets the oldest key past the cap", () => {
    const s = new SeenKeys(2)
    s.add("a")
    s.add("b")
    s.add("c")
    expect(s.size).toBe(2)
    expect(s.add("a")).toBe(true)
  })
})

describe("RateLimiter", () => {
  test("allows max takes per window, then again after the window", () => {
    let now = 0
    const r = new RateLimiter(2, 1000, () => now)
    expect(r.tryTake()).toBe(true)
    expect(r.tryTake()).toBe(true)
    expect(r.tryTake()).toBe(false)
    now = 1000
    expect(r.tryTake()).toBe(true)
  })
})

describe("keyOf", () => {
  test("uses the page id when there is one", () => {
    expect(keyOf({ id: "7", author: "a", text: "t", time: "x" })).toBe("id:7")
  })

  test("falls back to time and text", () => {
    expect(keyOf({ id: "", author: "a", text: "t", time: "x" })).toBe("t:x|t")
  })
})
