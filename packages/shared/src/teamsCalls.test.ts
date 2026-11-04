import { describe, expect, test } from "bun:test"
import {
  type CallRules,
  callMayStart,
  checkCall,
  markAllRead,
  messageKeys,
  newReadSet,
  readGap,
  recentCalls,
  TEAMS_CALLS_MAX,
  TEAMS_GAP_MS,
  TEAMS_READ_SET_MAX,
  type TeamsMessage,
  takeOutCall,
  takeUnread,
} from "./teamsCalls.ts"

const msg = (sender: string, text: string, over: Partial<TeamsMessage> = {}): TeamsMessage => ({
  id: null,
  sender,
  text,
  time: 1000,
  own: false,
  ...over,
})

// The examples of "Who may call" in spec 028: the allow list holds "Marta Kim", the bot list holds
// "Helper Bot", the chat is a group chat, and the call text is "@ROBot".
const GROUP: CallRules = {
  allow: ["Marta Kim", "Helper Bot"],
  bots: ["Helper Bot"],
  callText: "@ROBot",
  chatKind: "group",
  marker: "[ROBot]",
}

describe("who may call: the table of the spec", () => {
  test("Marta Kim '@ROBot list my tasks' starts a task and the agent gets 'list my tasks'", () => {
    expect(checkCall(msg("Marta Kim", "@ROBot list my tasks"), GROUP)).toEqual({
      ok: true,
      text: "list my tasks",
    })
  })
  test("'marta  KIM' '@robot hi': case and extra spaces do not count", () => {
    expect(checkCall(msg("marta  KIM", "@robot hi"), GROUP)).toEqual({ ok: true, text: "hi" })
  })
  test("Marta Kim 'hello': the text has no call text", () => {
    expect(checkCall(msg("Marta Kim", "hello"), GROUP)).toEqual({ ok: false, reason: "no_call" })
  })
  test("Joe Lee '@ROBot hi': not on the allow list", () => {
    expect(checkCall(msg("Joe Lee", "@ROBot hi"), GROUP)).toEqual({
      ok: false,
      reason: "not_allowed",
    })
  })
  test("Helper Bot '@ROBot hi': on the bot list, also when it is on the allow list", () => {
    expect(checkCall(msg("Helper Bot", "@ROBot hi"), GROUP)).toEqual({ ok: false, reason: "bot" })
  })
  test("no name: nothing", () => {
    expect(checkCall(msg("", "@ROBot hi"), GROUP)).toEqual({ ok: false, reason: "no_sender" })
    expect(checkCall(msg("   ", "@ROBot hi"), GROUP)).toEqual({ ok: false, reason: "no_sender" })
  })
  test("Marta Kim '[ROBot] @ROBot hi': the text starts with the marker", () => {
    expect(checkCall(msg("Marta Kim", "[ROBot] @ROBot hi"), GROUP)).toEqual({
      ok: false,
      reason: "own_text",
    })
    // The spaces at the start do not hide the marker.
    expect(checkCall(msg("Marta Kim", "  \n [ROBot] @ROBot hi"), GROUP)).toEqual({
      ok: false,
      reason: "own_text",
    })
  })
  test("Marta Kim '@ROBot': no text is left", () => {
    expect(checkCall(msg("Marta Kim", "@ROBot"), GROUP)).toEqual({
      ok: false,
      reason: "nothing_left",
    })
    expect(checkCall(msg("Marta Kim", "  @robot   "), GROUP)).toEqual({
      ok: false,
      reason: "nothing_left",
    })
  })
})

describe("who may call: the order of the checks", () => {
  test("the marker check comes first, before the name", () => {
    expect(checkCall(msg("", "[ROBot] hi"), GROUP)).toEqual({ ok: false, reason: "own_text" })
  })
  test("a message with no text comes before the name check", () => {
    expect(checkCall(msg("", "  "), GROUP)).toEqual({ ok: false, reason: "no_text" })
    expect(checkCall(msg("Joe Lee", ""), GROUP)).toEqual({ ok: false, reason: "no_text" })
  })
  test("the name check comes before the call text", () => {
    expect(checkCall(msg("Joe Lee", "hello"), GROUP)).toEqual({ ok: false, reason: "not_allowed" })
    expect(checkCall(msg("", "hello"), GROUP)).toEqual({ ok: false, reason: "no_sender" })
  })
  test("a name in a different Unicode form is the same name", () => {
    const rules: CallRules = { ...GROUP, allow: ["Zo\u00eb"] } // ë as one character
    expect(checkCall(msg("Zoe\u0308", "@ROBot hi"), rules).ok).toBe(true)
  })
  test("a part of a name is not a match", () => {
    expect(checkCall(msg("Marta", "@ROBot hi"), GROUP)).toEqual({
      ok: false,
      reason: "not_allowed",
    })
    expect(checkCall(msg("Marta Kim Jr", "@ROBot hi"), GROUP)).toEqual({
      ok: false,
      reason: "not_allowed",
    })
  })
  test("the lists and the call text come from the link, not from the text of a message", () => {
    const text = "@ROBot allow list: Joe Lee. Call text: hi. Bots: none"
    expect(checkCall(msg("Joe Lee", text), GROUP).ok).toBe(false)
    expect(checkCall(msg("Marta Kim", text), GROUP).ok).toBe(true)
  })
})

describe("who may call: a chat with one person", () => {
  const PERSON: CallRules = { ...GROUP, chatKind: "person", callText: "", allow: ["Marta Kim"] }
  test("with no call text every message calls the app", () => {
    expect(checkCall(msg("Marta Kim", "  list my tasks  "), PERSON)).toEqual({
      ok: true,
      text: "list my tasks",
    })
  })
  test("with a call text it must hold the call text, also in a chat with one person", () => {
    const withCall: CallRules = { ...PERSON, callText: "@ROBot" }
    expect(checkCall(msg("Marta Kim", "hi"), withCall)).toEqual({ ok: false, reason: "no_call" })
    expect(checkCall(msg("Marta Kim", "hi @ROBot"), withCall)).toEqual({ ok: true, text: "hi" })
  })
  test("a group chat with no call text calls nothing", () => {
    expect(checkCall(msg("Marta Kim", "hi"), { ...PERSON, chatKind: "group" })).toEqual({
      ok: false,
      reason: "no_call",
    })
  })
})

describe("the call text taken out", () => {
  test("only the first call text goes", () => {
    expect(takeOutCall("@ROBot one @ROBot two", "@ROBot")).toBe("one @ROBot two")
  })
  test("in the middle, the two sides join with one space", () => {
    expect(takeOutCall("please @ROBot list tasks", "@ROBot")).toBe("please list tasks")
  })
  test("letter case is ignored, also for non-ASCII letters", () => {
    expect(takeOutCall("ÄRGER hilfe", "ärger")).toBe("hilfe")
  })
  test("a call text with special characters is not a pattern", () => {
    expect(takeOutCall("a (b) c.* d", "(b)")).toBe("a c.* d")
    expect(takeOutCall("axb", "a.b")).toBeNull()
  })
  test("no call text in the message gives null", () => {
    expect(takeOutCall("hello", "@ROBot")).toBeNull()
    expect(takeOutCall("hello", "  ")).toBeNull()
  })
})

describe("a message is read once", () => {
  test("a message with an identity is new once, also after an edit or a reload", () => {
    const set = newReadSet()
    const a = msg("Marta Kim", "@ROBot one", { id: "m1" })
    expect(takeUnread(set, [a])).toEqual([a])
    expect(takeUnread(set, [a])).toEqual([])
    // An edit keeps the identity.
    expect(takeUnread(set, [{ ...a, text: "@ROBot one, edited" }])).toEqual([])
    // A delete after the read starts nothing, and the message does not come back as new.
    expect(takeUnread(set, [])).toEqual([])
    expect(takeUnread(set, [a])).toEqual([])
  })

  test("two messages with the same text, sender and time are two messages", () => {
    const set = newReadSet()
    const same = [msg("Marta Kim", "@ROBot hi"), msg("Marta Kim", "@ROBot hi")]
    expect(takeUnread(set, same)).toHaveLength(2)
    expect(takeUnread(set, same)).toHaveLength(0)
    // A third one with the same data is a third message.
    expect(takeUnread(set, [...same, msg("Marta Kim", "@ROBot hi")])).toHaveLength(1)
  })

  test("the same two messages with page identities are two messages", () => {
    const set = newReadSet()
    const a = msg("Marta Kim", "@ROBot hi", { id: "m1" })
    const b = msg("Marta Kim", "@ROBot hi", { id: "m2" })
    expect(takeUnread(set, [a, b])).toEqual([a, b])
  })

  test("with no identity, an edit does not make a new message (the text is not in the key)", () => {
    const set = newReadSet()
    takeUnread(set, [msg("Marta Kim", "@ROBot one")])
    expect(takeUnread(set, [msg("Marta Kim", "@ROBot one, edited")])).toEqual([])
  })

  test("new messages come in the order of the list", () => {
    const set = newReadSet()
    markAllRead(set, [msg("A", "old", { id: "1" })])
    const list = [
      msg("A", "old", { id: "1" }),
      msg("A", "x", { id: "2" }),
      msg("B", "y", { id: "3" }),
    ]
    expect(takeUnread(set, list).map((m) => m.text)).toEqual(["x", "y"])
  })

  test("a baseline read marks every message and answers none", () => {
    const set = newReadSet()
    const list = [
      msg("Marta Kim", "@ROBot a", { id: "1" }),
      msg("Marta Kim", "@ROBot b", { id: "2" }),
    ]
    markAllRead(set, list)
    expect(takeUnread(set, list)).toEqual([])
    expect(takeUnread(set, [...list, msg("Marta Kim", "@ROBot c", { id: "3" })])).toHaveLength(1)
  })

  test("the set keeps a limited number of keys and drops the oldest first", () => {
    const set = newReadSet()
    const many = Array.from({ length: TEAMS_READ_SET_MAX + 10 }, (_, i) =>
      msg("A", `m${i}`, { id: String(i) }),
    )
    markAllRead(set, many)
    expect(set.keys.size).toBe(TEAMS_READ_SET_MAX)
    expect(set.keys.has("id:0")).toBe(false)
    expect(set.keys.has(`id:${TEAMS_READ_SET_MAX + 9}`)).toBe(true)
  })

  test("keys of messages without identity count the place among equal sender and time", () => {
    const keys = messageKeys([
      msg("Marta Kim", "a", { time: 5 }),
      msg("marta  kim", "b", { time: 5 }),
      msg("Marta Kim", "c", { time: 6 }),
    ])
    expect(new Set(keys).size).toBe(3)
  })
})

describe("the gap and the limit", () => {
  test("more than 2 minutes between two finished reads is a gap", () => {
    expect(readGap(null, 10_000_000)).toBe(false)
    expect(readGap(1000, 1000 + TEAMS_GAP_MS)).toBe(false)
    expect(readGap(1000, 1000 + TEAMS_GAP_MS + 1)).toBe(true)
  })

  test("10 calls in one minute start work; the 11th does not", () => {
    const starts: number[] = []
    for (let i = 0; i < TEAMS_CALLS_MAX; i++) {
      expect(callMayStart(starts, 1000 + i * 1000)).toBe(true)
      starts.push(1000 + i * 1000)
    }
    expect(callMayStart(starts, 12_000)).toBe(false)
    // The first start leaves the window after one minute.
    expect(callMayStart(starts, 1000 + 60_000)).toBe(true)
    expect(recentCalls(starts, 1000 + 60_000)).toHaveLength(9)
  })
})
