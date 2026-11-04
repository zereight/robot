import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CLAUDE_EFFORTS, EFFORT_LEVELS, effortsFor } from "./providers.ts"
import {
  ANSWER_ERROR_MAX,
  ASK_RETRY_MS,
  ASK_TRIES,
  answerError,
  answerStart,
  conditionMode,
  fillTemplate,
  graphProblem,
  NOTE_TONES,
  NOTIFY_BODY_MAX,
  NOTIFY_TITLE_MAX,
  NoteSchema,
  nearestAgentStep,
  nodeNumbers,
  notifyBody,
  parseYesNo,
  retryableFailure,
  STEP_EFFORTS,
  type Step,
  StepSchema,
  stepTurnEffort,
  WORKFLOW_NOTES_MAX,
  WORKFLOW_STEPS_MAX,
  WorkflowInput,
} from "./workflows.ts"

const s = (id: string, kind: "agent" | "condition" | "post" = "agent") => ({ id, kind })

describe("graphProblem", () => {
  test("accepts a chain and a branch", () => {
    expect(graphProblem([s("a"), s("b")], [{ id: "1", from: "a", to: "b" }])).toBeNull()
    expect(
      graphProblem(
        [s("a"), s("c", "condition"), s("d"), s("e")],
        [
          { id: "1", from: "a", to: "c" },
          { id: "2", from: "c", to: "d", branch: "yes" },
          { id: "3", from: "c", to: "e", branch: "no" },
        ],
      ),
    ).toBeNull()
  })
  test("finds the problems", () => {
    expect(graphProblem([], [])).toBe("no_steps")
    expect(graphProblem([s("a"), s("a")], [])).toBe("duplicate_step")
    expect(graphProblem([s("a")], [{ id: "1", from: "a", to: "zzz" }])).toBe("bad_edge")
    expect(graphProblem([s("a")], [{ id: "1", from: "a", to: "a" }])).toBe("bad_edge")
    expect(graphProblem([s("c", "condition"), s("a")], [{ id: "1", from: "c", to: "a" }])).toBe(
      "missing_branch",
    )
    expect(
      graphProblem(
        [s("a"), s("b")],
        [
          { id: "1", from: "a", to: "b" },
          { id: "2", from: "b", to: "a" },
        ],
      ),
    ).toBe("cycle")
  })
})

test("fillTemplate", () => {
  expect(fillTemplate("Summarise: {{input}} / {{trigger}} / {{input}}", "X", "T")).toBe(
    "Summarise: X / T / X",
  )
})

describe("notes and limits", () => {
  const step = (id: string) => ({
    id,
    kind: "approval" as const,
    name: id,
    x: 0,
    y: 0,
    message: "",
  })
  const note = (id: string) => ({ id, text: "t", tone: "blue" as const, x: 0, y: 0 })
  const input = (steps: number, notes: number) => ({
    serverId: "s",
    name: "Flow",
    trigger: { kind: "manual" as const },
    steps: Array.from({ length: steps }, (_, i) => step(`s${i}`)),
    edges: [],
    notes: Array.from({ length: notes }, (_, i) => note(`n${i}`)),
  })
  const accepted = (value: unknown) => Schema.is(WorkflowInput)(value)

  test("notes do not count towards the limit of steps", () => {
    expect(accepted(input(WORKFLOW_STEPS_MAX, WORKFLOW_NOTES_MAX))).toBe(true)
    expect(accepted(input(WORKFLOW_STEPS_MAX + 1, 0))).toBe(false)
    expect(accepted(input(1, WORKFLOW_NOTES_MAX + 1))).toBe(false)
  })
  test("a note has one of four tones", () => {
    expect(NOTE_TONES).toHaveLength(4)
    expect(Schema.is(NoteSchema)({ ...note("a"), tone: "red" })).toBe(false)
    for (const tone of NOTE_TONES) expect(Schema.is(NoteSchema)({ ...note("a"), tone })).toBe(true)
  })
  test("a workflow written before notes and the second condition mode still reads", () => {
    const old = { id: "c", kind: "condition", name: "c", x: 0, y: 0, contains: "ok" } as const
    expect(Schema.is(StepSchema)(old)).toBe(true)
    expect(conditionMode(old)).toBe("contains")
    expect(Schema.is(StepSchema)({ ...old, mode: "ask" })).toBe(true)
    expect(Schema.is(StepSchema)({ ...old, mode: "guess" })).toBe(false)
    expect(accepted({ ...input(1, 0), notes: undefined })).toBe(false)
    const { notes: _drop, ...withoutNotes } = input(1, 0)
    expect(accepted(withoutNotes)).toBe(true)
  })
  test("the effort of an agent step is one of five levels", () => {
    const agent = {
      id: "a",
      kind: "agent",
      name: "a",
      x: 0,
      y: 0,
      agentId: "",
      prompt: "",
      continueOnFailure: false,
    }
    for (const effort of STEP_EFFORTS)
      expect(Schema.is(StepSchema)({ ...agent, effort })).toBe(true)
    expect(Schema.is(StepSchema)({ ...agent, effort: "extreme" })).toBe(false)
    expect(Schema.is(StepSchema)(agent)).toBe(true)
  })
  test("the levels of a step are all the effort levels, which hold those of the Claude models", () => {
    expect(STEP_EFFORTS as readonly string[]).toEqual([...EFFORT_LEVELS])
    for (const level of CLAUDE_EFFORTS) expect(STEP_EFFORTS as readonly string[]).toContain(level)
    for (const level of effortsFor("anthropic", "claude-opus-5-5"))
      expect(STEP_EFFORTS as readonly string[]).toContain(level)
  })
  test("a step with the effort of a model that lists Ultra keeps it, and one without it falls back", () => {
    expect(stepTurnEffort("ultra", "medium", ["minimal", "ultra"])).toBe("ultra")
    expect(stepTurnEffort("ultra", "medium", ["low", "medium"])).toBe("medium")
    expect(stepTurnEffort("none", null, ["none", "low"])).toBe("none")
  })
  test("a notify step has a title of at most 100 characters", () => {
    const notify = { id: "n", kind: "notify", name: "n", x: 0, y: 0, title: "Done" }
    expect(Schema.is(StepSchema)(notify)).toBe(true)
    expect(Schema.is(StepSchema)({ ...notify, title: "x".repeat(NOTIFY_TITLE_MAX) })).toBe(true)
    expect(Schema.is(StepSchema)({ ...notify, title: "x".repeat(NOTIFY_TITLE_MAX + 1) })).toBe(
      false,
    )
  })
})

describe("node numbers", () => {
  test("a step has its place in the list as number, from 1; a move does not change it", () => {
    const steps = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 500, y: 500 },
      { id: "c", x: -40, y: 9 },
    ]
    expect([...nodeNumbers(steps)]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
  })
})

describe("nearestAgentStep", () => {
  const agent = (id: string): Step => ({
    id,
    kind: "agent",
    name: id,
    x: 0,
    y: 0,
    agentId: `agent-${id}`,
    prompt: "",
    continueOnFailure: false,
  })
  const gate = (id: string): Step => ({ id, kind: "approval", name: id, x: 0, y: 0, message: "" })
  const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to })
  test("finds the agent step with the fewest connections before the step", () => {
    const steps = [agent("a"), gate("g"), agent("b"), gate("q")]
    const edges = [edge("a", "g"), edge("g", "b"), edge("b", "q")]
    expect(nearestAgentStep(steps, edges, "q")?.id).toBe("b")
    expect(nearestAgentStep(steps, [edge("a", "g"), edge("g", "q")], "q")?.id).toBe("a")
  })
  test("among equals the first in the list wins; none gives null", () => {
    const steps = [agent("a"), agent("b"), gate("q")]
    expect(nearestAgentStep(steps, [edge("b", "q"), edge("a", "q")], "q")?.id).toBe("a")
    expect(nearestAgentStep(steps, [], "q")).toBeNull()
    expect(nearestAgentStep([gate("g"), gate("q")], [edge("g", "q")], "q")).toBeNull()
  })
})

describe("the effort of one turn of an agent step", () => {
  test("a step without effort follows the agent", () => {
    expect(stepTurnEffort(undefined, "high", ["low", "high"])).toBe("high")
    expect(stepTurnEffort(undefined, null, [])).toBeNull()
  })
  test("the effort of the step counts when the model offers it", () => {
    expect(stepTurnEffort("low", "high", ["low", "medium", "high"])).toBe("low")
    expect(stepTurnEffort("low", null, ["low"])).toBe("low")
  })
  test("the effort of the agent counts when the model does not offer the one of the step", () => {
    expect(stepTurnEffort("max", "high", ["low", "medium", "high"])).toBe("high")
    expect(stepTurnEffort("low", null, [])).toBeNull()
  })
})

describe("the answer of a model to a condition", () => {
  test("only the word yes or no is an answer", () => {
    for (const yes of ["yes", "Yes", " YES. ", "**Yes**", '"yes"', "yes!"])
      expect(parseYesNo(yes)).toBe("yes")
    for (const no of ["no", "No.", "  no\n", "`no`"]) expect(parseYesNo(no)).toBe("no")
    for (const other of ["", "maybe", "Yes, because it does", "no idea", "yes no", "Not sure."])
      expect(parseYesNo(other)).toBeNull()
  })
  test("the error holds the start of the answer on one line, up to 240 characters", () => {
    const long = `Well,\nit depends.\n\n${"x".repeat(500)}`
    const start = answerStart(long)
    expect(start).not.toContain("\n")
    expect(start.startsWith("Well, it depends. xxx")).toBe(true)
    expect([...start]).toHaveLength(ANSWER_ERROR_MAX)
    expect(answerStart("  short  answer ")).toBe("short answer")
    expect(answerError("maybe")).toBe("answer_not_yes_no: maybe")
    // The limit counts characters, not code units.
    expect([...answerStart("😀".repeat(300))]).toHaveLength(ANSWER_ERROR_MAX)
  })
  test("only a plain failure of the call is tried again", () => {
    expect(ASK_TRIES).toBe(3)
    expect(ASK_RETRY_MS).toBe(2000)
    expect(retryableFailure("provider_unreachable")).toBe(true)
    expect(retryableFailure("provider_error")).toBe(true)
    for (const code of [
      "provider_limit",
      "provider_busy",
      "provider_auth",
      "runtime_signed_out",
      "provider_not_connected",
    ])
      expect(retryableFailure(code)).toBe(false)
  })
})

describe("the body of a notification of a notify step", () => {
  test("it is the first 200 characters of the input, as they are", () => {
    expect(notifyBody("short")).toBe("short")
    expect(notifyBody("")).toBe("")
    expect([...notifyBody("a".repeat(500))]).toHaveLength(NOTIFY_BODY_MAX)
    expect(
      notifyBody(`line one\nline two${"z".repeat(300)}`).startsWith("line one\nline two"),
    ).toBe(true)
    expect([...notifyBody("한".repeat(300))]).toHaveLength(200)
  })
})
