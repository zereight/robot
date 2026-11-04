import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { planNames } from "./agentFile.ts"
import { charLength, nameKey } from "./agents.ts"
import { redactSecrets } from "./redact.ts"
import {
  type GraphFault,
  graphFault,
  mapFileTexts,
  missingAgentNames,
  parseWorkflowFile,
  toWorkflowInput,
  WORKFLOW_FILE_FORMAT,
  WORKFLOW_FILE_MAX_BYTES,
  WORKFLOW_FILE_MAX_WORKFLOWS,
  WORKFLOW_FILE_VERSION,
  type WorkflowFileErrorCode,
  type WorkflowFileWorkflow,
  writeWorkflowFile,
} from "./workflowFile.ts"
import {
  NOTE_TONES,
  STEP_EFFORTS,
  StepSchema,
  WORKFLOW_NAME_MAX,
  WORKFLOW_STEPS_MAX,
  WorkflowInput,
} from "./workflows.ts"

const step = (over: Record<string, unknown> = {}) => ({
  kind: "agent",
  name: "Draft",
  x: 10,
  y: 20,
  agent: "Ada",
  prompt: "Write",
  ...over,
})
const flow = (over: Record<string, unknown> = {}) => ({
  name: "Digest",
  steps: [step()],
  ...over,
})
const file = (workflows: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: WORKFLOW_FILE_FORMAT,
    version: WORKFLOW_FILE_VERSION,
    workflows,
    ...over,
  })

const refused = (text: string) => {
  const result = parseWorkflowFile(text)
  if (result.ok) throw new Error("the file was accepted")
  return result
}
const accepted = (text: string) => {
  const result = parseWorkflowFile(text)
  if (!result.ok) throw new Error(`the file was refused: ${result.code} ${result.detail}`)
  return result.file
}
const fault = (text: string): GraphFault => {
  const result = refused(text)
  expect(result.code).toBe("workflow_file_graph")
  return JSON.parse(result.detail ?? "{}") as GraphFault
}

describe("parseWorkflowFile", () => {
  test("reads name, trigger, steps of every kind, connections and notes", () => {
    const result = accepted(
      file([
        {
          name: "Morning",
          trigger: { kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } },
          steps: [
            step({ effort: "low", continueOnFailure: true }),
            { kind: "condition", name: "Greeting?", x: 300, y: 0, mode: "ask", text: "Is it?" },
            { kind: "approval", name: "Gate", x: 600, y: 0, message: "Go on?" },
            { kind: "post", name: "Post", x: 900, y: 0, text: "Result: {{input}}" },
            { kind: "notify", name: "Tell", x: 1200, y: 0, title: "Done" },
          ],
          connections: [
            { from: 1, to: 2 },
            { from: 2, to: 3, branch: "yes" },
            { from: 2, to: 5, branch: "no" },
            { from: 3, to: 4 },
          ],
          notes: [{ text: "Check the tone", tone: "pink", x: 5, y: 6 }],
        },
      ]),
    )
    expect(result.workflows).toHaveLength(1)
    const [w] = result.workflows
    expect(w?.name).toBe("Morning")
    expect(w?.trigger).toEqual({ kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } })
    expect(w?.steps.map((s) => s.kind)).toEqual([
      "agent",
      "condition",
      "approval",
      "post",
      "notify",
    ])
    expect(w?.steps[0]).toEqual({
      kind: "agent",
      name: "Draft",
      x: 10,
      y: 20,
      agent: "Ada",
      prompt: "Write",
      effort: "low",
      continueOnFailure: true,
    })
    expect(w?.steps[1]).toMatchObject({ kind: "condition", mode: "ask", text: "Is it?" })
    expect(w?.connections).toEqual([
      { from: 1, to: 2, branch: null },
      { from: 2, to: 3, branch: "yes" },
      { from: 2, to: 5, branch: "no" },
      { from: 3, to: 4, branch: null },
    ])
    expect(w?.notes).toEqual([{ text: "Check the tone", tone: "pink", x: 5, y: 6 }])
  })

  test("only a name is needed; the other fields take their default", () => {
    const [w] = accepted(file([{ name: " Bare " }])).workflows
    expect(w).toEqual({
      name: "Bare",
      trigger: { kind: "manual" },
      steps: [],
      connections: [],
      notes: [],
    })
    const [d] = accepted(
      file([
        {
          name: "Defaults",
          steps: [
            { kind: "agent", name: "A" },
            { kind: "condition", name: "C" },
            { kind: "post", name: "P" },
            { kind: "notify", name: "N" },
            { kind: "approval", name: "G" },
          ],
          connections: [
            { from: 2, to: 3, branch: "yes" },
            { from: 2, to: 4, branch: "no" },
          ],
        },
      ]),
    ).workflows
    expect(d?.steps).toEqual([
      {
        kind: "agent",
        name: "A",
        x: 0,
        y: 0,
        agent: "",
        prompt: "",
        effort: null,
        continueOnFailure: false,
      },
      { kind: "condition", name: "C", x: 230, y: 0, mode: "contains", text: "" },
      { kind: "post", name: "P", x: 460, y: 0, text: "{{input}}" },
      { kind: "notify", name: "N", x: 0, y: 110, title: "" },
      { kind: "approval", name: "G", x: 230, y: 110, message: "" },
    ])
  })

  test("a place is rounded; notes that have no place go below the steps", () => {
    const [w] = accepted(
      file([
        flow({
          steps: [step({ x: 10.6, y: -3.2 })],
          notes: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }],
        }),
      ]),
    ).workflows
    expect(w?.steps[0]).toMatchObject({ x: 11, y: -3 })
    expect(w?.notes.map((n) => [n.x, n.y, n.tone])).toEqual([
      [0, 220, "yellow"],
      [230, 220, "yellow"],
      [460, 220, "yellow"],
      [0, 330, "yellow"],
    ])
  })

  test("a connection twice counts once, and a branch on another step means nothing", () => {
    const [w] = accepted(
      file([
        flow({
          steps: [step(), step({ name: "B" })],
          connections: [
            { from: 1, to: 2 },
            { from: 1, to: 2 },
            { from: 1, to: 2, branch: "yes" },
          ],
        }),
      ]),
    ).workflows
    expect(w?.connections).toEqual([{ from: 1, to: 2, branch: null }])
  })

  test("fields that the format does not define are ignored", () => {
    const [w] = accepted(
      file(
        [
          flow({
            id: "x",
            enabled: true,
            runs: [{ id: "r" }],
            trigger: { kind: "manual", cron: "* * * * *" },
            steps: [step({ agentId: "abc", model: "o3", secret: "sk-abc" })],
          }),
        ],
        { chat: [], key: "sk-0123456789abcdefghij" },
      ),
    ).workflows
    expect(Object.keys(w ?? {}).sort()).toEqual([
      "connections",
      "name",
      "notes",
      "steps",
      "trigger",
    ])
    expect(Object.keys(w?.steps[0] ?? {}).sort()).toEqual([
      "agent",
      "continueOnFailure",
      "effort",
      "kind",
      "name",
      "prompt",
      "x",
      "y",
    ])
  })

  test("a byte order mark at the start is allowed", () => {
    expect(accepted(`\uFEFF${file([flow()])}`).workflows).toHaveLength(1)
  })

  test("a file that was written reads back the same", () => {
    const workflows: WorkflowFileWorkflow[] = [
      {
        name: "One",
        trigger: { kind: "schedule", schedule: { kind: "weekly", days: [1, 3], time: "09:00" } },
        steps: [
          {
            kind: "agent",
            name: "A",
            x: 1,
            y: 2,
            agent: "Ada",
            prompt: "p",
            effort: "max",
            continueOnFailure: false,
          },
          { kind: "condition", name: "C", x: 3, y: 4, mode: "ask", text: "q" },
          { kind: "post", name: "P", x: 5, y: 6, text: "t" },
          { kind: "notify", name: "N", x: 7, y: 8, title: "T" },
        ],
        connections: [
          { from: 1, to: 2, branch: null },
          { from: 2, to: 3, branch: "yes" },
          { from: 2, to: 4, branch: "no" },
        ],
        notes: [{ text: "n", tone: "green", x: 9, y: 10 }],
      },
      {
        name: "Two",
        trigger: { kind: "manual" },
        steps: [],
        connections: [],
        notes: [],
      },
    ]
    const text = writeWorkflowFile(workflows)
    expect(text.endsWith("\n")).toBe(true)
    expect(accepted(text).workflows).toEqual(workflows)
    expect(JSON.parse(text)).toMatchObject({ format: "robot-workflows", version: 1 })
  })

  test("the file holds 20 workflows at most", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Flow ${i}` }))
    expect(accepted(file(many(WORKFLOW_FILE_MAX_WORKFLOWS))).workflows).toHaveLength(20)
    expect(refused(file(many(WORKFLOW_FILE_MAX_WORKFLOWS + 1)))).toMatchObject({
      code: "workflow_file_too_many",
      detail: "21",
    })
    expect(WORKFLOW_FILE_MAX_BYTES).toBe(10 * 1024 * 1024)
  })
})

describe("a file that is refused", () => {
  test("not JSON, another format, a version that is not valid or newer", () => {
    expect(refused("nope")).toMatchObject({ code: "workflow_file_format" })
    expect(refused("[]")).toMatchObject({ code: "workflow_file_format" })
    expect(refused(file([flow()], { format: "robot-agents" }))).toMatchObject({
      code: "workflow_file_format",
    })
    for (const version of [0, 1.5, "1", null])
      expect(refused(file([flow()], { version }))).toMatchObject({
        code: "workflow_file_field",
        detail: "version",
      })
    expect(refused(file([flow()], { version: 2 }))).toMatchObject({
      code: "workflow_file_version",
      detail: "2",
    })
  })

  test("no workflows, or workflows that are not a list", () => {
    expect(refused(file([]))).toMatchObject({ code: "workflow_file_empty" })
    expect(refused(file({}))).toMatchObject({ code: "workflow_file_field", detail: "workflows" })
  })

  test("two workflows of one name, ignoring case and spaces at the ends", () => {
    expect(refused(file([{ name: "Digest" }, { name: "  digest " }]))).toMatchObject({
      code: "workflow_file_duplicate",
      detail: "digest",
    })
  })

  test("a value with the wrong type or outside its limit names its place", () => {
    const cases: [WorkflowFileErrorCode, unknown, string][] = [
      ["workflow_file_field", [5], "workflows[0]"],
      ["workflow_file_field", [{ name: 5 }], "workflows[0].name"],
      ["workflow_file_name_length", [{ name: "  " }], "workflows[0].name"],
      [
        "workflow_file_name_length",
        [{ name: "x".repeat(WORKFLOW_NAME_MAX + 1) }],
        "workflows[0].name",
      ],
      ["workflow_file_field", [{ name: "A", steps: {} }], "workflows[0].steps"],
      ["workflow_file_field", [flow({ steps: [5] })], "workflows[0].steps[0]"],
      [
        "workflow_file_field",
        [flow({ steps: [step({ kind: "model" })] })],
        "workflows[0].steps[0].kind",
      ],
      [
        "workflow_file_name_length",
        [flow({ steps: [step({ name: "" })] })],
        "workflows[0].steps[0].name",
      ],
      ["workflow_file_field", [flow({ steps: [step({ x: "1" })] })], "workflows[0].steps[0].x"],
      ["workflow_file_field", [flow({ steps: [step({ y: 1e12 })] })], "workflows[0].steps[0].y"],
      [
        "workflow_file_field",
        [flow({ steps: [step({ agent: "x".repeat(41) })] })],
        "workflows[0].steps[0].agent",
      ],
      [
        "workflow_file_field",
        [flow({ steps: [step({ prompt: 5 })] })],
        "workflows[0].steps[0].prompt",
      ],
      [
        "workflow_file_field",
        [flow({ steps: [step({ prompt: "x".repeat(20_001) })] })],
        "workflows[0].steps[0].prompt",
      ],
      [
        "workflow_file_field",
        [flow({ steps: [step({ effort: "extreme" })] })],
        "workflows[0].steps[0].effort",
      ],
      [
        "workflow_file_field",
        [flow({ steps: [step({ continueOnFailure: "yes" })] })],
        "workflows[0].steps[0].continueOnFailure",
      ],
      [
        "workflow_file_field",
        [flow({ steps: [step({ kind: "condition", mode: "guess" })] })],
        "workflows[0].steps[0].mode",
      ],
      [
        "workflow_file_field",
        [flow({ steps: [step({ kind: "notify", title: "x".repeat(101) })] })],
        "workflows[0].steps[0].title",
      ],
      [
        "workflow_file_field",
        [flow({ trigger: { kind: "channel" } })],
        "workflows[0].trigger.kind",
      ],
      ["workflow_file_field", [flow({ trigger: "manual" })], "workflows[0].trigger"],
      [
        "workflow_file_schedule",
        [flow({ trigger: { kind: "schedule" } })],
        "workflows[0].trigger.schedule",
      ],
      [
        "workflow_file_schedule",
        [flow({ trigger: { kind: "schedule", schedule: { kind: "daily", times: ["25:00"] } } })],
        "workflows[0].trigger.schedule",
      ],
      ["workflow_file_field", [flow({ connections: {} })], "workflows[0].connections"],
      [
        "workflow_file_field",
        [flow({ connections: [{ from: "1", to: 1 }] })],
        "workflows[0].connections[0].from",
      ],
      [
        "workflow_file_field",
        [flow({ steps: [step(), step()], connections: [{ from: 1, to: 2, branch: "maybe" }] })],
        "workflows[0].connections[0].branch",
      ],
      [
        "workflow_file_field",
        [flow({ notes: [{ text: "x".repeat(2001) }] })],
        "workflows[0].notes[0].text",
      ],
      [
        "workflow_file_field",
        [flow({ notes: [{ text: "a", tone: "red" }] })],
        "workflows[0].notes[0].tone",
      ],
      [
        "workflow_file_field",
        [flow({ notes: Array.from({ length: 51 }, () => ({ text: "a" })) })],
        "workflows[0].notes",
      ],
      [
        "workflow_file_field",
        [{ name: "A" }, flow({ name: "B", notes: [4] })],
        "workflows[1].notes[0]",
      ],
    ]
    for (const [code, workflows, detail] of cases)
      expect(refused(file(workflows))).toEqual({ ok: false, code, detail })
  })
})

describe("the rules of the graph", () => {
  const two = [step(), step({ name: "B" })]
  const cond = (over: Record<string, unknown> = {}) =>
    step({ kind: "condition", name: "C", ...over })

  test("a connection to a step that does not exist names the workflow and the connection", () => {
    expect(
      fault(
        file([
          { name: "Other" },
          flow({
            steps: two,
            connections: [
              { from: 1, to: 2 },
              { from: 2, to: 3 },
            ],
          }),
        ]),
      ),
    ).toEqual({ workflow: "Digest", fault: "unknown_step", place: { kind: "connection", n: 2 } })
    expect(fault(file([flow({ steps: two, connections: [{ from: 0 + 1, to: 9 }] })])).fault).toBe(
      "unknown_step",
    )
    expect(fault(file([flow({ steps: [], connections: [{ from: 1, to: 2 }] })])).fault).toBe(
      "unknown_step",
    )
  })

  test("a connection from a step to itself, or a loop", () => {
    expect(fault(file([flow({ steps: two, connections: [{ from: 2, to: 2 }] })]))).toMatchObject({
      fault: "self_connection",
      place: { kind: "connection", n: 1 },
    })
    expect(
      fault(
        file([
          flow({
            steps: [step(), step({ name: "B" }), step({ name: "C" })],
            connections: [
              { from: 1, to: 2 },
              { from: 2, to: 3 },
              { from: 3, to: 2 },
            ],
          }),
        ]),
      ),
    ).toEqual({ workflow: "Digest", fault: "cycle", place: { kind: "connection", n: 3 } })
  })

  test("a condition needs a branch on each connection and both branches", () => {
    const three = [cond(), step({ name: "B" }), step({ name: "D" })]
    expect(fault(file([flow({ steps: three, connections: [{ from: 1, to: 2 }] })]))).toMatchObject({
      fault: "missing_branch",
      place: { kind: "connection", n: 1 },
    })
    expect(
      fault(file([flow({ steps: three, connections: [{ from: 1, to: 2, branch: "yes" }] })])),
    ).toMatchObject({ workflow: "Digest", fault: "branches", place: { kind: "step", n: 1 } })
    expect(
      fault(
        file([
          flow({
            steps: three,
            connections: [
              { from: 1, to: 2, branch: "yes" },
              { from: 1, to: 3, branch: "yes" },
            ],
          }),
        ]),
      ).fault,
    ).toBe("branches")
    // A condition with no connection at all has no branch either.
    expect(fault(file([flow({ steps: [cond()] })]))).toMatchObject({ fault: "branches" })
    // Both branches: the file is fine.
    expect(
      accepted(
        file([
          flow({
            steps: three,
            connections: [
              { from: 1, to: 2, branch: "yes" },
              { from: 1, to: 3, branch: "no" },
            ],
          }),
        ]),
      ).workflows,
    ).toHaveLength(1)
  })

  test("more steps than the limit", () => {
    const steps = Array.from({ length: WORKFLOW_STEPS_MAX + 1 }, (_, i) => step({ name: `S${i}` }))
    expect(fault(file([{ name: "Fine" }, flow({ name: "Long", steps })]))).toEqual({
      workflow: "Long",
      fault: "too_many_steps",
      place: { kind: "steps", n: WORKFLOW_STEPS_MAX + 1 },
    })
    expect(
      accepted(file([flow({ steps: steps.slice(0, WORKFLOW_STEPS_MAX) })])).workflows,
    ).toHaveLength(1)
  })

  test("graphFault finds the same faults in a workflow that is to be written", () => {
    const steps = [{ kind: "condition" as const }, { kind: "agent" as const }]
    expect(graphFault("W", steps, [{ from: 1, to: 2, branch: "yes" }])).toMatchObject({
      fault: "branches",
    })
    expect(
      graphFault("W", steps, [
        { from: 1, to: 2, branch: "yes" },
        { from: 1, to: 2, branch: "no" },
      ]),
    ).toBeNull()
  })

  test("the first fault of a workflow in the file is the one that is named", () => {
    expect(
      fault(
        file([
          flow({ name: "First", steps: two, connections: [{ from: 1, to: 1 }] }),
          flow({ name: "Second", steps: two, connections: [{ from: 1, to: 7 }] }),
        ]),
      ).workflow,
    ).toBe("First")
  })
})

describe("secrets in a file", () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz0123"
  test("every text is cleaned, and the names stay inside their limits", () => {
    const parsed = accepted(
      file([
        {
          name: `Flow ${key}`,
          steps: [
            step({ name: `Step ${key}`, agent: `Ada ${key}`, prompt: `Use ${key}` }),
            { kind: "condition", name: "C", text: `Is ${key} here?` },
            { kind: "approval", name: "G", message: `OK ${key}` },
            { kind: "post", name: "P", text: `Say ${key}` },
            { kind: "notify", name: "N", title: `T ${key}` },
          ],
          connections: [
            { from: 2, to: 3, branch: "yes" },
            { from: 2, to: 4, branch: "no" },
          ],
          notes: [{ text: `Note ${key}` }],
        },
      ]),
    )
    const cleaned = mapFileTexts(parsed, (t) => redactSecrets(t, ["my-stored-api-key-value"]))
    expect(JSON.stringify(cleaned)).not.toContain(key)
    expect(JSON.stringify(cleaned)).toContain("[redacted]")
    const w = cleaned.workflows[0]
    expect(w?.name).toBe("Flow [redacted]")
    expect(w?.steps[0]).toMatchObject({ agent: "Ada [redacted]", prompt: "Use [redacted]" })
    // A key that is stored on this computer is hidden too.
    const stored = mapFileTexts(parsed, (t) => t.replace("Use", "my-stored-api-key-value"))
    expect(
      JSON.stringify(redactSecrets(JSON.stringify(stored), ["my-stored-api-key-value"])),
    ).not.toContain("my-stored-api-key-value")
  })
})

describe("what an import makes", () => {
  const workflow = (): WorkflowFileWorkflow => ({
    name: "Digest",
    trigger: { kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } },
    steps: [
      {
        kind: "agent",
        name: "Draft",
        x: 1,
        y: 2,
        agent: "ADA",
        prompt: "p",
        effort: "low",
        continueOnFailure: true,
      },
      {
        kind: "agent",
        name: "Check",
        x: 3,
        y: 4,
        agent: "Ghost",
        prompt: "q",
        effort: null,
        continueOnFailure: false,
      },
      {
        kind: "agent",
        name: "Free",
        x: 5,
        y: 6,
        agent: "",
        prompt: "r",
        effort: null,
        continueOnFailure: false,
      },
      { kind: "condition", name: "Ask", x: 7, y: 8, mode: "ask", text: "Is it?" },
      { kind: "post", name: "Post", x: 9, y: 10, text: "{{input}}" },
      { kind: "notify", name: "Tell", x: 11, y: 12, title: "Done" },
    ],
    connections: [
      { from: 1, to: 2, branch: null },
      { from: 3, to: 4, branch: null },
      { from: 4, to: 5, branch: "yes" },
      { from: 4, to: 6, branch: "no" },
    ],
    notes: [{ text: "Hello", tone: "blue", x: 13, y: 14 }],
  })
  const agents = new Map([[nameKey("Ada"), "agent-ada"]])
  const make = () => toWorkflowInput("server-1", workflow(), "Digest 2", (key) => agents.get(key))

  test("the workflow keeps its steps in order, with their fields, and an agent step is linked by name", () => {
    const input = make()
    expect(input).toMatchObject({ serverId: "server-1", name: "Digest 2" })
    expect(input.steps.map((s) => [s.kind, s.name, s.x, s.y])).toEqual([
      ["agent", "Draft", 1, 2],
      ["agent", "Check", 3, 4],
      ["agent", "Free", 5, 6],
      ["condition", "Ask", 7, 8],
      ["post", "Post", 9, 10],
      ["notify", "Tell", 11, 12],
    ])
    expect(input.steps[0]).toMatchObject({
      agentId: "agent-ada",
      prompt: "p",
      effort: "low",
      continueOnFailure: true,
    })
    expect(input.steps[3]).toMatchObject({ mode: "ask", contains: "Is it?" })
    expect(input.steps[5]).toMatchObject({ title: "Done" })
    expect(input.edges.map((e) => [e.from, e.to, e.branch])).toEqual([
      ["s1", "s2", undefined],
      ["s3", "s4", undefined],
      ["s4", "s5", "yes"],
      ["s4", "s6", "no"],
    ])
    expect(input.notes).toEqual([{ id: "n1", text: "Hello", tone: "blue", x: 13, y: 14 }])
    expect(input.trigger).toEqual({
      kind: "schedule",
      schedule: { kind: "daily", times: ["08:30"] },
    })
  })

  test("a step with an agent that is not found has no agent; a post step has no place", () => {
    const input = make()
    expect(input.steps[1]).toMatchObject({ kind: "agent", agentId: "" })
    expect(input.steps[2]).toMatchObject({ kind: "agent", agentId: "" })
    expect(input.steps[4]).toMatchObject({ kind: "post", channelId: "" })
    expect(input.steps[1] && "effort" in input.steps[1]).toBe(false)
  })

  test("what it makes is a workflow that the app accepts", () => {
    const input = make()
    expect(Schema.is(WorkflowInput)(input)).toBe(true)
    for (const s of input.steps) expect(Schema.is(StepSchema)(s)).toBe(true)
  })

  test("the agent names that are not found, once each, in file order", () => {
    const second = workflow()
    const file = {
      workflows: [
        workflow(),
        {
          ...second,
          name: "Other",
          steps: [...second.steps, { ...second.steps[1], name: "Again" }],
        },
      ],
    } as Parameters<typeof missingAgentNames>[0]
    expect(missingAgentNames(file, (key) => agents.has(key))).toEqual(["Ghost"])
    expect(missingAgentNames(file, () => false)).toEqual(["ADA", "Ghost"])
    expect(missingAgentNames(file, () => true)).toEqual([])
  })

  test("a taken name gets a number inside the limit, ignoring case", () => {
    expect(planNames(["Digest", "digest", "Other"], ["DIGEST"], WORKFLOW_NAME_MAX)).toEqual([
      "Digest 2",
      "digest 3",
      "Other",
    ])
    const long = "x".repeat(WORKFLOW_NAME_MAX)
    const [numbered] = planNames([long], [long], WORKFLOW_NAME_MAX)
    expect(charLength(numbered ?? "")).toBe(WORKFLOW_NAME_MAX)
    expect(numbered?.endsWith(" 2")).toBe(true)
  })
})

describe("the document of the format", () => {
  const doc = readFileSync(
    join(import.meta.dirname, "../../../docs/workflow-file-format.md"),
    "utf8",
  )

  test("the example in it is a file that the app accepts", () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1]
    expect(block).toBeTruthy()
    const result = parseWorkflowFile(block ?? "")
    if (!result.ok) throw new Error(`${result.code} ${result.detail}`)
    const [w] = result.file.workflows
    expect(w?.steps.map((s) => s.kind)).toEqual(["agent", "condition", "post", "notify"])
    expect(w?.steps[1]).toMatchObject({ mode: "ask" })
    expect(w?.notes).toHaveLength(1)
  })

  test("it names the format, the version, the limits and every key that the app reads", () => {
    expect(doc).toContain(`\`${WORKFLOW_FILE_FORMAT}\``)
    expect(doc).toContain("10 485 760 bytes")
    for (const key of [
      "format",
      "version",
      "workflows",
      "name",
      "trigger",
      "schedule",
      "steps",
      "connections",
      "notes",
      "kind",
      "x",
      "y",
      "agent",
      "prompt",
      "effort",
      "continueOnFailure",
      "mode",
      "text",
      "message",
      "title",
      "from",
      "to",
      "branch",
      "tone",
    ])
      expect(doc).toContain(`\`${key}\``)
    for (const word of [
      ...STEP_EFFORTS,
      ...NOTE_TONES,
      "agent",
      "condition",
      "approval",
      "post",
      "notify",
    ])
      expect(doc).toContain(`"${word}"`)
    for (const limit of [
      "1 to 20 workflows",
      "0 to 30 entries",
      "0 to 50 entries",
      "20 000",
      "2 000",
    ])
      expect(doc).toContain(limit)
  })
})
