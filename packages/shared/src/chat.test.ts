import { describe, expect, test } from "bun:test"
import {
  askAllowsAlways,
  askKind,
  type ChatMessage,
  foldedToolsKey,
  groupParts,
  handedOverOf,
  handoverOf,
  isFoldableTool,
  isNoteOnly,
  type MessagePart,
  messageText,
  pictureType,
  startsGroup,
  userWords,
} from "./chat.ts"
import { translate } from "./i18n/index.ts"

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

describe("pictureType", () => {
  test("names the type of the kinds of picture that show above a sent message", () => {
    expect(pictureType("image.png")).toBe("image/png")
    expect(pictureType("photo.jpg")).toBe("image/jpeg")
    expect(pictureType("photo.jpeg")).toBe("image/jpeg")
    expect(pictureType("move.gif")).toBe("image/gif")
    expect(pictureType("pic.webp")).toBe("image/webp")
  })

  test("does not care for the case of the end, and takes the last end", () => {
    expect(pictureType("SHOT.PNG")).toBe("image/png")
    expect(pictureType("a.tar.png")).toBe("image/png")
    expect(pictureType("a.png.exe")).toBeUndefined()
  })

  test("a file that is not such a picture has no type", () => {
    for (const name of ["note.txt", "clip.mov", "vector.svg", "png", ".png.", "", "dir.png/file"])
      expect(pictureType(name)).toBeUndefined()
    // A name that is only an end is still a name with that end.
    expect(pictureType(".png")).toBe("image/png")
  })

  test("a name that holds the name of an object property is no type", () => {
    for (const name of ["a.__proto__", "a.constructor", "a.toString"])
      expect(pictureType(name)).toBeUndefined()
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

describe("folded tool steps", () => {
  type Tool = Extract<MessagePart, { kind: "tool" }>
  let n = 0
  const tool = (state: Tool["state"], extra: Partial<Tool> = {}): Tool => ({
    kind: "tool",
    id: `t${++n}`,
    name: "read_file",
    label: "a.txt",
    state,
    input: "",
    output: "ok",
    ...extra,
  })
  const text = (text: string): MessagePart => ({ kind: "text", text })

  test("only a finished plain card folds", () => {
    expect(isFoldableTool(tool("done"))).toBe(true)
    expect(isFoldableTool(tool("running"))).toBe(false)
    expect(isFoldableTool(tool("waiting"))).toBe(false)
    expect(isFoldableTool(tool("failed"))).toBe(false)
    expect(isFoldableTool(text("hi"))).toBe(false)
  })

  test("a card that waits, was refused, or carries a note stays open", () => {
    expect(isFoldableTool(tool("done", { ask: { kind: "approval", summary: "rm x" } }))).toBe(false)
    expect(isFoldableTool(tool("done", { refused: "rule" }))).toBe(false)
    expect(isFoldableTool(tool("done", { reason: { code: "step_limit" } }))).toBe(false)
    expect(isFoldableTool(tool("done", { decision: { answer: "allow", by: "Mac" } }))).toBe(false)
    expect(isFoldableTool(tool("done", { knowledge: { kind: "read", title: "T" } }))).toBe(false)
    expect(isFoldableTool(tool("done", { memory: { kind: "saved", historyId: "h" } }))).toBe(false)
    expect(isFoldableTool(tool("done", { settings: { changes: [] } }))).toBe(false)
  })

  test("a card with a routine mark still folds", () => {
    expect(isFoldableTool(tool("done", { ruleAllowed: true }))).toBe(true)
    expect(isFoldableTool(tool("done", { checkAllowed: 0.9 }))).toBe(true)
    expect(isFoldableTool(tool("done", { readOnlyTrusted: true }))).toBe(true)
    expect(
      isFoldableTool(tool("done", { connection: { kind: "call", connection: "C", tool: "t" } })),
    ).toBe(true)
  })

  test("with fold off, every part is its own row", () => {
    const parts = [tool("done"), text("hi"), tool("done")]
    expect(groupParts(parts, false)).toEqual(parts.map((part) => ({ kind: "part", part })))
    expect(groupParts([], true)).toEqual([])
  })

  test("with fold on, runs of finished plain cards form one row each", () => {
    const [a, b, c, d] = [tool("done"), tool("done"), tool("done"), tool("done")]
    const middle = text("hi")
    const waiting = tool("waiting")
    const parts = [a, b, middle, c, waiting, d]
    expect(groupParts(parts, true)).toEqual([
      { kind: "tools", parts: [a, b] },
      { kind: "part", part: middle },
      { kind: "tools", parts: [c] },
      { kind: "part", part: waiting },
      { kind: "tools", parts: [d] },
    ])
  })

  test("one step reads in the singular, any other count in the plural", () => {
    expect(translate("en", foldedToolsKey(1), { count: 1 })).toBe("1 tool step")
    expect(translate("en", foldedToolsKey(2), { count: 2 })).toBe("2 tool steps")
    expect(translate("ko", foldedToolsKey(1), { count: 1 })).toBe("도구 단계 1개")
  })
})
