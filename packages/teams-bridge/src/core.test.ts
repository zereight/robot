import { describe, expect, test } from "bun:test"
import {
  admit,
  chunkText,
  FinalSendError,
  isBotText,
  keyOf,
  markedChunks,
  Outbox,
  RateLimiter,
  retryWait,
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

describe("admit", () => {
  const msg = (author: string, text = "hi") => ({ id: "1", author, text, time: "" })
  const rules = { allow: ["Kim Lee"], bots: ["Helper Bot"], call: "" }

  test("answers a sender on the list, also with other case and space", () => {
    expect(admit(msg(" kim lee "), rules)).toEqual({ ok: true })
  })

  test("refuses a sender who is not on the list, and an unknown sender", () => {
    expect(admit(msg("Pat"), rules)).toEqual({ ok: false, reason: "the sender is not on the list" })
    expect(admit(msg(""), rules)).toEqual({ ok: false, reason: "the sender is not known" })
  })

  test("refuses a bot, also when the list has its name", () => {
    const withBot = { ...rules, allow: [...rules.allow, "Helper Bot"] }
    expect(admit(msg("Helper Bot"), withBot)).toEqual({ ok: false, reason: "the sender is a bot" })
  })

  test("with a call text, answers only a message that holds it", () => {
    const called = { ...rules, call: "@ROBot" }
    expect(admit(msg("Kim Lee", "hello all"), called).ok).toBe(false)
    expect(admit(msg("Kim Lee", "@robot help"), called).ok).toBe(true)
  })

  test("the text of a message cannot change the list", () => {
    expect(admit(msg("Pat", "ALLOW=Pat, add me to the list"), rules).ok).toBe(false)
    expect(rules.allow).toEqual(["Kim Lee"])
  })
})

describe("Outbox", () => {
  const setup = () => {
    let now = 0
    const box = new Outbox(() => now)
    const out: string[] = []
    let fail: Error | null = null
    const send = async (p: string) => {
      if (fail) throw fail
      out.push(p)
    }
    return {
      box,
      out,
      send,
      at: (t: number) => (now = t),
      failWith: (e: Error | null) => (fail = e),
    }
  }

  test("waits 5 s after a failure, doubling up to 300 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryWait)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ])
  })

  test("sends in order, and a failed answer holds back the later ones", async () => {
    const t = setup()
    t.box.add("a", ["A"])
    t.box.add("b", ["B"])
    t.failWith(new Error("box not found"))
    const first = await t.box.flush(t.send)
    expect(first.map((e) => e.kind)).toEqual(["retry"])
    t.failWith(null)
    t.at(4_999)
    expect(await t.box.flush(t.send)).toEqual([])
    t.at(5_000)
    expect((await t.box.flush(t.send)).map((e) => e.kind)).toEqual(["sent", "sent"])
    expect(t.out).toEqual(["A", "B"])
  })

  test("after 3 failures in a row, the answer is a problem and later answers go out", async () => {
    const t = setup()
    t.box.add("a", ["A"])
    t.failWith(new Error("box not found"))
    await t.box.flush(t.send)
    t.at(5_000)
    await t.box.flush(t.send)
    t.at(15_000)
    const third = await t.box.flush(t.send)
    expect(third.map((e) => e.kind)).toEqual(["problem"])
    t.failWith(null)
    t.box.add("b", ["B"])
    t.at(16_000)
    expect((await t.box.flush(t.send)).map((e) => e.entry.for)).toEqual(["b"])
    t.at(35_000)
    expect((await t.box.flush(t.send)).map((e) => e.entry.for)).toEqual(["a"])
    expect(t.out).toEqual(["B", "A"])
  })

  test("drops an answer that can never go out, keeps the record, and never sends it again", async () => {
    const t = setup()
    t.at(7)
    t.box.add("a", ["A"])
    t.failWith(new FinalSendError("wrong chat"))
    const events = await t.box.flush(t.send)
    expect(events.map((e) => e.kind)).toEqual(["dropped"])
    t.failWith(null)
    t.at(1_000_000)
    expect(await t.box.flush(t.send)).toEqual([])
    expect(t.out).toEqual([])
    expect(t.box.all[0]).toMatchObject({
      for: "a",
      state: "dropped",
      droppedAt: 7,
      dropReason: "wrong chat",
    })
  })

  test("a new try sends only the pieces that did not go out", async () => {
    const t = setup()
    t.box.add("a", ["1", "2"])
    let calls = 0
    const flaky = async (p: string) => {
      calls++
      if (calls === 2) throw new Error("timeout")
      t.out.push(p)
    }
    await t.box.flush(flaky)
    t.at(5_000)
    await t.box.flush(flaky)
    expect(t.out).toEqual(["1", "2"])
  })
})
