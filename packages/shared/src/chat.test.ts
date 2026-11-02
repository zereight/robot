import { describe, expect, test } from "bun:test"
import { askAllowsAlways, askKind, type ChatMessage, messageText, startsGroup } from "./chat.ts"

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
