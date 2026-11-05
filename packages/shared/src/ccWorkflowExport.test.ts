import { describe, expect, test } from "bun:test"
import { ccFileName, writeCcWorkflowFile } from "./ccWorkflowExport.ts"
import { parseCcWorkflowFile } from "./ccWorkflowFile.ts"
import type {
  WorkflowFileConnection,
  WorkflowFileNote,
  WorkflowFileStep,
  WorkflowFileWorkflow,
} from "./workflowFile.ts"

const NOW = new Date("2026-11-05T10:00:00.000Z")

const agent = (name: string, over: Partial<Extract<WorkflowFileStep, { kind: "agent" }>> = {}) =>
  ({
    kind: "agent",
    name,
    x: 0,
    y: 0,
    agent: "",
    prompt: `Do ${name}`,
    effort: null,
    continueOnFailure: false,
    ...over,
  }) satisfies WorkflowFileStep
const condition = (name: string, text = "haiku", mode: "contains" | "ask" = "contains") =>
  ({ kind: "condition", name, x: 0, y: 0, mode, text }) satisfies WorkflowFileStep
const approval = (name: string, message = "Go on?") =>
  ({ kind: "approval", name, x: 0, y: 0, message }) satisfies WorkflowFileStep
const post = (name: string) =>
  ({ kind: "post", name, x: 0, y: 0, text: "{{input}}" }) satisfies WorkflowFileStep
const notify = (name: string) =>
  ({ kind: "notify", name, x: 0, y: 0, title: "Done" }) satisfies WorkflowFileStep
const at = <T extends WorkflowFileStep>(step: T, x: number, y: number): T => ({ ...step, x, y })

const link = (
  from: number,
  to: number,
  branch: "yes" | "no" | null = null,
): WorkflowFileConnection => ({ from, to, branch })

const make = (
  steps: WorkflowFileStep[],
  connections: WorkflowFileConnection[] = [],
  over: Partial<WorkflowFileWorkflow> = {},
): WorkflowFileWorkflow => ({
  name: "Daily Report",
  trigger: { kind: "manual" },
  steps,
  connections,
  notes: [],
  ...over,
})

type CcNode = { id: string; type: string; name: string; position: { x: number; y: number } }
type CcFile = {
  id: string
  name: string
  version: string
  nodes: (CcNode & { data: Record<string, unknown> })[]
  connections: { id: string; from: string; to: string; fromPort: string; toPort: string }[]
  createdAt: string
  updatedAt: string
}

const write = (
  workflow: WorkflowFileWorkflow,
  trigger: "manual" | "schedule" | "channel" = workflow.trigger.kind,
) => {
  const result = writeCcWorkflowFile({ workflow, trigger, now: NOW })
  return { ...result, file: JSON.parse(result.text) as CcFile }
}
/** The connections as `from:port>to`, in a fixed order, so a test does not depend on their ids. */
const edges = (file: CcFile) =>
  file.connections.map((c) => `${c.from}:${c.fromPort}>${c.to}`).sort()

describe("the file", () => {
  test("it is a bare workflow with a lower case name, an id, a version and the time", () => {
    const { file } = write(make([]))
    expect(file).toMatchObject({
      id: `workflow-${NOW.getTime()}`,
      name: "daily-report",
      version: "1.0.0",
      createdAt: "2026-11-05T10:00:00.000Z",
      updatedAt: "2026-11-05T10:00:00.000Z",
    })
    expect(file.nodes.map((n) => [n.id, n.type])).toEqual([
      ["start", "start"],
      ["end", "end"],
    ])
  })

  test("the name keeps a-z, 0-9, - and _; a run of other characters is one -", () => {
    expect(ccFileName("Daily Report!")).toBe("daily-report")
    expect(ccFileName("a__b  c--d")).toBe("a__b-c-d")
    expect(ccFileName("  --x--  ")).toBe("x")
    expect(ccFileName("일일 보고")).toBe("workflow")
    expect(ccFileName("")).toBe("workflow")
    expect(ccFileName("x".repeat(150))).toHaveLength(100)
  })

  test("every node has a name that the tool accepts", () => {
    const steps = [agent("Draft: a/b"), condition("Is it?"), approval("Gate")]
    const { file } = write(make(steps, [link(1, 2), link(2, 3, "yes"), link(2, 3, "no")]))
    for (const node of file.nodes) expect(node.name).toMatch(/^[a-zA-Z0-9_-]{1,50}$/)
    expect(file.nodes.map((n) => n.id)).toEqual(["start", "step-1", "step-2", "step-3", "end"])
  })

  test("a step has its place; the start node is left of the left-most step, the end node right of the right-most", () => {
    const steps = [at(agent("A"), 100, 40), at(agent("B"), 500, 90), at(agent("C"), 300, 10)]
    const { file } = write(make(steps, [link(1, 2), link(2, 3)]))
    const place = Object.fromEntries(file.nodes.map((n) => [n.id, n.position]))
    expect(place["step-2"]).toEqual({ x: 500, y: 90 })
    expect(place.start).toEqual({ x: -150, y: 40 })
    expect(place.end).toEqual({ x: 750, y: 10 })
  })

  test("with no step the start node and the end node are at 0 and 250, and they are joined", () => {
    const { file } = write(make([]))
    expect(file.nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 250, y: 0 },
    ])
    expect(edges(file)).toEqual(["start:output>end"])
  })
})

describe("steps", () => {
  test("an agent step: the name is the description and the prompt is the prompt; the agent is not written", () => {
    const { file } = write(make([agent("Draft", { agent: "Ada", prompt: "Write a haiku" })]))
    expect(file.nodes[1]).toMatchObject({
      id: "step-1",
      type: "subAgent",
      data: {
        description: "Draft",
        agentDefinition: "",
        prompt: "Write a haiku",
        outputPorts: 1,
      },
    })
    expect(JSON.stringify(file)).not.toContain("Ada")
  })

  test("an empty prompt becomes the name of the step", () => {
    const { file } = write(make([agent("Draft", { prompt: "" })]))
    expect(file.nodes[1]?.data).toMatchObject({ prompt: "Draft" })
  })

  test("a condition in the mode Contains: the first branch tests the text, ignoring case", () => {
    const { file } = write(make([condition("Haiku?", "haiku")]))
    expect(file.nodes[1]).toMatchObject({
      type: "ifElse",
      data: {
        evaluationTarget: "The input of this step",
        branches: [
          { label: "Yes", condition: 'The input contains "haiku", ignoring case' },
          { label: "No", condition: "Otherwise" },
        ],
        outputPorts: 2,
      },
    })
  })

  test("a condition in the mode Ask: the first branch is the question; an empty question is True", () => {
    const asked = write(make([condition("Q", "Is it polite?", "ask")])).file.nodes[1]
    expect(asked?.data).toMatchObject({ branches: [{ condition: "Is it polite?" }, {}] })
    const empty = write(make([condition("Q", "", "ask")])).file.nodes[1]
    expect(empty?.data).toMatchObject({ branches: [{ condition: "True" }, {}] })
  })

  test("an approval step asks Approve or Reject, and only Approve goes on", () => {
    const steps = [approval("Gate", "Ship it?"), agent("After")]
    const { file } = write(make(steps, [link(1, 2)]))
    expect(file.nodes[1]).toMatchObject({
      type: "askUserQuestion",
      data: {
        questionText: "Ship it?",
        options: [
          { label: "Approve", description: "Go on" },
          { label: "Reject", description: "Stop" },
        ],
        outputPorts: 2,
      },
    })
    expect(edges(file)).toContain("step-1:branch-0>step-2")
    expect(edges(file).filter((e) => e.startsWith("step-1:branch-1"))).toEqual([])
    expect(write(make([approval("Gate", "")])).file.nodes[1]?.data).toMatchObject({
      questionText: "Do you approve?",
    })
  })
})

describe("connections", () => {
  test("the start node joins the steps with no input, and the end node takes the steps with no output", () => {
    const steps = [agent("A"), agent("B"), agent("C")]
    const { file } = write(make(steps, [link(1, 2)]))
    expect(edges(file)).toEqual([
      "start:output>step-1",
      "start:output>step-3",
      "step-1:output>step-2",
      "step-2:output>end",
      "step-3:output>end",
    ])
    expect(file.connections.map((c) => c.id)).toEqual(["c-1", "c-2", "c-3", "c-4", "c-5"])
    expect(new Set(file.connections.map((c) => c.toPort))).toEqual(new Set(["input"]))
  })

  test("a condition leaves from branch-0 for yes and from branch-1 for no", () => {
    const steps = [condition("Q"), agent("Yes"), agent("No")]
    const { file } = write(make(steps, [link(1, 2, "yes"), link(1, 3, "no")]))
    expect(edges(file)).toEqual([
      "start:output>step-1",
      "step-1:branch-0>step-2",
      "step-1:branch-1>step-3",
      "step-2:output>end",
      "step-3:output>end",
    ])
  })

  test("a post step and a notify step are not written, and the steps around them stay joined", () => {
    const steps = [agent("A"), notify("Tell"), post("Share"), agent("B")]
    const { file, notExported } = write(make(steps, [link(1, 2), link(2, 3), link(3, 4)]))
    expect(file.nodes.map((n) => n.id)).toEqual(["start", "step-1", "step-4", "end"])
    expect(edges(file)).toEqual([
      "start:output>step-1",
      "step-1:output>step-4",
      "step-4:output>end",
    ])
    expect(notExported).toEqual([
      { kind: "step", step: 2, stepKind: "notify", name: "Tell" },
      { kind: "step", step: 3, stepKind: "post", name: "Share" },
    ])
  })

  test("a step that is not written and has two steps after it joins both; the branch stays", () => {
    const steps = [condition("Q"), notify("Tell"), agent("A"), agent("B"), agent("No")]
    const { file } = write(
      make(steps, [link(1, 2, "yes"), link(1, 5, "no"), link(2, 3), link(2, 4)]),
    )
    expect(edges(file)).toEqual([
      "start:output>step-1",
      "step-1:branch-0>step-3",
      "step-1:branch-0>step-4",
      "step-1:branch-1>step-5",
      "step-3:output>end",
      "step-4:output>end",
      "step-5:output>end",
    ])
  })

  test("a branch that goes to a step with nothing after it, which is not written, goes to the end node", () => {
    const steps = [condition("Q"), agent("Yes"), notify("Tell")]
    const { file } = write(make(steps, [link(1, 2, "yes"), link(1, 3, "no")]))
    expect(edges(file)).toContain("step-1:branch-1>end")
  })

  test("a first step that is not written leaves the steps after it with the start node", () => {
    const steps = [notify("Tell"), agent("A")]
    const { file } = write(make(steps, [link(1, 2)]))
    expect(edges(file)).toEqual(["start:output>step-2", "step-2:output>end"])
  })

  test("a workflow of only steps that are not written is the start node joined to the end node", () => {
    const { file } = write(make([post("Share"), notify("Tell")], [link(1, 2)]))
    expect(edges(file)).toEqual(["start:output>end"])
  })
})

describe("what the file does not hold", () => {
  test("the list: the steps, the trigger, the notes, the settings of steps and the cuts, in this order", () => {
    const note: WorkflowFileNote = { text: "n", tone: "blue", x: 0, y: 0 }
    const steps = [
      agent("A", { effort: "low" }),
      agent("B", { continueOnFailure: true }),
      agent("C", { effort: "high", continueOnFailure: true }),
      agent("D", { prompt: "x".repeat(10_001) }),
      agent("E", { agent: "Ada" }),
      notify("Tell"),
    ]
    const workflow = make(steps, [], {
      trigger: { kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } },
      notes: [note, note],
    })
    expect(write(workflow).notExported).toEqual([
      { kind: "step", step: 6, stepKind: "notify", name: "Tell" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "notes", count: 2 },
      { kind: "stepSettings", count: 4 },
      { kind: "cut", step: 4, name: "D" },
    ])
  })

  test("the trigger is listed by the kind of the app, also when the file holds the manual trigger", () => {
    // A message trigger is written as "manual" in a ROBot file. The list still names it.
    expect(write(make([]), "channel").notExported).toEqual([
      { kind: "trigger", trigger: "channel" },
    ])
    expect(write(make([]), "manual").notExported).toEqual([])
  })

  test("a workflow that loses nothing has an empty list", () => {
    expect(write(make([agent("A"), condition("Q")], [link(1, 2)])).notExported).toEqual([])
  })

  test("a text over the limit of the tool is cut, and the cut is listed", () => {
    const steps = [
      agent("A", { prompt: "p".repeat(12_000) }),
      condition("Q", "q".repeat(600), "ask"),
      approval("Gate", "m".repeat(600)),
    ]
    const { file, notExported } = write(make(steps, [link(1, 2), link(2, 3, "yes")]))
    expect([...String(file.nodes[1]?.data.prompt)]).toHaveLength(10_000)
    const branches = file.nodes[2]?.data.branches as { condition: string }[]
    expect([...(branches[0]?.condition ?? "")]).toHaveLength(500)
    expect([...String(file.nodes[3]?.data.questionText)]).toHaveLength(500)
    expect(notExported).toEqual([
      { kind: "cut", step: 1, name: "A" },
      { kind: "cut", step: 2, name: "Q" },
      { kind: "cut", step: 3, name: "Gate" },
    ])
  })

  test("the text {{input}} stays in a prompt as it is", () => {
    const { file } = write(make([agent("A", { prompt: "Use {{input}} and {{trigger}}" })]))
    expect(file.nodes[1]?.data.prompt).toBe("Use {{input}} and {{trigger}}")
  })
})

describe("the import of what the app wrote", () => {
  test("agent steps and conditions come back with the same prompts and connections", () => {
    const steps = [
      agent("Draft", { agent: "Ada", prompt: "Write a haiku" }),
      condition("Is it?", "Is it a haiku?", "ask"),
      agent("Yes", { prompt: "Say well done" }),
      agent("No", { prompt: "Try again" }),
    ]
    const workflow = make(steps, [link(1, 2), link(2, 3, "yes"), link(2, 4, "no")])
    const parsed = parseCcWorkflowFile(write(workflow).text)
    if (!parsed?.ok) throw new Error(`not read: ${JSON.stringify(parsed)}`)
    const back = parsed.file.workflows[0]
    expect(back?.name).toBe("daily-report")
    expect(back?.steps.map((s) => [s.kind, s.name])).toEqual([
      ["agent", "Draft"],
      ["condition", "The input of this step"],
      ["agent", "Yes"],
      ["agent", "No"],
    ])
    expect(back?.steps.map((s) => (s.kind === "agent" ? s.prompt : null))).toEqual([
      "Write a haiku",
      null,
      "Say well done",
      "Try again",
    ])
    expect(back?.connections).toEqual([
      { from: 1, to: 2, branch: null },
      { from: 2, to: 3, branch: "yes" },
      { from: 2, to: 4, branch: "no" },
    ])
    expect(back?.steps[1]).toMatchObject({ mode: "ask" })
    // Nothing is lost on the way back that the first list did not name.
    expect(parsed.cc.notImported).toEqual([])
    expect(parsed.cc.lostConnections).toBe(false)
  })

  test("an approval step comes back as a note, because the import has no step for a question", () => {
    const steps = [agent("A"), approval("Gate"), agent("B")]
    const parsed = parseCcWorkflowFile(write(make(steps, [link(1, 2), link(2, 3)])).text)
    if (!parsed?.ok) throw new Error("not read")
    expect(parsed.file.workflows[0]?.steps.map((s) => s.name)).toEqual(["A", "B"])
    expect(parsed.file.workflows[0]?.notes).toHaveLength(1)
    expect(parsed.cc.lostInputs).toEqual([2])
  })
})
