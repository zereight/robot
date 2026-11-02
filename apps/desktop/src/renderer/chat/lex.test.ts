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

test("the work for a part does not grow with the length of the reply", () => {
  const block = "A paragraph of plain words that goes on for a while, then ends.\n\n"
  const read = (blocks: number) => {
    let previous = lexMarkdown(block.repeat(blocks))
    const t = performance.now()
    for (let i = 0; i < 30; i++)
      previous = lexMarkdown(`${block.repeat(blocks)}tail ${i}`, previous)
    return performance.now() - t
  }
  read(50) // warm up
  const small = read(100)
  const large = read(2000)
  // 20 times the text. A whole reading would cost about 20 times more; a reading of the end does not.
  expect(large).toBeLessThan(small * 8 + 20)
})
