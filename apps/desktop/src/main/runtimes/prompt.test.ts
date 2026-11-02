import { describe, expect, test } from "bun:test"
import type { Turn } from "../providers/chat.ts"
import { buildBlocks, buildPrompt } from "./prompt.ts"

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

const user = (content: string): Turn => ({ role: "user", content })
const reply = (content: string): Turn => ({ role: "assistant", content })

/** A chat of `n` messages of the user, each followed by a reply, and ending with the user. */
const chat = (n: number, size = 40): Turn[] =>
  Array.from({ length: n }, (_, i) => [
    user(`q${i}`.padEnd(size, "x")),
    ...(i < n - 1 ? [reply(`a${i}`.padEnd(size, "y"))] : []),
  ]).flat()

const startsWith = (blocks: readonly string[], head: readonly string[]) =>
  head.every((block, i) => blocks[i] === block)

describe("buildBlocks", () => {
  test("one block for each message, each with its label, after one fixed first block", () => {
    const blocks = buildBlocks([user("hello"), reply("hi there"), user("and now?")])
    expect(blocks).toHaveLength(4)
    expect(blocks[0]).toContain("Answer the last message of the user")
    expect(blocks.slice(1)).toEqual(["User: hello", "You: hi there", "User: and now?"])
  })

  test("a tool turn and an empty message are left out, and the text is trimmed", () => {
    const blocks = buildBlocks([
      user("  one  "),
      { role: "tool", callId: "c1", name: "shell", content: "output" },
      reply("   "),
      reply("two"),
      user("three"),
    ])
    expect(blocks.slice(1)).toEqual(["User: one", "You: two", "User: three"])
  })

  test("the program answers the last message of the user, so a reply at the end is left out", () => {
    const blocks = buildBlocks([user("ask"), reply("answer")])
    expect(blocks.slice(1)).toEqual(["User: ask"])
  })

  test("a chat with no text, or with no message of the user, still gives something to send", () => {
    expect(buildBlocks([])).toEqual(["(no text)"])
    expect(buildBlocks([reply("only a reply")])).toEqual(["only a reply"])
  })

  test("the newest message is cut at 100 000 characters", () => {
    const blocks = buildBlocks([user("x".repeat(150_000))])
    expect(blocks.at(-1)).toHaveLength("User: ".length + 100_000)
  })

  test("the blocks of a turn are the blocks of the turn before, with new ones at the end", () => {
    for (let n = 2; n <= 12; n++) {
      const before = buildBlocks(chat(n - 1))
      const now = buildBlocks(chat(n))
      expect(startsWith(now, before)).toBe(true)
      expect(now.length).toBeGreaterThan(before.length)
    }
  })

  test("a history under the limit has no mark for left out messages", () => {
    expect(buildBlocks(chat(10)).some((b) => b.startsWith("(The oldest"))).toBe(false)
  })

  test("the oldest messages go when the history is too long, and the newest one always stays", () => {
    const turns = chat(30)
    const blocks = buildBlocks(turns, 400)
    expect(blocks[1]).toContain("The oldest messages")
    expect(blocks.at(-1)).toBe(`User: ${turns.at(-1)?.content}`)
    const kept = blocks.slice(2)
    expect(kept.reduce((sum, b) => sum + b.length + 2, 0)).toBeLessThanOrEqual(400 + 2)
  })

  test("the cut moves in steps, so the start of the text stays the same for several turns", () => {
    const limit = 2000
    let moved = 0
    let turnsOver = 0
    for (let n = 2; n <= 120; n++) {
      const blocks = buildBlocks(chat(n), limit)
      if (blocks[1]?.startsWith("(The oldest")) turnsOver++
      if (!startsWith(blocks, buildBlocks(chat(n - 1), limit))) moved++
    }
    // A cut at each turn would move about as often as there are turns over the limit. A step of
    // a quarter of the limit, about five turns of this size, moves a fifth as often.
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThanOrEqual(Math.ceil(turnsOver / 4))
  })

  test("a cut leaves at least three quarters of the limit, less one message", () => {
    const limit = 2000
    for (let n = 30; n <= 120; n++) {
      const kept = buildBlocks(chat(n), limit).slice(2)
      const size = kept.reduce((sum, b) => sum + b.length + 2, 0)
      expect(size).toBeLessThanOrEqual(limit + 2)
      expect(size).toBeGreaterThanOrEqual(limit * 0.75 - 50)
    }
  })

  test("with small messages, the cut moves rarely, because a step is a part of the limit and not a count of blocks", () => {
    // Messages of 150 characters and the limit of the app. A step of eight blocks would move
    // the cut every four turns here, and write the whole history again each time.
    let moved = 0
    let over = 0
    for (let n = 2; n <= 600; n++) {
      const blocks = buildBlocks(chat(n, 150))
      if (blocks[1]?.startsWith("(The oldest")) over++
      if (!startsWith(blocks, buildBlocks(chat(n - 1, 150)))) moved++
    }
    expect(over).toBeGreaterThan(300)
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThanOrEqual(12)
  })

  test("the same turns always give the same blocks", () => {
    const turns = chat(25)
    expect(buildBlocks(turns, 400)).toEqual(buildBlocks(turns, 400))
  })
})
