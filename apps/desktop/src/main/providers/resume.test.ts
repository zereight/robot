import { describe, expect, test } from "bun:test"
import type { MessagePart } from "@robot/shared"
import { resumeOf } from "./resume.ts"

const tool = (
  id: string,
  state: "running" | "waiting" | "done" | "failed",
  extra: Partial<Extract<MessagePart, { kind: "tool" }>> = {},
): MessagePart => ({
  kind: "tool",
  id,
  name: "run_command",
  label: "run_command",
  state,
  input: `{"command":"${id}"}`,
  output: state === "done" ? `out ${id}` : "",
  ...extra,
})
const ask = { kind: "approval", summary: "rm x" } as const

describe("resume after a restart", () => {
  test("a card that waits gives the turns so far and the call", () => {
    const resume = resumeOf([
      { kind: "text", text: "I will do it." },
      tool("a", "waiting", { ask }),
    ])
    expect(resume?.call).toEqual({ id: "a", name: "run_command", input: '{"command":"a"}' })
    expect(resume?.turns).toEqual([
      {
        role: "assistant",
        content: "I will do it.",
        toolCalls: [{ id: "a", name: "run_command", input: '{"command":"a"}' }],
      },
    ])
  })

  test("earlier rounds keep their results, in order", () => {
    const resume = resumeOf([
      { kind: "thinking", text: "hm" },
      { kind: "text", text: "First." },
      tool("a", "done"),
      { kind: "text", text: "Second." },
      tool("b", "failed", { output: "no" }),
      tool("c", "waiting", { ask: { kind: "question", question: "Which?", choices: ["x", "y"] } }),
    ])
    expect(resume?.turns.map((t) => t.role)).toEqual(["assistant", "tool", "assistant", "tool"])
    expect(resume?.turns[1]).toEqual({
      role: "tool",
      callId: "a",
      name: "run_command",
      content: "out a",
    })
    // The failed step b and the waiting step c belong to one round: c has no result yet.
    const round = resume?.turns[2]
    expect(round?.role === "assistant" && round.toolCalls?.map((c) => c.id)).toEqual(["b", "c"])
    expect(resume?.turns[3]).toMatchObject({ role: "tool", callId: "b", content: "no" })
    expect(resume?.call.id).toBe("c")
  })

  test("no result without a card that waits", () => {
    expect(resumeOf([])).toBeUndefined()
    expect(resumeOf([{ kind: "text", text: "hi" }])).toBeUndefined()
    expect(resumeOf([tool("a", "done")])).toBeUndefined()
    // A card that waits but has no request cannot be shown again.
    expect(resumeOf([tool("a", "waiting")])).toBeUndefined()
  })

  test("a step that was running cannot be resumed", () => {
    expect(resumeOf([tool("a", "running"), tool("b", "waiting", { ask })])).toBeUndefined()
    expect(resumeOf([tool("a", "waiting", { ask }), tool("b", "waiting", { ask })])).toBeUndefined()
  })
})
