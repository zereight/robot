import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ChatPart, WorkflowChatMessage } from "@robot/shared"
import { Effect } from "effect"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import { Cards } from "./Cards.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Runs, runClock } from "./Runs.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

// The chat of a workflow uses the tools that read and change the workflow and its runs (spec 010,
// "Assistant"; spec 007). The model is a stand-in that makes the tool call that a message names.

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
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("timeout")
}

const setup = async (level?: "read_only" | "full") => {
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
    Workflows.use((w) => w.addNode(flow.id, { kind: "text", name: "Write", prompt: "Write." })),
  )
  await run(Workflows.use((w) => w.connect(flow.id, a.id, b.id, null)))
  if (level) await run(Workflows.use((w) => w.setPermission(flow.id, level)))
  const send = (text: string) => run(Chat.use((c) => c.send({ workflowId: flow.id, text })))
  const history = () => run(Chat.use((c) => c.history(flow.id)))
  const idle = () => until(async () => !(await history()).working)
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const reply = async () => (await history()).messages.at(-1) as WorkflowChatMessage
  const tool = async (name: string) =>
    (await reply()).parts.find(
      (p): p is Extract<ChatPart, { kind: "tool" }> => p.kind === "tool" && p.name === name,
    )
  const graph = () => run(Workflows.use((w) => w.graph(flow.id)))
  const versions = () => run(Workflows.use((w) => w.versions(flow.id)))
  const cardOpen = async () => (await history()).cards.find((c) => c.answer === null)
  const answerCard = async (answer: "allow" | "deny") => {
    await until(async () => (await cardOpen()) !== undefined)
    const card = (await cardOpen()) as { id: string }
    await run(Cards.use((c) => c.answer(card.id, { kind: "approval", answer })))
  }
  return {
    ...t,
    run,
    flow,
    account,
    send,
    history,
    idle,
    sql,
    reply,
    tool,
    graph,
    versions,
    cardOpen,
    answerCard,
  }
}

const toolNames = () => mock.requests.at(-1)?.body.tools?.map((x) => x.function.name) ?? []

describe("the tools of the chat (spec 010, 'Assistant')", () => {
  test("a turn offers add_run_feedback first, then the tools of the workflow", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    const names = toolNames()
    expect(names[0]).toBe("add_run_feedback")
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
    ])
      expect(names).toContain(name)
    const system = JSON.stringify(mock.requests.at(-1)?.body.messages[0])
    expect(system).toContain("Node 1")
    expect(system).toContain("Rules for the tools of the workflow")
  })

  test("add a node by chat: the graph has node 3, the version holds the graph from before, the card shows", async () => {
    const t = await setup()
    await t.send(
      'tool add_node {"kind":"text","name":"Send","prompt":"Send the report.","after":2}',
    )
    await t.idle()
    const g = await t.graph()
    expect(g.nodes.map((n) => n.name)).toEqual(["Fetch", "Write", "Send"])
    const v = await t.versions()
    expect(v.find((x) => x.source === "chat")?.graph.nodes).toHaveLength(2)
    const card = await t.tool("add_node")
    expect(card?.state).toBe("done")
    expect(card?.output).toContain("kept as a version")
  })

  test("a model that the account does not offer is refused, and the chat tells the user", async () => {
    const t = await setup()
    await t.send(`tool edit_node {"node":1,"model":"no-such-model"}`)
    await t.idle()
    expect((await t.graph()).nodes[0]?.model).toBe("mock-fast")
    const card = await t.tool("edit_node")
    expect(card?.output).toContain('does not offer the model "no-such-model"')
    expect(JSON.stringify((await t.reply()).parts)).toContain("Tool said")
  })

  test("run by chat, then ask how far it ran: the tool gives the state of each node", async () => {
    const t = await setup()
    await t.sql("UPDATE workflow_node SET prompt = 'slow' WHERE number = 1")
    await t.send('tool start_run {"trigger":"Weekly"}')
    await t.idle()
    expect((await t.tool("start_run"))?.output).toContain("started")
    const list = await t.run(Runs.use((r) => r.list(t.flow.id)))
    expect(list).toHaveLength(1)
    await t.send("tool read_run {}")
    await t.idle()
    const out = (await t.tool("read_run"))?.output ?? ""
    expect(out).toContain('Node 1 "Fetch" (text): running')
    expect(out).toContain('Node 2 "Write" (text): not reached')
    // The system prompt of the next turn holds the same facts.
    await t.send("tool stop_run {}")
    await t.idle()
    expect((await t.tool("stop_run"))?.output).toContain("stopped")
    await until(async () => !(await t.run(Runs.use((r) => Effect.sync(() => r.active(t.flow.id))))))
    expect((await t.run(Runs.use((r) => r.get(list[0]?.id ?? "")))).state).toBe("cancelled")
  })

  test("Read only refuses a change and a run; nothing changes", async () => {
    const t = await setup("read_only")
    await t.send('tool add_node {"kind":"text","name":"Send"}')
    await t.idle()
    expect((await t.tool("add_node"))?.output).toContain("Read only")
    expect((await t.tool("add_node"))?.state).toBe("failed")
    await t.send("tool start_run {}")
    await t.idle()
    expect((await t.tool("start_run"))?.output).toContain("Read only")
    expect((await t.graph()).nodes).toHaveLength(2)
    expect(await t.run(Runs.use((r) => r.list(t.flow.id)))).toHaveLength(0)
  })

  test("a turn that holds outside content asks before a change; Deny keeps the graph", async () => {
    const t = await setup()
    await t.sql(
      "UPDATE workflow SET outside_mark = ? WHERE id = ?",
      JSON.stringify({ source: { kind: "page", host: "example.com" }, program: false }),
      t.flow.id,
    )
    await t.send('tool add_node {"kind":"text","name":"Send"}')
    await t.answerCard("deny")
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(2)
    await t.send('tool add_node {"kind":"text","name":"Send"}')
    await t.answerCard("allow")
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(3)
  })

  test("the user changes the workflow while the chat works: the change of the chat is refused", async () => {
    const t = await setup()
    await t.send('tool-hold add_node {"kind":"text","name":"Send"}')
    await until(() => mock.held() === 1)
    const first = (await t.graph()).nodes[0]
    await t.run(Workflows.use((w) => w.updateNode(first?.id ?? "", { name: "Fetch data" })))
    mock.release()
    await t.idle()
    const card = await t.tool("add_node")
    expect(card?.state).toBe("failed")
    expect(card?.output).toContain("read_workflow")
    expect((await t.graph()).nodes.map((n) => n.name)).toEqual(["Fetch data", "Write"])
    // The chat reads the graph again, and the next change works.
    await t.send("tool read_workflow {}")
    await t.idle()
    expect((await t.tool("read_workflow"))?.output).toContain("Fetch data")
  })

  test("the action log has the change, with the permission level as the one who decided", async () => {
    const t = await setup()
    await t.send('tool add_node {"kind":"text","name":"Send"}')
    await t.idle()
    const rows = await t.run(
      Database.use((d) =>
        Effect.sync(() =>
          d.all<{ kind: string; decided_by: string; result: string }>(
            "SELECT kind, decided_by, result FROM action_log WHERE workflow_id = ?",
            t.flow.id,
          ),
        ),
      ),
    )
    expect(rows).toEqual([{ kind: "change", decided_by: "level", result: "ran" }])
  })
})
