import { describe, expect, test } from "bun:test"
import { type CcParse, parseCcWorkflowFile } from "./ccWorkflowFile.ts"
import type { GraphFault } from "./workflowFile.ts"
import {
  NOTE_TEXT_MAX,
  STEP_TEXT_MAX,
  WORKFLOW_NOTES_MAX,
  WORKFLOW_STEPS_MAX,
} from "./workflows.ts"

type Node = Record<string, unknown>
type Link = Record<string, unknown>

const node = (id: string, type: string, data: Node = {}, over: Node = {}): Node => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  data,
  ...over,
})
const start = node("start", "start", { label: "Start" })
const end = node("end", "end", { label: "End" })
const link = (from: string, to: string, fromPort?: string): Link => ({
  id: `${from}-${to}`,
  from,
  to,
  ...(fromPort ? { fromPort, toPort: "input" } : {}),
})
const workflow = (nodes: Node[], connections: Link[] = [], over: Node = {}) => ({
  id: "w1",
  name: "daily-flow",
  version: "1.0.0",
  nodes,
  connections,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
})
const text = (w: unknown) => JSON.stringify(w)

const ok = (parsed: CcParse | null) => {
  if (!parsed?.ok) throw new Error(`not ok: ${JSON.stringify(parsed)}`)
  const w = parsed.file.workflows[0]
  if (!w) throw new Error("no workflow")
  return { workflow: w, cc: parsed.cc, file: parsed.file }
}
const refused = (parsed: CcParse | null) => {
  if (!parsed || parsed.ok) throw new Error(`not refused: ${JSON.stringify(parsed)}`)
  return parsed
}
const faultOf = (parsed: CcParse | null): GraphFault =>
  JSON.parse(refused(parsed).detail ?? "{}") as GraphFault

describe("which files are CC Workflow Studio files", () => {
  test("a ROBot file, text that is not JSON and other JSON are not this form", () => {
    expect(
      parseCcWorkflowFile(JSON.stringify({ format: "robot-workflows", version: 1, workflows: [] })),
    ).toBeNull()
    expect(parseCcWorkflowFile("not json")).toBeNull()
    expect(parseCcWorkflowFile("[]")).toBeNull()
    expect(parseCcWorkflowFile(JSON.stringify({ nodes: [] }))).toBeNull()
    expect(parseCcWorkflowFile(JSON.stringify({ nodes: {}, connections: [] }))).toBeNull()
  })

  test("the bare form and the wrapped form make the same workflow", () => {
    const w = workflow(
      [start, node("p", "prompt", { prompt: "Say hello." }, { name: "greet" }), end],
      [link("start", "p"), link("p", "end")],
    )
    const bare = ok(parseCcWorkflowFile(text(w)))
    const wrapped = ok(parseCcWorkflowFile(text({ meta: { exportedAt: "x" }, workflow: w })))
    expect(wrapped.file).toEqual(bare.file)
    expect(bare.workflow.name).toBe("daily-flow")
    expect(bare.workflow.trigger).toEqual({ kind: "manual" })
    expect(bare.workflow.steps).toEqual([
      {
        kind: "agent",
        name: "greet",
        x: 0,
        y: 0,
        agent: "",
        prompt: "Say hello.",
        effort: null,
        continueOnFailure: false,
      },
    ])
    // The start node and the end node make nothing, and they are not a loss.
    expect(bare.workflow.connections).toEqual([])
    expect(bare.workflow.notes).toEqual([])
    expect(bare.cc).toEqual({
      notImported: [],
      lostInputs: [],
      lostConnections: false,
      agentSteps: 1,
    })
  })

  test("a BOM at the start of the text is allowed", () => {
    const w = workflow([start, end], [])
    expect(ok(parseCcWorkflowFile(`\uFEFF${text(w)}`)).workflow.steps).toEqual([])
  })
})

describe("agent steps", () => {
  test("a sub-agent node: the description is the name, the definition goes before the prompt", () => {
    const w = workflow(
      [
        node("a", "subAgent", {
          description: "News briefing",
          agentDefinition: "You read the news.",
          prompt: "Find three items.",
          model: "sonnet",
          outputPorts: 1,
        }),
        node("b", "subAgent", { description: "", agentDefinition: "", prompt: "Only a prompt." }),
      ],
      [link("a", "b", "output")],
    )
    const { workflow: parsed, cc } = ok(parseCcWorkflowFile(text(w)))
    expect(
      parsed.steps.map((s) => (s.kind === "agent" ? [s.name, s.prompt, s.agent] : [])),
    ).toEqual([
      ["News briefing", "You read the news.\n\nFind three items.", ""],
      ["b", "Only a prompt.", ""],
    ])
    expect(parsed.connections).toEqual([{ from: 1, to: 2, branch: null }])
    expect(cc.agentSteps).toBe(2)
    // The model has no place in ROBot. It is listed once for the workflow.
    expect(cc.notImported).toEqual([
      { reason: "unknown_field", owner: "daily-flow", field: "subAgent.model" },
    ])
  })

  test("a field that two sub-agent nodes both hold is listed once", () => {
    const sub = (id: string) =>
      node(id, "subAgent", { description: id, prompt: "p", model: "opus" })
    const { cc } = ok(parseCcWorkflowFile(text(workflow([sub("a"), sub("b")], []))))
    expect(cc.notImported).toHaveLength(1)
  })

  test("a prompt node: the label is the name, a variable with a value is filled", () => {
    const w = workflow([
      node("p", "prompt", {
        label: "Report",
        prompt: "Write about {{topic}} and {{other}} and {{topic}}.",
        variables: { topic: "tea", ignored: 5 },
      }),
    ])
    const { workflow: parsed } = ok(parseCcWorkflowFile(text(w)))
    const step = parsed.steps[0]
    expect(step?.kind === "agent" && step.name).toBe("Report")
    expect(step?.kind === "agent" && step.prompt).toBe("Write about tea and {{other}} and tea.")
  })

  test("the place of a node is rounded and kept inside the range", () => {
    const w = workflow([
      node("p", "prompt", { prompt: "x" }, { position: { x: 10.6, y: -2_000_000 } }),
    ])
    const step = ok(parseCcWorkflowFile(text(w))).workflow.steps[0]
    expect([step?.x, step?.y]).toEqual([11, -1_000_000])
  })

  test("a node in a group has the place of the group plus its own place", () => {
    const w = workflow([
      node("g1", "group", { label: "Outer" }, { position: { x: 100, y: 200 } }),
      node("g2", "group", { label: "Inner" }, { position: { x: 10, y: 20 }, parentId: "g1" }),
      node("p", "prompt", { prompt: "x" }, { position: { x: 1, y: 2 }, parentId: "g2" }),
    ])
    const { workflow: parsed } = ok(parseCcWorkflowFile(text(w)))
    expect(parsed.steps.map((s) => [s.x, s.y])).toEqual([[111, 222]])
    // A group is a note at its own place. An inner group sits on the place of the outer one.
    expect(parsed.notes.map((n) => [n.x, n.y])).toEqual([
      [100, 200],
      [110, 220],
    ])
  })

  test("a chain of groups that loops is refused", () => {
    const w = workflow([
      node("g1", "group", { label: "a" }, { parentId: "g2" }),
      node("g2", "group", { label: "b" }, { parentId: "g1" }),
    ])
    expect(refused(parseCcWorkflowFile(text(w)))).toMatchObject({
      code: "workflow_file_field",
      detail: "nodes[0].parentId",
    })
  })

  test("a prompt over the limit is cut, and the cut is listed", () => {
    const w = workflow([
      node("p", "prompt", { label: "Long", prompt: "a".repeat(STEP_TEXT_MAX + 1) }),
    ])
    const { workflow: parsed, cc } = ok(parseCcWorkflowFile(text(w)))
    const step = parsed.steps[0]
    expect(step?.kind === "agent" && [...step.prompt].length).toBe(STEP_TEXT_MAX)
    expect(cc.notImported).toEqual([{ reason: "text_cut", owner: "daily-flow", name: "Long" }])
  })
})

describe("conditions", () => {
  const condition = (data: Node = {}) =>
    node("c", "ifElse", {
      evaluationTarget: "The last result",
      branches: [
        { label: "Pass", condition: "The tests passed" },
        { label: "Fail", condition: "Otherwise" },
      ],
      outputPorts: 2,
      ...data,
    })

  test("an if and else node: mode Ask, branch-0 is yes and branch-1 is no", () => {
    const w = workflow(
      [
        node("a", "prompt", { prompt: "Test" }),
        condition(),
        node("y", "prompt", { prompt: "Ship" }),
        node("n", "prompt", { prompt: "Fix" }),
      ],
      [link("a", "c", "output"), link("c", "n", "branch-1"), link("c", "y", "branch-0")],
    )
    const { workflow: parsed } = ok(parseCcWorkflowFile(text(w)))
    expect(parsed.steps[1]).toMatchObject({
      kind: "condition",
      mode: "ask",
      name: "The last result",
      text: "The last result\nThe tests passed",
    })
    expect(parsed.connections).toEqual([
      { from: 1, to: 2, branch: null },
      { from: 2, to: 4, branch: "no" },
      { from: 2, to: 3, branch: "yes" },
    ])
  })

  test("with no evaluation target the text is the first condition and the name is the node name", () => {
    const w = workflow(
      [
        condition({ evaluationTarget: "" }),
        node("y", "prompt", { prompt: "Ship" }),
        node("n", "prompt", { prompt: "Fix" }),
      ],
      [link("c", "y", "branch-0"), link("c", "n", "branch-1")],
    )
    const { workflow: parsed } = ok(parseCcWorkflowFile(text(w)))
    expect(parsed.steps[0]).toMatchObject({ name: "c", text: "The tests passed" })
  })

  test("a connection that leaves from another port is lost, and the branch it served is missing", () => {
    const w = workflow(
      [
        condition(),
        node("y", "prompt", { prompt: "Ship" }),
        node("n", "prompt", { prompt: "Fix" }),
      ],
      [link("c", "y", "branch-0"), link("c", "n")],
    )
    expect(faultOf(parseCcWorkflowFile(text(w)))).toEqual({
      workflow: "daily-flow",
      fault: "branches",
      place: { kind: "step", n: 1 },
    })
  })

  test("a branch that goes to the end node has no connection, so the file is refused", () => {
    const w = workflow(
      [condition(), node("y", "prompt", { prompt: "Ship" }), end],
      [link("c", "y", "branch-0"), link("c", "end", "branch-1")],
    )
    expect(faultOf(parseCcWorkflowFile(text(w))).fault).toBe("branches")
  })
})

describe("nodes that become notes", () => {
  const between = () =>
    workflow(
      [
        start,
        node("a", "prompt", { label: "First", prompt: "one" }),
        node(
          "q",
          "askUserQuestion",
          {
            questionText: "Which way?",
            options: [
              { label: "Left", description: "go left" },
              { label: "Right", description: "go right" },
            ],
            outputPorts: 2,
          },
          { name: "which-way", position: { x: 300, y: 40 } },
        ),
        node("b", "prompt", { label: "Second", prompt: "two" }),
        end,
      ],
      [
        link("start", "a", "output"),
        link("a", "q", "output"),
        link("q", "b", "branch-0"),
        link("b", "end", "output"),
      ],
    )

  test("a question node is a pink note at its place, and the step after it lost an input", () => {
    const { workflow: parsed, cc } = ok(parseCcWorkflowFile(text(between())))
    expect(parsed.steps.map((s) => s.name)).toEqual(["First", "Second"])
    expect(parsed.connections).toEqual([])
    expect(parsed.notes).toEqual([
      {
        text: "Not imported: askUserQuestion which-way\nWhich way?\nLeft, Right",
        tone: "pink",
        x: 300,
        y: 40,
      },
    ])
    expect(cc.lostInputs).toEqual([2])
    expect(cc.lostConnections).toBe(true)
    expect(cc.notImported).toEqual([
      { reason: "no_step", owner: "daily-flow", nodeType: "askUserQuestion", name: "which-way" },
    ])
  })

  test("a connection to the start or the end node is no loss", () => {
    const w = workflow(
      [start, node("a", "prompt", { prompt: "x" }), end],
      [link("start", "a"), link("a", "end")],
    )
    const { cc } = ok(parseCcWorkflowFile(text(w)))
    expect(cc.lostConnections).toBe(false)
    expect(cc.lostInputs).toEqual([])
  })

  test("each other kind of node makes a note with the main text of the node", () => {
    const cases: [string, Node, string][] = [
      [
        "switch",
        { evaluationTarget: "Status", branches: [{ label: "ok" }, { label: "bad" }] },
        "Status\nok, bad",
      ],
      ["branch", { branches: [{ label: "x" }, { label: "y" }] }, "x, y"],
      ["skill", { name: "lint", description: "Run lint" }, "lint\nRun lint"],
      ["mcp", { toolName: "search" }, "search"],
      ["codex", { label: "Ask Codex", prompt: "Review it" }, "Ask Codex\nReview it"],
      ["subAgentFlow", { label: "Sub flow" }, "Sub flow"],
      ["group", { label: "Fetch" }, "Fetch"],
      ["branchSession", { label: "Check", workDescription: "Look at it" }, "Check\nLook at it"],
      ["somethingNew", { x: 1 }, ""],
    ]
    for (const [type, data, body] of cases) {
      const w = workflow([node("n", type, data, { name: "the-node" })], [])
      const { workflow: parsed, cc } = ok(parseCcWorkflowFile(text(w)))
      const head = `Not imported: ${type} the-node`
      expect(parsed.notes[0]).toMatchObject({
        tone: "pink",
        text: body === "" ? head : `${head}\n${body}`,
      })
      expect(cc.notImported).toEqual([
        { reason: "no_step", owner: "daily-flow", nodeType: type, name: "the-node" },
      ])
    }
  })

  test("a note keeps at most the text of a note, and the cut is listed", () => {
    const w = workflow([node("n", "codex", { label: "L", prompt: "b".repeat(NOTE_TEXT_MAX + 50) })])
    const { workflow: parsed, cc } = ok(parseCcWorkflowFile(text(w)))
    expect([...(parsed.notes[0]?.text ?? "")].length).toBe(NOTE_TEXT_MAX)
    expect(cc.notImported.map((n) => n.reason)).toEqual(["no_step", "text_cut"])
  })

  test("after 50 notes a node makes no note, and it is still listed", () => {
    const nodes = Array.from({ length: WORKFLOW_NOTES_MAX + 3 }, (_, i) =>
      node(`q${i}`, "askUserQuestion", { questionText: "?" }),
    )
    const { workflow: parsed, cc } = ok(parseCcWorkflowFile(text(workflow(nodes, []))))
    expect(parsed.notes).toHaveLength(WORKFLOW_NOTES_MAX)
    expect(cc.notImported).toHaveLength(WORKFLOW_NOTES_MAX + 3)
  })

  test("sub-agent flows and hooks are listed", () => {
    const w = workflow([node("p", "prompt", { prompt: "x" })], [], {
      subAgentFlows: [{ id: "f", name: "sub", nodes: [], connections: [] }],
      slashCommandOptions: { hooks: { Stop: [{ actions: [{ type: "command", command: "ls" }] }] } },
    })
    expect(ok(parseCcWorkflowFile(text(w))).cc.notImported).toEqual([
      { reason: "unknown_field", owner: "daily-flow", field: "subAgentFlows" },
      { reason: "unknown_field", owner: "daily-flow", field: "hooks" },
    ])
    const empty = workflow([node("p", "prompt", { prompt: "x" })], [], {
      subAgentFlows: [],
      slashCommandOptions: { hooks: {} },
    })
    expect(ok(parseCcWorkflowFile(text(empty))).cc.notImported).toEqual([])
  })
})

describe("files that are refused", () => {
  const two = (connections: Link[]) =>
    workflow(
      [node("a", "prompt", { prompt: "1" }), node("b", "prompt", { prompt: "2" })],
      connections,
    )

  test("a loop names the connection that closes it", () => {
    const fault = faultOf(parseCcWorkflowFile(text(two([link("a", "b"), link("b", "a")]))))
    expect(fault).toEqual({
      workflow: "daily-flow",
      fault: "cycle",
      place: { kind: "connection", n: 2 },
    })
  })

  test("a step that joins itself is refused", () => {
    expect(faultOf(parseCcWorkflowFile(text(two([link("a", "a")])))).fault).toBe("self_connection")
  })

  test("a connection to a node that does not exist is refused, by its place in the file", () => {
    const parsed = parseCcWorkflowFile(text(two([link("a", "b"), link("a", "zzz")])))
    expect(refused(parsed).code).toBe("workflow_file_graph")
    expect(faultOf(parsed)).toEqual({
      workflow: "daily-flow",
      fault: "unknown_step",
      place: { kind: "connection", n: 2 },
    })
  })

  test("more steps than the limit is refused", () => {
    const nodes = Array.from({ length: WORKFLOW_STEPS_MAX + 1 }, (_, i) =>
      node(`p${i}`, "prompt", { prompt: "x" }),
    )
    expect(faultOf(parseCcWorkflowFile(text(workflow(nodes, [])))).fault).toBe("too_many_steps")
    expect(ok(parseCcWorkflowFile(text(workflow(nodes.slice(1), [])))).workflow.steps).toHaveLength(
      WORKFLOW_STEPS_MAX,
    )
  })

  test("a node without an id, a type or a place, and a repeated id, name the node", () => {
    const bad = (n: Node) => refused(parseCcWorkflowFile(text(workflow([n], []))))
    expect(bad({ type: "prompt", position: { x: 0, y: 0 } })).toMatchObject({
      code: "workflow_file_field",
      detail: "nodes[0].id",
    })
    expect(bad({ id: "a", position: { x: 0, y: 0 } })).toMatchObject({ detail: "nodes[0].type" })
    expect(bad({ id: "a", type: "prompt", position: { x: "0", y: 0 } })).toMatchObject({
      detail: "nodes[0].position",
    })
    expect(bad({ id: "a", type: "prompt" })).toMatchObject({ detail: "nodes[0].position" })
    const twice = workflow([node("a", "prompt"), node("a", "prompt")], [])
    expect(refused(parseCcWorkflowFile(text(twice)))).toMatchObject({ detail: "nodes[1].id" })
  })

  test("a workflow without a name is refused", () => {
    const w = workflow([], [], { name: "  " })
    expect(refused(parseCcWorkflowFile(text(w)))).toMatchObject({
      code: "workflow_file_field",
      detail: "name",
    })
  })

  test("the same connection twice counts as once", () => {
    const { workflow: parsed } = ok(
      parseCcWorkflowFile(text(two([link("a", "b"), link("a", "b")]))),
    )
    expect(parsed.connections).toHaveLength(1)
  })
})
