import { describe, expect, test } from "bun:test"
import type { WorkflowGraph } from "@robot/shared"
import { chatSystem } from "./chatPrompt.ts"

const graph: WorkflowGraph = {
  nodes: [
    {
      id: "n1",
      number: 1,
      kind: "text",
      name: "Fetch",
      prompt: "Fetch.",
      accountId: null,
      model: null,
      effort: null,
      backup: null,
      silentLimit: null,
      permission: null,
      continueOnFailure: false,
      question: "",
      threshold: 0.5,
      options: [],
      x: 0,
      y: 0,
    },
  ],
  connections: [],
}

const base = {
  name: "Weekly",
  document: "Do the weekly report.",
  runs: [],
  feedback: true,
  graph,
  assistant: true as const,
  may: { propose: true, memory: false },
}

describe("what the chat may change (spec 010, 012)", () => {
  test("a linked device without the switch reads that it cannot change, but can run and read", () => {
    const system = chatSystem({
      ...base,
      cannotChange: { reason: "device", server: "Office" },
    })
    expect(system).toContain("Office does not let this device change workflows")
    expect(system).toContain("Settings → Devices")
    expect(system).not.toContain("To change the graph, use add_node")
    expect(system).toContain("You can still start and stop runs")
    expect(system).toContain("call read_run")
  })

  test("Read only reads that it cannot change and cannot run", () => {
    const system = chatSystem({ ...base, cannotChange: { reason: "read_only" } })
    expect(system).toContain("Read only")
    expect(system).toContain("you cannot start or stop a run")
    expect(system).not.toContain("To change the graph, use add_node")
    expect(system).toContain("settings of the workflow")
    expect(system).toContain("call read_run")
  })

  test("with full rights the prompt names direct change and proposals each for its case", () => {
    const system = chatSystem(base)
    expect(system).toContain("To change the graph, use add_node")
    expect(system).toContain("propose_graph_change")
    expect(system).toContain("When the user asks for a change")
  })

  test("with full rights the prompt names making a new workflow, and the chat stays", () => {
    const system = chatSystem(base)
    expect(system).toContain("call create_workflow")
    expect(system).toContain("The chat stays in this workflow")
  })

  test("a Claude Code bridge turn maps the tool names to their MCP names", () => {
    const system = chatSystem({ ...base, mcpTools: true })
    expect(system).toContain("mcp__robot__<name>")
    expect(chatSystem(base)).not.toContain("mcp__robot__<name>")
  })

  test("without rights the prompt forbids making a new workflow", () => {
    const device = chatSystem({ ...base, cannotChange: { reason: "device", server: "Office" } })
    expect(device).toContain("make a new workflow")
    expect(device).not.toContain("call create_workflow")
    const level = chatSystem({ ...base, cannotChange: { reason: "read_only" } })
    expect(level).toContain("make a new workflow")
    expect(level).not.toContain("call create_workflow")
  })

  test("with the switch off the prompt does not deny a direct change of the graph", () => {
    const system = chatSystem({ ...base, may: { propose: false, memory: false } })
    expect(system).toContain("no tool to propose a change that waits for the user")
    expect(system).toContain("change the graph and the prompts of nodes directly")
  })
})

describe("discipline of the responsible agent (spec 002, 010)", () => {
  test("a turn with full rights reads the no-give-up discipline", () => {
    const system = chatSystem(base)
    expect(system).toContain("Discipline of the responsible agent")
    expect(system).toContain("until it is done or proven impossible")
    expect(system).toContain("Never run the same call twice with the same input")
    expect(system).toContain("read it back")
  })

  test("a turn that cannot change reads no discipline to exhaust change tools", () => {
    const device = chatSystem({
      ...base,
      cannotChange: { reason: "device", server: "Office" },
    })
    expect(device).not.toContain("Discipline of the responsible agent")
    const readOnly = chatSystem({ ...base, cannotChange: { reason: "read_only" } })
    expect(readOnly).not.toContain("Discipline of the responsible agent")
  })

  test("a reflect turn without tools reads no discipline", () => {
    const { assistant: _assistant, ...rest } = base
    const system = chatSystem(rest)
    expect(system).not.toContain("Discipline of the responsible agent")
  })
})
