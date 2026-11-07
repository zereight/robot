import { expect, test } from "bun:test"
import { lexer } from "marked"
import { type Lexed, lexMarkdown } from "./lex.ts"

const whole = (text: string) => lexer(text.replace(/\r\n?/g, "\n"), { gfm: true, breaks: true })

/** Grows the text by `step` characters at a time, as a reply does, and checks each reading. */
const grow = (text: string, step: number) => {
  let previous: Lexed | undefined
  let reused = 0
  for (let end = 1; end <= text.length + step; end += step) {
    const part = text.slice(0, Math.min(end, text.length))
    const next = lexMarkdown(part, previous)
    // The same tokens as a whole reading. JSON compares every field of every token.
    expect(JSON.stringify(next.tokens)).toBe(JSON.stringify(whole(part)))
    if (previous) {
      // Settled tokens are the same objects, so a view keeps their elements.
      for (let at = 0; at < Math.min(previous.settled, next.tokens.length); at++) {
        if (next.tokens[at] === previous.tokens[at]) reused++
      }
    }
    previous = next
  }
  return reused
}

const REPLY = [
  "# Plan",
  "",
  "First paragraph with **bold**, _italic_ and `code`. A [link](https://example.com) too.",
  "Second line of the same paragraph.",
  "",
  "- one",
  "- two",
  "  - nested",
  "- three",
  "",
  "1. step",
  "2. step",
  "",
  "> a quote",
  "> over two lines",
  "",
  "```ts",
  "const a = 1",
  "",
  "const b = 2",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "Setext heading",
  "---",
  "",
  "    indented code",
  "",
  "    more code",
  "",
  "- loose item",
  "",
  "- another loose item",
  "",
  "#tag is not a heading",
  "",
  "<div>html block</div>",
  "",
  "- [ ] task",
  "- [x] done",
  "",
  "***",
  "",
  "The end.",
  "",
].join("\n")

test("a growing text reads as a whole text does, one character at a time", () => {
  const reused = grow(REPLY, 1)
  // The point of the module: most blocks come from the earlier reading.
  expect(reused).toBeGreaterThan(REPLY.length)
})

test("a growing text reads as a whole text does, in uneven steps", () => {
  for (const step of [2, 3, 7, 40, 200]) grow(REPLY, step)
})

test("a text with Windows line ends reads as a whole text does", () => {
  grow(REPLY.replaceAll("\n", "\r\n"), 5)
})

test("a text with a link definition is read whole every time", () => {
  const text =
    "First [one][a] block.\n\nSecond block.\n\nThird block.\n\n[a]: https://example.com\n"
  grow(text, 1)
  let previous: Lexed | undefined
  for (const end of [20, 40, text.length]) {
    previous = lexMarkdown(text.slice(0, end), previous)
  }
  const again = lexMarkdown(text, previous)
  expect(again.tokens.some((t) => t.type === "def")).toBe(true)
})

test("a line that closes the block above it is read right", () => {
  // "#" alone ends the paragraph above it, "#tag" does not: the block above must stay open.
  grow("Intro line\n\nA paragraph\n#\n\nAfter\n", 1)
  grow("Intro line\n\nA paragraph\n#tag more\n\nAfter\n", 1)
  grow("Intro line\n\nA paragraph\n<div>\n\nAfter\n", 1)
  grow("Intro line\n\nA paragraph\n-\n\nAfter\n", 1)
})

test("a text that is replaced, not extended, is read whole", () => {
  const first = lexMarkdown("One\n\nTwo\n\nThree\n\nFour")
  const second = lexMarkdown("Alpha\n\nBeta\n\nGamma\n\nDelta", first)
  expect(JSON.stringify(second.tokens)).toBe(
    JSON.stringify(whole("Alpha\n\nBeta\n\nGamma\n\nDelta")),
  )
  expect(second.tokens[0]).not.toBe(first.tokens[0])
})

test("an empty text and a short text give no settled tokens", () => {
  expect(lexMarkdown("").tokens).toEqual([])
  expect(lexMarkdown("Only one block").settled).toBe(0)
})

test("reading the end of a long reply costs far less than reading it whole", () => {
  const block = "A paragraph of plain words that goes on for a while, then ends.\n\n"
  const base = block.repeat(2000)
  // The texts are made before the timing starts. A part of a reply is the text so far, plus a tail.
  const texts = Array.from({ length: 20 }, (_, i) => `${base}tail ${i}`)
  const first = lexMarkdown(base)
  // A time is the best of several runs. A pause of the computer, or of the memory cleaner, in one
  // run is not the cost of the reading, and a busy test computer has such pauses.
  const best = (times: number, run: () => void) => {
    let least = Number.POSITIVE_INFINITY
    for (let i = 0; i < times; i++) {
      const start = performance.now()
      run()
      least = Math.min(least, performance.now() - start)
    }
    return least
  }
  best(2, () => {
    let previous = first
    for (const text of texts) previous = lexMarkdown(text, previous)
  }) // warm up
  const part =
    best(7, () => {
      let previous = first
      for (const text of texts) previous = lexMarkdown(text, previous)
    }) / texts.length
  const whole = best(3, () => lexMarkdown(texts[0] ?? ""))
  // A reading of the end is 40 to 200 times cheaper here, depending on the computer. If it went
  // back to a whole reading, the two costs would be the same. A fifth sits far from both.
  expect(part).toBeLessThan(whole / 5)
})
