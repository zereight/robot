import { describe, expect, test } from "bun:test"
import {
  agentCounts,
  agentPicks,
  checklistItemDone,
  ignoredAgentFields,
  ignoredWorkflowFields,
  startAgentTicks,
  startWorkflowTicks,
  workflowPicks,
} from "./importReview.ts"

describe("fields that the import does not make", () => {
  test("an agent file: unknown fields of the file, an agent, a face, a routine and a schedule", () => {
    const text = JSON.stringify({
      format: "robot-agents",
      version: 1,
      made: "elsewhere",
      agents: [
        {
          name: " Ada ",
          model: "x",
          face: { shape: 1, hue: 2, picture: "p.png" },
          routines: [
            {
              name: "R",
              prompt: "p",
              place: "general",
              schedule: { kind: "daily", times: ["08:30"], at: 5 },
            },
          ],
        },
        { name: "Bob", role: "r", instructions: "i", face: null, routines: [] },
      ],
    })
    expect(ignoredAgentFields(`\uFEFF${text}`)).toEqual([
      { owner: null, field: "made" },
      { owner: "Ada", field: "model" },
      { owner: "Ada", field: "face.picture" },
      { owner: "Ada", field: "routines[0].place" },
      { owner: "Ada", field: "routines[0].schedule.at" },
    ])
  })

  test("a version 2 file: skills and the handbook are defined; the channels of an older file are not", () => {
    const text = JSON.stringify({
      format: "robot-agents",
      version: 2,
      handbook: "Text",
      agents: [{ name: "Ada" }],
      channels: [
        { name: " Launch ", members: ["Ada"], lead: null, color: "red", reviewParts: true },
      ],
      skills: [{ name: "Sum", instructions: "x", agents: ["Ada"], icon: "i" }],
      extra: 1,
    })
    expect(ignoredAgentFields(text)).toEqual([
      { owner: null, field: "channels" },
      { owner: null, field: "extra" },
      { owner: "Sum", field: "icon" },
    ])
  })

  test("a version 1 file: skills and the handbook are not defined", () => {
    const text = JSON.stringify({
      format: "robot-agents",
      version: 1,
      agents: [{ name: "Ada" }],
      channels: [],
      skills: [],
      handbook: "Text",
    })
    expect(ignoredAgentFields(text)).toEqual([
      { owner: null, field: "channels" },
      { owner: null, field: "skills" },
      { owner: null, field: "handbook" },
    ])
  })

  test("a workflow file: the fields of each kind of step, the trigger, connections and notes", () => {
    const text = JSON.stringify({
      format: "robot-workflows",
      version: 1,
      workflows: [
        {
          name: "W",
          id: "old",
          trigger: { kind: "schedule", schedule: { kind: "cron", expr: "* * * * *" }, tz: "UTC" },
          steps: [
            { kind: "agent", name: "A", agent: "Ada", effort: "low", model: "m" },
            { kind: "post", name: "P", text: "t", channelId: "c" },
            { kind: "notify", name: "N", title: "x", text: "y" },
          ],
          connections: [{ from: 1, to: 2, label: "l" }],
          notes: [{ text: "n", color: "red" }],
        },
        { name: "Plain", trigger: { kind: "manual", schedule: {} } },
      ],
    })
    expect(ignoredWorkflowFields(text)).toEqual([
      { owner: "W", field: "id" },
      { owner: "W", field: "trigger.tz" },
      { owner: "W", field: "steps[0].model" },
      { owner: "W", field: "steps[1].channelId" },
      { owner: "W", field: "steps[2].text" },
      { owner: "W", field: "connections[0].label" },
      { owner: "W", field: "notes[0].color" },
      { owner: "Plain", field: "trigger.schedule" },
    ])
  })
})

const agent = (secret = false, instructions = false, routines: boolean[] = []) => ({
  secretRemoved: secret,
  instructions: { length: 5, secretRemoved: instructions },
  routines: routines.map((r) => ({ secretRemoved: r })),
})

describe("ticks of the review", () => {
  test("at the start agents and instructions are ticked, routines and hidden secrets are not", () => {
    expect(startAgentTicks([agent(false, false, [false, true]), agent(true, true)])).toEqual([
      { agent: true, instructions: true, routines: [false, false] },
      { agent: false, instructions: false, routines: [] },
    ])
    expect(
      startWorkflowTicks([
        { secretRemoved: false, lostConnections: false },
        { secretRemoved: true, lostConnections: false },
        { secretRemoved: false, lostConnections: true },
      ]),
    ).toEqual([true, false, false])
  })

  test("an agent that is not ticked takes its instructions and routines with it", () => {
    const ticks = [
      { agent: true, instructions: false, routines: [false, true, true] },
      { agent: false, instructions: true, routines: [true] },
    ]
    expect(agentPicks(ticks)).toEqual([{ index: 0, instructions: false, routines: [1, 2] }])
    expect(agentCounts(ticks)).toEqual({ agents: 1, routines: 2 })
    expect(agentCounts([])).toEqual({ agents: 0, routines: 0 })
    expect(workflowPicks([false, true, true])).toEqual([1, 2])
  })
})

describe("checklist items", () => {
  test("a routine is done when it is on, or gone", () => {
    const item = { kind: "routine", routineId: "r", name: "R" } as const
    expect(checklistItemDone(item, { routine: () => ({ enabled: false }) })).toBe(false)
    expect(checklistItemDone(item, { routine: () => ({ enabled: true }) })).toBe(true)
    expect(checklistItemDone(item, { routine: () => undefined })).toBe(true)
  })

  test("a step is done when it has an agent, or is gone; a workflow when it is on", () => {
    const workflow = (agentId: string, enabled = false) => ({
      enabled,
      steps: [{ id: "s1", kind: "agent" as const, agentId }],
    })
    const agentItem = { kind: "stepAgent", stepId: "s1", name: "A" } as const
    expect(checklistItemDone(agentItem, { workflow: workflow("") })).toBe(false)
    expect(checklistItemDone(agentItem, { workflow: workflow("a") })).toBe(true)
    expect(checklistItemDone({ ...agentItem, stepId: "gone" }, { workflow: workflow("") })).toBe(
      true,
    )
    expect(checklistItemDone({ kind: "workflowOn" }, { workflow: workflow("") })).toBe(false)
    expect(checklistItemDone({ kind: "workflowOn" }, { workflow: workflow("", true) })).toBe(true)
  })

  test("a step that lost an input is done when a connection leads to it, or when it is gone", () => {
    const world = (edges: readonly { readonly to: string }[]) => ({
      workflow: {
        enabled: false,
        steps: [{ id: "s2", kind: "notify" as const }],
        edges,
      },
    })
    const item = { kind: "stepConnect", stepId: "s2", name: "Second" } as const
    expect(checklistItemDone(item, world([]))).toBe(false)
    expect(checklistItemDone(item, world([{ to: "s1" }]))).toBe(false)
    expect(checklistItemDone(item, world([{ to: "s2" }]))).toBe(true)
    expect(checklistItemDone({ ...item, stepId: "gone" }, world([]))).toBe(true)
  })
})
