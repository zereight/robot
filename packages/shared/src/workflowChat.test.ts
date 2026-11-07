import { describe, expect, test } from "bun:test"
import { foldedToolsKey } from "./chat.ts"
import { translate } from "./i18n/index.ts"
import { defaultSettings } from "./settings.ts"
import {
  type ChatPart,
  type ChatToolPart,
  editableMessageId,
  editRefusal,
  groupChatParts,
  isFoldableChatTool,
  isReadableReply,
  NO_UNREAD,
  unreadOf,
  type WorkflowChatMessage,
} from "./workflowChat.ts"

const tool = (
  id: string,
  state: ChatToolPart["state"] = "done",
  extra: Partial<ChatToolPart> = {},
): ChatToolPart => ({
  kind: "tool",
  id,
  name: "read_workflow",
  label: "Read",
  state,
  input: "{}",
  output: "",
  ...extra,
})
const text = (value: string): ChatPart => ({ kind: "text", text: value })
const thought = (value: string): ChatPart => ({ kind: "thinking", text: value })
const counts = (parts: readonly ChatPart[], fold = true) =>
  groupChatParts(parts, fold).map((s) => (s.kind === "tools" ? s.parts.length : s.part.kind))

describe("folded tool steps (spec 003, 013)", () => {
  test('"Show tool steps" is on at first', () => {
    expect(defaultSettings.showToolSteps).toBe(true)
  })

  test("a finished or running plain step may fold; a failed, refused or marked step may not", () => {
    expect(isFoldableChatTool(tool("a", "done"))).toBe(true)
    expect(isFoldableChatTool(tool("a", "running"))).toBe(true)
    expect(isFoldableChatTool(tool("a", "failed"))).toBe(false)
    expect(isFoldableChatTool(tool("a", "done", { notRun: true }))).toBe(false)
    expect(isFoldableChatTool(tool("a", "running", { notRun: true }))).toBe(false)
    for (const name of [
      "memory_save",
      "propose_document_change",
      "propose_prompt_change",
      "propose_graph_change",
      "add_run_feedback",
    ])
      expect(isFoldableChatTool(tool("a", "done", { name }))).toBe(false)
    expect(isFoldableChatTool(tool("a", "done", { name: "memory_search" }))).toBe(true)
    expect(isFoldableChatTool(text("hi"))).toBe(false)
  })

  test("with the switch on, every part is its own row", () => {
    expect(counts([tool("a"), tool("b"), text("x")], false)).toEqual(["tool", "tool", "text"])
    expect(groupChatParts([], true)).toEqual([])
  })

  test("two finished reads in a row are one line with the count 2", () => {
    expect(counts([tool("a"), tool("b")])).toEqual([2])
  })

  test("a text between two reads makes two lines with the count 1 each", () => {
    expect(counts([tool("a"), text("between"), tool("b")])).toEqual([1, "text", 1])
  })

  test("a file, a note and a card that stays open end a series", () => {
    const file: ChatPart = { kind: "file", name: "a", path: "a", size: 1 }
    const note: ChatPart = { kind: "note", note: "proposals_full" }
    expect(counts([tool("a"), file, tool("b"), note, tool("c")])).toEqual([1, "file", 1, "note", 1])
    expect(counts([tool("a"), tool("b", "failed"), tool("c")])).toEqual([1, "tool", 1])
    expect(counts([tool("a"), tool("b", "done", { notRun: true }), tool("c")])).toEqual([
      1,
      "tool",
      1,
    ])
    expect(counts([tool("a"), tool("b", "done", { name: "memory_save" }), tool("c")])).toEqual([
      1,
      "tool",
      1,
    ])
  })

  test("thoughts are not rows: thinking between two steps does not split them", () => {
    expect(
      counts([thought("one"), tool("a"), thought("two"), tool("b"), thought("three")]),
    ).toEqual([2])
    expect(counts([thought("one"), tool("a")], false)).toEqual(["tool"])
  })

  test("the line keeps its place while the series grows: one row, one key, a running step joins", () => {
    const one = groupChatParts([tool("a", "running")], true)
    const two = groupChatParts([tool("a", "done"), tool("b", "running")], true)
    const four = groupChatParts(
      [tool("a"), tool("b"), tool("c", "running"), tool("d", "running")],
      true,
    )
    expect(one).toHaveLength(1)
    expect(two).toHaveLength(1)
    expect(four).toHaveLength(1)
    expect(new Set([one[0]?.key, two[0]?.key, four[0]?.key]).size).toBe(1)
    expect(four[0]?.kind === "tools" ? four[0].parts.map((p) => p.id) : []).toEqual([
      "a",
      "b",
      "c",
      "d",
    ])
  })

  test("a step that fails leaves the series, and the rest stays", () => {
    expect(counts([tool("a"), tool("b", "running")])).toEqual([2])
    expect(counts([tool("a"), tool("b", "failed")])).toEqual([1, "tool"])
  })

  test("the key of a part is its place, so a row survives a new part after it", () => {
    const a = groupChatParts([text("x")], true)
    const b = groupChatParts([text("x longer"), tool("t1")], true)
    expect(a[0]?.key).toBe(b[0]?.key)
  })

  test("one step reads in the singular", () => {
    expect(translate("en", foldedToolsKey(1), { count: 1 })).toBe("1 tool step")
    expect(translate("en", foldedToolsKey(2), { count: 2 })).toBe("2 tool steps")
  })
})

const message = (
  id: string,
  author: "user" | "assistant",
  at: number,
  extra: Partial<WorkflowChatMessage> = {},
): WorkflowChatMessage => ({
  id,
  workflowId: "w",
  author,
  parts: [text(id)],
  status: "done",
  error: null,
  replyTo: null,
  pending: false,
  model: null,
  createdAt: at,
  finishedAt: at,
  ...extra,
})

/** The acceptance chat: eight messages, and the messages 2, 4, 5, 7 and 8 are replies. */
const eight = (): WorkflowChatMessage[] =>
  (
    [
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ] as const
  ).map((author, i) => message(`m${i + 1}`, author, i + 1))

describe("Mark as unread (spec 003)", () => {
  test("only a finished reply with content can be marked", () => {
    expect(isReadableReply({ author: "assistant", status: "done" })).toBe(true)
    expect(isReadableReply({ author: "assistant", status: "stopped" })).toBe(true)
    expect(isReadableReply({ author: "assistant", status: "streaming" })).toBe(false)
    expect(isReadableReply({ author: "assistant", status: "failed" })).toBe(false)
    expect(isReadableReply({ author: "user", status: "done" })).toBe(false)
  })

  test("marking message 5 of eight gives the count 3 (messages 5, 7 and 8)", () => {
    expect(unreadOf(eight(), { id: "m5", at: 5 })).toEqual({ count: 3, firstId: "m5" })
  })

  test("no mark means no unread reply", () => {
    expect(unreadOf(eight(), null)).toEqual(NO_UNREAD)
  })

  test("a reply that still streams, and a failed reply, do not count", () => {
    const list = eight()
    list[7] = message("m8", "assistant", 8, { status: "streaming" })
    expect(unreadOf(list, { id: "m5", at: 5 }).count).toBe(2)
    list[6] = message("m7", "assistant", 7, { status: "failed" })
    expect(unreadOf(list, { id: "m5", at: 5 }).count).toBe(1)
  })

  test("a message of the user at the marked place is not a reply, so only later replies count", () => {
    expect(unreadOf(eight(), { id: "m6", at: 6 })).toEqual({ count: 2, firstId: "m7" })
  })

  test("when the marked message is gone, the first message that is not older takes its place", () => {
    const list = eight().filter((m) => m.id !== "m5")
    expect(unreadOf(list, { id: "m5", at: 5 })).toEqual({ count: 2, firstId: "m7" })
    // Nothing from that place on: nothing is unread.
    expect(unreadOf(eight().slice(0, 4), { id: "m5", at: 5 })).toEqual(NO_UNREAD)
  })
})

describe("Edit of the last message (spec 003; the rules fail closed)", () => {
  const turn = (extra: Partial<WorkflowChatMessage> = {}) => [
    message("u1", "user", 1),
    message("a1", "assistant", 2, extra),
  ]

  test("the last message of the user, answered, with no step after it, can be edited", () => {
    expect(editRefusal(turn(), "u1", false)).toBeNull()
    expect(editableMessageId(turn(), false)).toBe("u1")
  })

  test("while a turn works nothing can be edited", () => {
    expect(editRefusal(turn(), "u1", true)).toBe("working")
    expect(editableMessageId(turn(), true)).toBeNull()
    expect(editRefusal(turn({ status: "streaming" }), "u1", false)).toBe("working")
  })

  test("an earlier message, a reply, a missing message and an unanswered message are refused", () => {
    const two = [...turn(), message("u2", "user", 3), message("a2", "assistant", 4)]
    expect(editRefusal(two, "u1", false)).toBe("not_last")
    expect(editRefusal(two, "a2", false)).toBe("not_last")
    expect(editRefusal(two, "none", false)).toBe("not_last")
    expect(editRefusal([message("u1", "user", 1)], "u1", false)).toBe("not_last")
    expect(editRefusal([message("u1", "user", 1, { pending: true })], "u1", false)).toBe("not_last")
    expect(editableMessageId([], false)).toBeNull()
  })

  test("a step that ran in a later reply blocks the edit; a step that did not happen does not", () => {
    expect(editRefusal(turn({ parts: [tool("a")] }), "u1", false)).toBe("steps_ran")
    expect(editRefusal(turn({ parts: [tool("a", "failed")] }), "u1", false)).toBe("steps_ran")
    expect(
      editRefusal(turn({ parts: [tool("a", "done", { notRun: true })] }), "u1", false),
    ).toBeNull()
    for (const note of [
      { kind: "note", note: "feedback_added", runId: "r", startedAt: 1, nodes: [] },
      {
        kind: "note",
        note: "proposal",
        proposalId: "p",
        proposalKind: "graph",
        nodeNumber: null,
      },
      { kind: "note", note: "memory_saved", text: "x", historyId: "h" },
    ] as const)
      expect(editRefusal(turn({ parts: [note] }), "u1", false)).toBe("steps_ran")
    expect(
      editRefusal(turn({ parts: [{ kind: "note", note: "proposals_full" }] }), "u1", false),
    ).toBeNull()
  })
})
