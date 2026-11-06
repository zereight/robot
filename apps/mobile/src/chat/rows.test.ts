import { describe, expect, test } from "bun:test"
import type { MessagePart } from "@robot/shared"
import { buildRows, quoteText, type RowMessage, waitingTool } from "./rows.ts"

const day = new Date(2026, 9, 20, 10, 0).getTime()
const msg = (id: string, at: number, extra: Partial<RowMessage> = {}): RowMessage => ({
  id,
  author: "agent",
  agentId: "a1",
  parts: [{ kind: "text", text: id }],
  createdAt: at,
  replyTo: null,
  ...extra,
})

describe("rows of a conversation", () => {
  test("one sender within 5 minutes shares a header; a date line starts each day", () => {
    const rows = buildRows([
      msg("m1", day),
      msg("m2", day + 60_000),
      msg("m3", day + 7 * 60_000),
      msg("m4", day + 8 * 60_000, { author: "user", agentId: null }),
      msg("m5", day + 24 * 3600_000),
    ])
    expect(rows.map((r) => (r.kind === "date" ? "date" : `${r.key}:${r.head}`))).toEqual([
      "date",
      "m1:true",
      "m2:false",
      "m3:true",
      "m4:true",
      "date",
      "m5:true",
    ])
  })

  test("another agent and a reply start a new header", () => {
    const rows = buildRows([
      msg("m1", day),
      msg("m2", day + 1000, { agentId: "a2" }),
      msg("m3", day + 2000, { agentId: "a2", replyTo: "m1" }),
    ])
    expect(
      rows.filter((r) => r.kind === "message").map((r) => r.kind === "message" && r.head),
    ).toEqual([true, true, true])
  })

  test("a quote line is the first words of the text, without tool parts", () => {
    const parts: MessagePart[] = [
      { kind: "thinking", text: "hidden" },
      { kind: "text", text: "Hello\n\nthere   friend" },
    ]
    expect(quoteText({ parts })).toBe("Hello there friend")
    expect(quoteText({ parts: [{ kind: "text", text: "x".repeat(100) }] }, 10)).toBe(
      `${"x".repeat(9)}…`,
    )
    expect(quoteText(undefined)).toBe("")
  })

  test("the card that waits for the user", () => {
    const tool = {
      kind: "tool" as const,
      id: "c1",
      name: "run_command",
      label: "ls",
      state: "waiting" as const,
      input: "",
      output: "",
      ask: { kind: "approval" as const, summary: "ls" },
    }
    expect(waitingTool({ parts: [tool] })?.id).toBe("c1")
    expect(waitingTool({ parts: [{ ...tool, state: "done" }] })).toBeUndefined()
  })
})
