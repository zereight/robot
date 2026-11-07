import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { PermissionLevel } from "@robot/shared"
import { Effect } from "effect"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import {
  type AssistantContext,
  assistantGate,
  isAssistantTool,
  makeAssistantTools,
  newAssistantTurn,
  type TurnOrigin,
} from "./assistantTools.ts"
import type { CardReply } from "./Cards.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { RunFacts } from "./RunFacts.ts"
import { Runs, runClock } from "./Runs.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { WorkflowCheck } from "./WorkflowCheck.ts"
import { Workflows } from "./Workflows.ts"

// The tools of the chat that read and change the workflow and its runs (spec 010, "Assistant";
// spec 007). Real services and a real database; the only stand-in is the model provider.

let mock: MockProvider
beforeAll(async () => {
  mock = await startMockProvider()
  runClock.retryWaitMs = 10
})
afterAll(async () => {
  await mock.close()
})

const until = async (ok: () => boolean | Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error("timeout")
}

const setup = async (level: PermissionLevel = "ask_risky") => {
  const t = testRuntime({ check: { auto: false } })
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  await run(
    Providers.use((p) =>
      p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
    ),
  )
  const account = (await run(Providers.use((p) => p.accounts)))[0]
  if (!account) throw new Error("no account")
  const flow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Report" })))
  if (level !== "ask_risky") await run(Workflows.use((w) => w.setPermission(flow.id, level)))
  const a = await run(
    Workflows.use((w) =>
      w.addNode(flow.id, {
        kind: "text",
        name: "Fetch",
        prompt: "Fetch the data.",
        accountId: account.id,
        model: "mock-fast",
      }),
    ),
  )
  const b = await run(
    Workflows.use((w) =>
      w.addNode(flow.id, {
        kind: "text",
        name: "Write",
        prompt: "Write the report. {{input}}",
        accountId: account.id,
        model: "mock-fast",
      }),
    ),
  )
  await run(Workflows.use((w) => w.connect(flow.id, a.id, b.id, null)))
  const tools = await run(
    Effect.gen(function* () {
      return makeAssistantTools({
        workflows: yield* Workflows,
        runs: yield* Runs,
        facts: yield* RunFacts,
        check: yield* WorkflowCheck,
        providers: yield* Providers,
      })
    }),
  )
  let turn = newAssistantTurn("user", await run(Workflows.use((w) => w.graph(flow.id))))
  /** A new turn of the chat: it sees the graph as it is now. */
  const newTurn = async (origin: TurnOrigin = "user") => {
    turn = newAssistantTurn(origin, await run(Workflows.use((w) => w.graph(flow.id))))
  }
  const asked: { step: string; summary: string }[] = []
  let reply: CardReply["answer"] | "throw" = "allow"
  const ctx = (extra: Partial<AssistantContext> = {}): AssistantContext => ({
    workflowId: flow.id,
    level,
    outside: null,
    program: false,
    turn,
    ask: async (step, summary) => {
      asked.push({ step, summary })
      if (reply === "throw") throw new Error("stopped")
      return { answer: reply, inChat: true }
    },
    ...extra,
  })
  let n = 0
  const call = (name: string, args: object = {}, extra: Partial<AssistantContext> = {}) =>
    tools.execute(ctx(extra), { id: `c${++n}`, name, input: JSON.stringify(args) })
  const graph = () => run(Workflows.use((w) => w.graph(flow.id)))
  // The versions that the setup made (it adds nodes by hand) are not counted.
  const baseline = (await run(Workflows.use((w) => w.versions(flow.id)))).length
  const versions = async () => {
    const all = await run(Workflows.use((w) => w.versions(flow.id)))
    return all.slice(0, all.length - baseline)
  }
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  return {
    ...t,
    run,
    server,
    account,
    flow,
    a,
    b,
    call,
    graph,
    versions,
    sql,
    newTurn,
    asked,
    answerWith: (answer: CardReply["answer"] | "throw") => {
      reply = answer
    },
  }
}

const out = (r: { outcome: { output: string } }) => r.outcome.output

/** Adds a decision node (number 3) whose options lead to node 1 and node 2. */
const decide = async (t: Awaited<ReturnType<typeof setup>>, labels: [string, string]) => {
  const r = await t.call("add_node", {
    kind: "decision",
    name: "Pick",
    question: "Q?",
    options: [
      { label: labels[0], to: 1 },
      { label: labels[1], to: 2 },
    ],
  })
  expect(r.outcome.failed).toBe(false)
}

describe("who may use the tools (spec 007, 'Who may use them'; spec 010)", () => {
  test("the one function lets a turn of the user in, and keeps out a program, Teams and a node", () => {
    expect(assistantGate("user")).toBeNull()
    for (const origin of ["program", "teams", "node"] as const)
      expect(assistantGate(origin)).toContain("started in the chat")
  })

  test("every tool is refused in a turn that the user did not start, and nothing changes", async () => {
    const t = await setup()
    const before = JSON.stringify(await t.graph())
    for (const origin of ["program", "teams", "node"] as const) {
      await t.newTurn(origin)
      for (const name of [
        "list_workflows",
        "read_workflow",
        "add_node",
        "edit_node",
        "remove_node",
        "add_connection",
        "remove_connection",
        "add_option",
        "rename_option",
        "remove_option",
        "start_run",
        "stop_run",
        "read_run",
        "read_run_result",
      ]) {
        expect(isAssistantTool(name)).toBe(true)
        const r = await t.call(name, { node: 1, kind: "text", name: "X" })
        expect(r.outcome.failed).toBe(true)
        expect(out(r)).toContain("started in the chat")
      }
    }
    expect(JSON.stringify(await t.graph())).toBe(before)
    expect(await t.versions()).toHaveLength(0)
    expect(await t.run(Runs.use((r) => r.list(t.flow.id)))).toHaveLength(0)
  })
})

describe("reads (spec 010, 'Assistant')", () => {
  test("list_workflows gives names and counts, and no id and no folder", async () => {
    const t = await setup()
    const other = await t.run(
      Workflows.use((w) => w.create({ serverId: t.server.id, name: "Weekly" })),
    )
    const r = await t.call("list_workflows")
    expect(r.outcome.failed).toBe(false)
    expect(out(r)).toContain('"Report" (this workflow): 2 nodes')
    expect(out(r)).toContain('"Weekly": 0 nodes')
    expect(out(r)).not.toContain(other.id)
    expect(out(r)).not.toContain(other.folder)
    expect(out(r)).not.toContain(t.flow.id)
  })

  test("read_workflow gives the nodes with their numbers, the connections and the triggers", async () => {
    const t = await setup()
    const r = await t.call("read_workflow")
    expect(out(r)).toContain('Node 1 "Fetch" (text node)')
    expect(out(r)).toContain('Node 2 "Write" (text node)')
    expect(out(r)).toContain("Connections: 1 -> 2")
    expect(out(r)).toContain("Triggers: none")
  })

  test("no tool takes the id of another workflow: a foreign id in the arguments is ignored", async () => {
    const t = await setup()
    const other = await t.run(
      Workflows.use((w) => w.create({ serverId: t.server.id, name: "Weekly" })),
    )
    await t.run(
      Workflows.use((w) => w.addNode(other.id, { kind: "text", name: "Secret node", prompt: "x" })),
    )
    const r = await t.call("read_workflow", { workflowId: other.id, id: other.id })
    expect(out(r)).not.toContain("Secret node")
    const add = await t.call("add_node", { kind: "text", name: "Mine", workflowId: other.id })
    expect(add.outcome.failed).toBe(false)
    expect((await t.run(Workflows.use((w) => w.graph(other.id)))).nodes).toHaveLength(1)
    expect((await t.graph()).nodes.map((n) => n.name)).toContain("Mine")
  })

  test("secrets are hidden in what a tool gives back", async () => {
    const t = await setup()
    // A prompt can hold a secret that was written before the check of secrets existed.
    await t.sql(
      "UPDATE workflow_node SET prompt = ? WHERE workflow_id = ? AND number = 1",
      `Use the key sk-${"a1b2".repeat(8)} please`,
      t.flow.id,
    )
    await t.newTurn()
    const r = await t.call("read_workflow")
    expect(out(r)).not.toContain("a1b2a1b2")
  })
})

describe("changes of the graph (spec 010: add, edit and remove nodes and connections)", () => {
  test("add a node: it gets number 3, the version holds the graph from before, the answer says so", async () => {
    const t = await setup()
    const r = await t.call("add_node", { kind: "text", name: "Send", prompt: "Send it." })
    expect(r.outcome.failed).toBe(false)
    expect(out(r)).toContain('Node 3 "Send" was added')
    expect(out(r)).toContain("kept as a version")
    const g = await t.graph()
    expect(g.nodes.map((n) => [n.number, n.name])).toEqual([
      [1, "Fetch"],
      [2, "Write"],
      [3, "Send"],
    ])
    const v = await t.versions()
    expect(v).toHaveLength(1)
    expect(v[0]?.source).toBe("chat")
    expect(v[0]?.graph.nodes).toHaveLength(2)
    expect(r.guarded).toMatchObject({ kind: "change", decidedBy: "level", result: "ran" })
  })

  test("add a decision node: every option needs a connection, in the same call", async () => {
    const t = await setup()
    const one = await t.call("add_node", {
      kind: "decision",
      name: "Pick",
      question: "Which?",
      options: [{ label: "Yes", to: 1 }],
    })
    expect(one.outcome.failed).toBe(true)
    expect(out(one)).toContain("at least 2 options")
    const bare = await t.call("add_node", {
      kind: "decision",
      name: "Pick",
      question: "Which?",
      options: ["Yes", "No"],
    })
    expect(bare.outcome.failed).toBe(true)
    expect(out(bare)).toContain('the option "Yes" of node 3 has no connection')
    const missing = await t.call("add_node", {
      kind: "decision",
      name: "Pick",
      options: [
        { label: "Yes", to: 1 },
        { label: "No", to: 9 },
      ],
    })
    expect(missing.outcome.failed).toBe(true)
    expect(await t.versions()).toHaveLength(0)
    const two = await t.call("add_node", {
      kind: "decision",
      name: "Pick",
      question: "Which?",
      options: [
        { label: "Yes", to: 1 },
        { label: "No", to: 2 },
      ],
    })
    expect(two.outcome.failed).toBe(false)
    const g = await t.graph()
    expect(g.nodes[2]?.options.map((o) => o.label)).toEqual(["Yes", "No"])
    expect(g.connections).toHaveLength(3)
  })

  test("add a node after node 2: it gets number 3 and a connection from node 2", async () => {
    const t = await setup()
    const r = await t.call("add_node", { kind: "text", name: "Send", prompt: "x", after: 2 })
    expect(r.outcome.failed).toBe(false)
    const g = await t.graph()
    expect(g.nodes[2]?.number).toBe(3)
    expect(g.connections.filter((c) => c.to === g.nodes[2]?.id)).toHaveLength(1)
    const loop = await t.call("add_connection", { from: 3, to: 1 })
    // A connection from node 3 back to node 1 makes a loop of waits: the check refuses it.
    expect(loop.outcome.failed).toBe(true)
    const bad = await t.call("add_node", { kind: "text", name: "X", after: 9 })
    expect(bad.outcome.failed).toBe(true)
  })

  test("edit a node: the prompt changes, clear removes a field, a field that is left out stays", async () => {
    const t = await setup()
    const r = await t.call("edit_node", { node: 2, prompt: "Write it in three lines." })
    expect(r.outcome.failed).toBe(false)
    expect((await t.graph()).nodes[1]?.prompt).toBe("Write it in three lines.")
    expect((await t.graph()).nodes[1]?.model).toBe("mock-fast")
    const cleared = await t.call("edit_node", { node: 2, clear: ["prompt", "model"] })
    expect(cleared.outcome.failed).toBe(false)
    const n = (await t.graph()).nodes[1]
    expect([n?.prompt, n?.accountId, n?.model, n?.effort]).toEqual(["", null, null, null])
    expect((await t.versions()).map((v) => v.source)).toEqual(["chat", "chat"])
    const same = await t.call("edit_node", { node: 2, name: "Write" })
    expect(same.outcome.failed).toBe(true)
  })

  test("a model that the account offers is set; a model that it does not offer is refused", async () => {
    const t = await setup()
    const ok = await t.call("edit_node", { node: 1, model: "gpt-5", effort: "high" })
    expect(ok.outcome.failed).toBe(false)
    expect((await t.graph()).nodes[0]).toMatchObject({ model: "gpt-5", effort: "high" })
    const before = (await t.versions()).length
    const bad = await t.call("edit_node", { node: 2, model: "no-such-model" })
    expect(bad.outcome.failed).toBe(true)
    expect(out(bad)).toContain('does not offer the model "no-such-model"')
    const effort = await t.call("edit_node", { node: 2, effort: "high" })
    expect(effort.outcome.failed).toBe(true)
    expect(out(effort)).toContain("does not take the reasoning level")
    expect((await t.graph()).nodes[1]?.model).toBe("mock-fast")
    expect(await t.versions()).toHaveLength(before)
  })

  test("a node keeps its account; a node with no account gets an account only with a model", async () => {
    const t = await setup()
    const moved = await t.call("edit_node", { node: 1, accountId: "another-account" })
    expect(moved.outcome.failed).toBe(true)
    expect(out(moved)).toContain("keeps its account")
    const added = await t.call("add_node", { kind: "text", name: "Bare", prompt: "x" })
    expect(added.outcome.failed).toBe(false)
    const alone = await t.call("edit_node", { node: 3, accountId: t.account.id })
    expect(alone.outcome.failed).toBe(true)
    expect(out(alone)).toContain("together")
    const both = await t.call("edit_node", { node: 3, accountId: t.account.id, model: "gpt-5" })
    expect(both.outcome.failed).toBe(false)
    const fake = await t.call("add_node", {
      kind: "text",
      name: "Ghost",
      accountId: "no-such-account",
      model: "x",
    })
    expect(fake.outcome.failed).toBe(true)
    expect(out(fake)).toContain("not connected")
  })

  test("a decision node takes no prompt and no model; a text node takes no question", async () => {
    const t = await setup()
    await decide(t, ["A", "B"])
    expect((await t.call("edit_node", { node: 3, prompt: "x" })).outcome.failed).toBe(true)
    expect((await t.call("edit_node", { node: 3, model: "gpt-5" })).outcome.failed).toBe(true)
    expect((await t.call("edit_node", { node: 3, threshold: 2 })).outcome.failed).toBe(true)
    expect((await t.call("edit_node", { node: 3, threshold: 0.5 })).outcome.failed).toBe(false)
    expect((await t.call("edit_node", { node: 1, question: "Q?" })).outcome.failed).toBe(true)
    expect((await t.call("edit_node", { node: 9, name: "x" })).outcome.failed).toBe(true)
    expect((await t.call("edit_node", { node: "one", name: "x" })).outcome.failed).toBe(true)
  })

  test("remove a node: the later nodes get a lower number and its connections go", async () => {
    const t = await setup()
    await t.call("add_node", { kind: "text", name: "Send", prompt: "x" })
    const r = await t.call("remove_node", { node: 1 })
    expect(r.outcome.failed).toBe(false)
    const g = await t.graph()
    expect(g.nodes.map((n) => [n.number, n.name])).toEqual([
      [1, "Write"],
      [2, "Send"],
    ])
    expect(g.connections).toHaveLength(0)
    expect((await t.versions())[0]?.graph.nodes).toHaveLength(3)
    const last = await t.call("remove_node", { node: 1 })
    expect(last.outcome.failed).toBe(false)
    const empty = await t.call("remove_node", { node: 1 })
    expect(empty.outcome.failed).toBe(false)
    expect((await t.graph()).nodes).toHaveLength(0)
  })

  test("connections: add, remove, twice, to itself, and to a node that does not exist", async () => {
    const t = await setup()
    await t.call("add_node", { kind: "text", name: "Send", prompt: "x" })
    expect((await t.call("add_connection", { from: 2, to: 3 })).outcome.failed).toBe(false)
    const twice = await t.call("add_connection", { from: 2, to: 3 })
    expect(twice.outcome.failed).toBe(true)
    expect(out(twice)).toContain("already")
    expect((await t.call("add_connection", { from: 3, to: 3 })).outcome.failed).toBe(true)
    expect((await t.call("add_connection", { from: 3, to: 7 })).outcome.failed).toBe(true)
    expect((await t.call("remove_connection", { from: 2, to: 3 })).outcome.failed).toBe(false)
    expect((await t.call("remove_connection", { from: 2, to: 3 })).outcome.failed).toBe(true)
    expect((await t.graph()).connections).toHaveLength(1)
  })

  test("options: add, rename, remove; a decision node keeps two; a text node has none", async () => {
    const t = await setup()
    await decide(t, ["A", "B"])
    expect((await t.call("add_option", { node: 3, option: "C", to: 2 })).outcome.failed).toBe(false)
    expect((await t.call("add_option", { node: 3, option: "C", to: 2 })).outcome.failed).toBe(true)
    expect((await t.call("add_option", { node: 3, option: "D" })).outcome.failed).toBe(true)
    expect(
      (await t.call("rename_option", { node: 3, option: "C", label: "Maybe" })).outcome.failed,
    ).toBe(false)
    expect((await t.call("remove_option", { node: 3, option: "Maybe" })).outcome.failed).toBe(false)
    expect((await t.call("remove_option", { node: 3, option: "B" })).outcome.failed).toBe(true)
    expect((await t.graph()).nodes[2]?.options.map((o) => o.label)).toEqual(["A", "B"])
    expect((await t.call("add_option", { node: 1, option: "A", to: 2 })).outcome.failed).toBe(true)
  })

  test("a connection leaves the graph with its option", async () => {
    const t = await setup()
    await decide(t, ["A", "B"])
    await t.call("add_option", { node: 3, option: "C", to: 2 })
    expect((await t.graph()).connections).toHaveLength(4)
    await t.call("remove_option", { node: 3, option: "C" })
    expect((await t.graph()).connections).toHaveLength(3)
  })

  test("a secret in a name or a prompt is refused; nothing saves", async () => {
    const t = await setup()
    const r = await t.call("add_node", {
      kind: "text",
      name: "Key",
      prompt: `Use sk-${"a1b2".repeat(8)}`,
    })
    expect(r.outcome.failed).toBe(true)
    expect(out(r)).toContain("secret")
    expect(await t.versions()).toHaveLength(0)
  })

  test("the check refuses a change that makes a deadlock; the graph stays and no version is kept", async () => {
    const t = await setup()
    const r = await t.call("add_connection", { from: 2, to: 1 })
    expect(r.outcome.failed).toBe(true)
    expect(out(r)).toContain("the check found a problem")
    expect((await t.graph()).connections).toHaveLength(1)
    expect(await t.versions()).toHaveLength(0)
  })

  test("a workflow holds at most 30 nodes", async () => {
    const t = await setup()
    for (let i = 3; i <= 30; i++)
      await t.run(
        Workflows.use((w) => w.addNode(t.flow.id, { kind: "text", name: `N${i}`, prompt: "x" })),
      )
    await t.newTurn()
    const r = await t.call("add_node", { kind: "text", name: "One too many" })
    expect(r.outcome.failed).toBe(true)
    expect(out(r)).toContain("at most 30")
  })
})

describe("a stale change is refused (spec 010: the user changes the workflow while the chat works)", () => {
  test("a change after the user edited the graph is refused until the chat reads the graph again", async () => {
    const t = await setup()
    // The user renames a node in the editor while the turn works.
    await t.run(Workflows.use((w) => w.updateNode(t.a.id, { name: "Fetch data" })))
    const stale = await t.call("add_node", { kind: "text", name: "Send", prompt: "x" })
    expect(stale.outcome.failed).toBe(true)
    expect(out(stale)).toContain("read_workflow")
    expect((await t.graph()).nodes).toHaveLength(2)
    expect(await t.versions()).toHaveLength(1) // only the version of the user's own edit
    const read = await t.call("read_workflow")
    expect(out(read)).toContain("Fetch data")
    const again = await t.call("add_node", { kind: "text", name: "Send", prompt: "x" })
    expect(again.outcome.failed).toBe(false)
  })

  test("the turn's own change does not make its next change stale; a move on the canvas is not a change", async () => {
    const t = await setup()
    expect(
      (await t.call("add_node", { kind: "text", name: "Send", prompt: "x" })).outcome.failed,
    ).toBe(false)
    await t.run(Workflows.use((w) => w.moveNode(t.a.id, 500, 500)))
    expect((await t.call("edit_node", { node: 3, name: "Send it" })).outcome.failed).toBe(false)
  })

  test("a change that the user made while the card waited is refused", async () => {
    const t = await setup()
    const ask = async () => {
      await t.run(Workflows.use((w) => w.updateNode(t.a.id, { prompt: "Changed by the user" })))
      return { answer: "allow", inChat: true }
    }
    const r = await t.call(
      "add_node",
      { kind: "text", name: "Send", prompt: "x" },
      { outside: { kind: "page", host: "example.com" }, ask },
    )
    expect(r.outcome.failed).toBe(true)
    expect((await t.graph()).nodes).toHaveLength(2)
  })

  test("a change while a run works is refused", async () => {
    const t = await setup()
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', 1)",
      t.flow.id,
    )
    const r = await t.call("add_node", { kind: "text", name: "Send", prompt: "x" })
    expect(r.outcome.failed).toBe(true)
    expect(out(r)).toContain("run works")
  })
})

describe("permission levels and outside content (spec 007)", () => {
  test("Read only refuses every change and the start of a run, and reads still work", async () => {
    const t = await setup("read_only")
    for (const [name, args] of [
      ["add_node", { kind: "text", name: "Send" }],
      ["edit_node", { node: 1, name: "X" }],
      ["remove_node", { node: 1 }],
      ["add_connection", { from: 1, to: 2 }],
      ["remove_connection", { from: 1, to: 2 }],
      ["add_option", { node: 1, option: "A" }],
      ["rename_option", { node: 1, option: "A", label: "B" }],
      ["remove_option", { node: 1, option: "A" }],
      ["start_run", {}],
    ] as const) {
      const r = await t.call(name, args)
      expect(r.outcome.failed).toBe(true)
      expect(r.outcome.refused).toBe("read_only")
      expect(r.guarded).toMatchObject({ decidedBy: "level", result: "refused" })
    }
    expect(await t.versions()).toHaveLength(0)
    expect(await t.run(Runs.use((r) => r.list(t.flow.id)))).toHaveLength(0)
    expect(t.asked).toHaveLength(0)
    expect((await t.call("read_workflow")).outcome.failed).toBe(false)
    expect((await t.call("list_workflows")).outcome.failed).toBe(false)
    expect((await t.call("read_run")).outcome.failed).toBe(false)
  })

  test("a turn that holds outside content asks before a change: Deny saves nothing, Allow saves", async () => {
    const t = await setup()
    const outside = { kind: "page" as const, host: "example.com" }
    t.answerWith("deny")
    const denied = await t.call("add_node", { kind: "text", name: "Send" }, { outside })
    expect(denied.outcome.failed).toBe(false)
    expect(out(denied)).toContain("the user refused")
    expect(denied.guarded).toMatchObject({ decidedBy: "user", result: "refused" })
    expect(t.asked).toHaveLength(1)
    expect(t.asked[0]?.step).toBe("change")
    expect((await t.graph()).nodes).toHaveLength(2)
    t.answerWith("allow")
    const allowed = await t.call("add_node", { kind: "text", name: "Send" }, { outside })
    expect(allowed.outcome.failed).toBe(false)
    expect(allowed.guarded).toMatchObject({ decidedBy: "user", result: "ran" })
    expect((await t.graph()).nodes).toHaveLength(3)
    t.answerWith("throw")
    const stopped = await t.call("add_node", { kind: "text", name: "Third" }, { outside })
    expect(stopped.guarded).toMatchObject({ result: "stopped" })
    expect((await t.graph()).nodes).toHaveLength(3)
  })

  test("with no way to ask, a turn that holds outside content changes nothing (fail closed)", async () => {
    const t = await setup()
    const r = await t.call(
      "add_node",
      { kind: "text", name: "Send" },
      { outside: { kind: "page", host: "example.com" }, ask: undefined as never },
    )
    expect(r.outcome.failed).toBe(true)
    expect((await t.graph()).nodes).toHaveLength(2)
  })

  test("at Full access a change runs without a card, but not with the program mark", async () => {
    const t = await setup("full")
    const outside = { kind: "page" as const, host: "example.com" }
    const free = await t.call("add_node", { kind: "text", name: "Send" }, { outside })
    expect(free.outcome.failed).toBe(false)
    expect(t.asked).toHaveLength(0)
    const marked = await t.call(
      "add_node",
      { kind: "text", name: "Third" },
      { outside: { kind: "teams" }, program: true },
    )
    expect(marked.outcome.failed).toBe(false)
    expect(t.asked).toHaveLength(1)
  })

  test("a run starts only after a card in a turn that holds outside content, also at Full access", async () => {
    const t = await setup("full")
    const outside = { kind: "page" as const, host: "example.com" }
    t.answerWith("deny")
    const denied = await t.call("start_run", {}, { outside })
    expect(out(denied)).toContain("the user refused")
    expect(denied.guarded).toMatchObject({ kind: "run", result: "refused" })
    expect(t.asked[0]?.step).toBe("run")
    expect(await t.run(Runs.use((r) => r.list(t.flow.id)))).toHaveLength(0)
  })
})

describe("runs (spec 010: start one, stop it, read it)", () => {
  /** Makes the first node slow, so that the run works for some seconds. */
  const slow = (t: Awaited<ReturnType<typeof setup>>) =>
    t.sql(
      "UPDATE workflow_node SET prompt = 'slow' WHERE workflow_id = ? AND number = 1",
      t.flow.id,
    )

  test("start_run starts one run; a second start in the same turn is refused; the log has the step", async () => {
    const t = await setup()
    await slow(t)
    const r = await t.call("start_run", { trigger: "Weekly" })
    expect(r.outcome.failed).toBe(false)
    expect(out(r)).toContain("started")
    expect(r.guarded).toMatchObject({ kind: "run", decidedBy: "level", result: "ran" })
    const list = await t.run(Runs.use((x) => x.list(t.flow.id)))
    expect(list).toHaveLength(1)
    expect(list[0]?.source).toBe("chat")
    const second = await t.call("start_run", {})
    expect(second.outcome.failed).toBe(true)
    expect(out(second)).toContain("at most one run")
    await t.newTurn()
    const third = await t.call("start_run", {})
    expect(out(third)).toContain("works or waits")
    await t.run(Runs.use((x) => x.stop(list[0]?.id ?? "")))
  })

  test("start_run from a node is refused; no run starts", async () => {
    const t = await setup()
    const r = await t.call("start_run", { fromNode: 2 })
    expect(r.outcome.failed).toBe(true)
    expect(out(r)).toContain("not built")
    expect(await t.run(Runs.use((x) => x.list(t.flow.id)))).toHaveLength(0)
  })

  test("start_run on an empty workflow or a workflow with a loop says why", async () => {
    const t = await setup()
    await t.call("remove_node", { node: 1 })
    await t.call("remove_node", { node: 1 })
    const r = await t.call("start_run", {})
    expect(r.outcome.failed).toBe(true)
    expect(out(r)).toContain("no node")
    // The failed start does not use the one start of the turn.
    await t.call("add_node", { kind: "text", name: "Only", prompt: "x" })
    expect((await t.call("start_run", {})).outcome.failed).toBe(false)
  })

  test("read_run tells the state of each node and the node that works; stop_run stops the run", async () => {
    const t = await setup()
    await slow(t)
    await t.call("start_run", {})
    await until(async () => {
      const r = await t.call("read_run")
      return out(r).includes('Node 1 "Fetch" (text): running')
    })
    const r = await t.call("read_run")
    expect(out(r)).toContain("works or waits now")
    expect(out(r)).toContain('Node 2 "Write" (text): not reached')
    expect(out(r)).toContain("Result: none yet")
    const stopped = await t.call("stop_run")
    expect(stopped.outcome.failed).toBe(false)
    await until(async () => !(await t.run(Runs.use((x) => Effect.sync(() => x.active(t.flow.id))))))
    const after = await t.call("read_run")
    expect(out(after)).toContain("ended")
    expect(out(after)).toContain("cancelled")
    expect(out(await t.call("stop_run"))).toContain("No run works or waits")
  })

  test("stop_run works at Read only; a run id of another workflow is not found", async () => {
    const t = await setup("read_only")
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', 1)",
      t.flow.id,
    )
    const other = await t.run(
      Workflows.use((w) => w.create({ serverId: t.server.id, name: "Weekly" })),
    )
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r2', ?, 'running', 'hand', 1)",
      other.id,
    )
    const foreign = await t.call("stop_run", { run: "r2" })
    expect(foreign.outcome.failed).toBe(true)
    const own = await t.call("stop_run", { run: "r1" })
    expect(own.outcome.failed).toBe(false)
    const read = await t.call("read_run", { run: "r2" })
    expect(out(read)).toContain("not a run of this workflow")
  })

  test("read_run_result gives the result of a node that ended, and none for a node that did not", async () => {
    const t = await setup()
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', 1)",
      t.flow.id,
    )
    await t.sql(
      "INSERT INTO task (id, run_id, workflow_id, node_name, node_number, state, result, created_at, finished_at) VALUES ('t1', 'r1', ?, 'Fetch', 1, 'done', ?, 1, 2)",
      t.flow.id,
      `The data. Key sk-${"a1b2".repeat(8)} and <b>tags</b>`,
    )
    const ended = await t.call("read_run_result", { node: 1 })
    expect(ended.outcome.failed).toBe(false)
    expect(out(ended)).toContain("The data.")
    expect(out(ended)).not.toContain("a1b2a1b2")
    expect(out(ended)).toContain("&lt;b&gt;")
    expect(ended.outside).toBeUndefined()
    const pending = await t.call("read_run_result", { node: 2 })
    expect(out(pending)).toContain("has not ended")
    expect(out(pending)).not.toContain("Result:")
    expect((await t.call("read_run_result", { node: 9 })).outcome.failed).toBe(true)
    expect((await t.call("read_run_result", {})).outcome.failed).toBe(true)
  })

  test("a result of a task that held outside content marks the turn, and shows its source", async () => {
    const t = await setup()
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at, finished_at) VALUES ('r1', ?, 'done', 'hand', 1, 2)",
      t.flow.id,
    )
    await t.sql(
      "INSERT INTO task (id, run_id, workflow_id, node_name, node_number, state, result, created_at, finished_at, outside_mark, program_mark) VALUES ('t1', 'r1', ?, 'Fetch', 1, 'done', 'Page text', 1, 2, ?, 0)",
      t.flow.id,
      JSON.stringify({ kind: "page", host: "evil.example" }),
    )
    const one = await t.call("read_run_result", { node: 1 })
    expect(out(one)).toContain("outside content: the task read a web page (evil.example)")
    expect(one.outside).toEqual({ source: { kind: "page", host: "evil.example" }, program: false })
    const all = await t.call("read_run")
    expect(all.outside?.source).toEqual({ kind: "page", host: "evil.example" })
  })

  test("a run that waits for the user says what it waits for; a failed run says why", async () => {
    const t = await setup()
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at, finished_at, reason) VALUES ('r1', ?, 'failed', 'hand', 1, 2, 'The app stopped')",
      t.flow.id,
    )
    const r = await t.call("read_run")
    expect(out(r)).toContain("The app stopped")
  })

  test("read_run on a workflow that never ran says so", async () => {
    const t = await setup()
    expect(out(await t.call("read_run"))).toContain("No run yet")
  })
})
