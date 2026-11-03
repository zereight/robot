import { describe, expect, test } from "bun:test"
import {
  askAllowsAlways,
  askKind,
  type ChatMessage,
  handedOverOf,
  handoverOf,
  isNoteOnly,
  type MessagePart,
  messageText,
  startsGroup,
  userWords,
} from "./chat.ts"

const msg = (
  author: "user" | "agent",
  createdAt: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: String(createdAt),
  agentId: "a",
  author,
  parts: [{ kind: "text", text: "hi" }],
  status: "done",
  error: null,
  replyTo: null,
  model: null,
  createdAt,
  editedAt: null,
  fromDevice: null,
  ...extra,
})

describe("chat", () => {
  const noon = new Date(2026, 10, 1, 12, 0).getTime()

  test("rows from one sender within 5 minutes join", () => {
    expect(startsGroup(undefined, msg("user", noon))).toBe(true)
    expect(startsGroup(msg("user", noon), msg("user", noon + 4 * 60_000))).toBe(false)
    expect(startsGroup(msg("user", noon), msg("user", noon + 6 * 60_000))).toBe(true)
    expect(startsGroup(msg("user", noon), msg("agent", noon + 1000))).toBe(true)
  })

  test("a new day starts a new group", () => {
    const late = new Date(2026, 10, 1, 23, 58).getTime()
    expect(startsGroup(msg("user", late), msg("user", late + 3 * 60_000))).toBe(true)
  })

  test("message text leaves out thinking and tools", () => {
    expect(
      messageText({
        parts: [
          { kind: "thinking", text: "hmm" },
          { kind: "text", text: "a" },
          { kind: "text", text: "b" },
        ],
      }),
    ).toBe("ab")
  })
})

describe("the choices of a card that waits", () => {
  test("only an approval that does not ask each time has Always allow", () => {
    expect(askAllowsAlways({ kind: "approval", summary: "ls" })).toBe(true)
    expect(askAllowsAlways({ kind: "approval", summary: "ls", once: false })).toBe(true)
    expect(askAllowsAlways({ kind: "approval", summary: "/work", once: true })).toBe(false)
    expect(askAllowsAlways({ kind: "question", question: "Which?", choices: ["a"] })).toBe(false)
    const article = { kind: "article", title: "A", before: "x", after: null } as const
    expect(askAllowsAlways(article)).toBe(false)
    // The island counts an article card as an approval, but it still has no Always allow.
    expect(askKind(article)).toBe("approval")
  })
})

describe("the handover card and its line (spec 003, 007)", () => {
  const card: MessagePart = {
    kind: "handover",
    brief: "Handover from Ada\n\nFirst request:\nSECRET PLAN OF THE CARD",
    fromName: "Ada",
    fromAgentId: "a1",
    fromThreadId: null,
  }
  const line: MessagePart = {
    kind: "note",
    note: "handed_over",
    toName: "Bo",
    toAgentId: "b1",
    toThreadId: "t1",
  }

  test("a card and a line are found by their part", () => {
    expect(handoverOf(msg("user", 1, { parts: [card] }))).toEqual(card)
    expect(handoverOf(msg("user", 1))).toBeUndefined()
    expect(handedOverOf(msg("agent", 1, { parts: [line] }))).toEqual(line)
    expect(handedOverOf(msg("agent", 1, { parts: [card] }))).toBeUndefined()
  })

  test("the line is a muted note and no turn; the card is a turn of the chat for the model", () => {
    expect(isNoteOnly([line])).toBe(true)
    expect(isNoteOnly([card])).toBe(false)
  })

  test("the card is no words of the user: only the typed text and other messages of the user count", () => {
    const words = userWords([
      msg("user", 1, { parts: [card] }),
      msg("user", 2, { parts: [{ kind: "text", text: "Finish the tests" }] }),
      msg("agent", 3, { parts: [{ kind: "text", text: "Echo" }] }),
      msg("user", 4, {
        parts: [{ kind: "file", name: "a.txt", path: "attachments/a.txt", size: 1 }],
      }),
      msg("user", 5, { parts: [{ kind: "text", text: "   " }] }),
    ])
    expect(words).toEqual(["Finish the tests"])
    expect(words.join("\n")).not.toContain("SECRET PLAN OF THE CARD")
  })

  test("the message after a card starts a new group, with its own header", () => {
    const first = msg("user", 1_700_000_000_000, { parts: [card] })
    const next = msg("user", 1_700_000_000_000 + 1000)
    expect(startsGroup(first, next)).toBe(true)
    expect(startsGroup(msg("user", 1_700_000_000_000), next)).toBe(false)
  })
})
