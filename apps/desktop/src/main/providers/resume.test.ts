import { describe, expect, test } from "bun:test"
import { GO_ON_MESSAGE, KEEP_GOING_MESSAGE, type MessagePart } from "@robot/shared"
import { goOnTurns, resumeOf } from "./resume.ts"

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

describe("the turns of a turn that goes on", () => {
  const base = [{ role: "user" as const, content: "Fix it" }]
  const parts: MessagePart[] = [
    { kind: "text", text: "Started." },
    tool("a", "done"),
    // A note of the chat is no part of the work: the model never reads it.
    { kind: "note", note: "kept_going", n: 1, of: 8 },
  ]

  test("the backup model gets its own message, and the keep going message is another", () => {
    const backup = goOnTurns(base, parts, { steps: true })
    expect(backup.at(-1)).toMatchObject({ role: "user" })
    expect(String(backup.at(-1)?.content)).toContain(GO_ON_MESSAGE)
    const keep = goOnTurns(base, parts, { steps: true, message: KEEP_GOING_MESSAGE })
    expect(String(keep.at(-1)?.content)).toContain(KEEP_GOING_MESSAGE)
    expect(JSON.stringify(keep)).not.toContain(GO_ON_MESSAGE)
  })

  test("the work so far is kept, and the muted line is not", () => {
    const keep = goOnTurns(base, parts, { steps: true, message: KEEP_GOING_MESSAGE })
    expect(keep.map((t) => t.role)).toEqual(["user", "assistant", "tool", "user"])
    expect(JSON.stringify(keep)).not.toContain("kept_going")
    expect(String(keep.at(-1)?.content)).toContain("Steps so far:\n- run_command")
  })

  test("with no work yet, the message joins the last message of the user", () => {
    const keep = goOnTurns(base, [], { steps: true, message: KEEP_GOING_MESSAGE })
    expect(keep).toHaveLength(1)
    expect(String(keep[0]?.content)).toBe(`Fix it\n\n${KEEP_GOING_MESSAGE}`)
  })
})
