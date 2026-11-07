import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ChatPart, WorkflowChatMessage } from "@robot/shared"
import { Effect } from "effect"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import { standIn, tool as standTool } from "../connections/standIn.ts"
import { runRequest } from "../rpc.ts"
import { ASSISTANT_TOOL_DEFS } from "./assistantTools.ts"
import { Cards } from "./Cards.ts"
import { Chat } from "./Chat.ts"
import { Connections, type ConnectionsOptions } from "./Connections.ts"
import { Database } from "./Database.ts"
import { Devices } from "./Devices.ts"
import { Providers } from "./Providers.ts"
import { Runs, runClock } from "./Runs.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
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

const setup = async (level?: "read_only" | "full", connections?: ConnectionsOptions) => {
  const t = testRuntime({ check: { auto: false }, ...(connections ? { connections } : {}) })
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
      "create_workflow",
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

  test("the chat gets no tool of a connection and no tool that changes one; a call of such a name fails and the connection starts nothing (spec 018)", async () => {
    const fake = standIn([standTool("echo")])
    const t = await setup(undefined, { open: fake.open })
    const form = {
      name: "Notes",
      kind: "program" as const,
      command: "notes-server",
      args: [],
      folder: "",
      env: [],
      address: "",
      headers: [],
    }
    await t.run(Connections.use((c) => c.test({ connection: form })))
    const saved = await t.run(
      Connections.use((c) => c.save({ connection: form, confirmed: true, scope: { kind: "all" } })),
    )
    fake.state.opened.length = 0
    await t.send("hello")
    await t.idle()
    // No tool of a connection, no step "Search tools", and no tool that adds, changes or removes a
    // connection of spec 018 (the tools "add_connection" and "remove_connection" are lines of the
    // graph between two nodes).
    const names = toolNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => n.startsWith("mcp__") || n === "search_tools")).toEqual([])
    expect(names.filter((n) => /connection/.test(n)).sort()).toEqual([
      "add_connection",
      "remove_connection",
    ])
    expect(
      ASSISTANT_TOOL_DEFS.map((d) => d.name).filter((n) => /scope|workflows_of|trust/.test(n)),
    ).toEqual([])
    // A line of the graph takes node numbers, so it cannot name a connection of spec 018.
    const before = (await t.run(Connections.use((c) => c.list)))[0]?.scope
    await t.send('tool mcp__notes__echo {"text":"hi"}')
    await t.idle()
    await t.send(`tool add_connection {"from":1,"to":2,"connection":"${saved.id}"}`)
    await t.idle()
    expect(fake.state.calls).toEqual([])
    expect(fake.state.opened).toHaveLength(0)
    expect((await t.run(Connections.use((c) => c.list)))[0]?.scope).toEqual(before)
    // The chat starts a run: the text nodes of the run ask for the connection, the chat does not.
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

// A linked client reaches the chat through the handlers of the link (spec 012). The chat changes
// the graph for a client only when the server lets that client change workflows.
describe("the chat for a linked client (spec 012, 'No switch')", () => {
  const link = async (t: Awaited<ReturnType<typeof setup>>, id: string, canChange: boolean) => {
    await t.sql(
      "INSERT INTO device_link (id, name, kind, public_key, inbound, position, created_at, can_change) VALUES (?, ?, 'phone', '', 1, ?, 0, ?)",
      id,
      id,
      id.length,
      canChange ? 1 : 0,
    )
  }
  const asDevice = (t: Awaited<ReturnType<typeof setup>>, id: string) => (text: string) =>
    runRequest(t.runtime, "chat.send", { workflowId: t.flow.id, text }, { id, name: id })
  const server = (t: Awaited<ReturnType<typeof setup>>) =>
    t.run(Devices.use((d) => Effect.sync(() => d.deviceName())))
  const notes = async (t: Awaited<ReturnType<typeof setup>>) =>
    (await t.reply()).parts.filter((p) => p.kind === "note")
  const lastVersion = (t: Awaited<ReturnType<typeof setup>>) =>
    t.run(
      Database.use((d) =>
        Effect.sync(() =>
          d.get<{ source: string; device: string | null }>(
            "SELECT source, device FROM workflow_version WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            t.flow.id,
          ),
        ),
      ),
    )
  /** The card of a tool in the last reply of the assistant (a joined message may follow it). */
  const card = async (t: Awaited<ReturnType<typeof setup>>, name: string) =>
    (await t.history()).messages
      .filter((m) => m.author === "assistant")
      .at(-1)
      ?.parts.find(
        (p): p is Extract<ChatPart, { kind: "tool" }> => p.kind === "tool" && p.name === name,
      )
  const ADD = 'tool add_node {"kind":"text","name":"Send","prompt":"Send the report."}'

  test("a client without the switch asks the chat to add a node: not allowed, the graph does not change", async () => {
    const t = await setup()
    await link(t, "phone", false)
    const sent = await asDevice(t, "phone")(ADD)
    expect(sent.ok).toBe(true)
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await t.versions()).filter((v) => v.source === "chat")).toHaveLength(0)
    const shown = await card(t, "add_node")
    expect(shown).toMatchObject({ state: "failed", notRun: true })
    expect(shown?.output).toContain("Not allowed")
    expect(await notes(t)).toEqual([{ kind: "note", note: "not_allowed", server: await server(t) }])
    // The user at the server sees the refusal in the action log, with the name of the device.
    const log = await t.run(
      Database.use((d) =>
        Effect.sync(() =>
          d.all<{ kind: string; result: string; device: string | null; target: string }>(
            "SELECT kind, result, device, target FROM action_log WHERE workflow_id = ?",
            t.flow.id,
          ),
        ),
      ),
    )
    expect(log).toEqual([
      { kind: "change", result: "refused", device: "phone", target: "Add a node" },
    ])
  })

  test("every changing tool is refused for a client without the switch", async () => {
    const t = await setup()
    await link(t, "phone", false)
    const send = asDevice(t, "phone")
    for (const message of [
      'tool edit_node {"node":1,"prompt":"x"}',
      'tool remove_node {"node":2}',
      'tool add_connection {"from":2,"to":1}',
      'tool remove_connection {"from":1,"to":2}',
    ]) {
      await send(message)
      await t.idle()
      expect(JSON.stringify((await t.reply()).parts)).toContain("Not allowed")
    }
    expect((await t.versions()).filter((v) => v.source === "chat")).toHaveLength(0)
    expect((await t.graph()).nodes.map((n) => n.name)).toEqual(["Fetch", "Write"])
  })

  test("a client with the switch changes the graph, and the version names the client", async () => {
    const t = await setup()
    await link(t, "tablet", true)
    await asDevice(t, "tablet")(ADD)
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(3)
    expect((await card(t, "add_node"))?.state).toBe("done")
    expect(await lastVersion(t)).toEqual({ source: "chat", device: "tablet" })
  })

  test("the window of the server needs no switch", async () => {
    const t = await setup()
    await t.send(ADD)
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(3)
    expect(await lastVersion(t)).toEqual({ source: "chat", device: null })
  })

  test("a run that a client starts through the chat needs no switch and names the client", async () => {
    const t = await setup()
    await t.sql("UPDATE workflow_node SET prompt = 'slow' WHERE number = 1")
    await link(t, "phone", false)
    await asDevice(t, "phone")("tool start_run {}")
    await t.idle()
    expect((await t.tool("start_run"))?.state).toBe("done")
    const started = await t.run(
      Database.use((d) =>
        Effect.sync(() =>
          d.get<{ source: string; device: string | null }>(
            "SELECT source, device FROM run WHERE workflow_id = ?",
            t.flow.id,
          ),
        ),
      ),
    )
    expect(started).toEqual({ source: "chat", device: "phone" })
    await asDevice(t, "phone")("tool stop_run {}")
    await t.idle()
    expect((await t.tool("stop_run"))?.output).toContain("stopped")
  })

  test("the switch is turned off while the turn works: the next change is refused", async () => {
    const t = await setup()
    await link(t, "phone", true)
    await asDevice(t, "phone")(`tool-hold ${ADD.slice(5)}`)
    await until(() => mock.held() === 1)
    await t.run(Devices.use((d) => d.setCanChange("phone", false)))
    mock.release()
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await card(t, "add_node"))?.output).toContain("Not allowed")
  })

  test("a device that is not linked any more has no switch: the change is refused", async () => {
    const t = await setup()
    await link(t, "phone", true)
    await asDevice(t, "phone")(`tool-hold ${ADD.slice(5)}`)
    await until(() => mock.held() === 1)
    await t.sql("DELETE FROM device_link WHERE id = 'phone'")
    mock.release()
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await card(t, "add_node"))?.output).toContain("Not allowed")
  })

  test("a turn that joins a message of the window and one of a client without the switch: the weakest wins", async () => {
    const t = await setup()
    await link(t, "phone", false)
    // The window starts the turn, the client joins it.
    await t.send(`tool-hold ${ADD.slice(5)}`)
    await until(() => mock.held() === 1)
    await asDevice(t, "phone")("please also tidy up")
    mock.release()
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await card(t, "add_node"))?.output).toContain("Not allowed")
  })

  test("the client starts the turn and the window joins it: the weakest wins as well", async () => {
    const t = await setup()
    await link(t, "phone", false)
    await asDevice(t, "phone")(`tool-hold ${ADD.slice(5)}`)
    await until(() => mock.held() === 1)
    await t.send("and do it now")
    mock.release()
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await card(t, "add_node"))?.output).toContain("Not allowed")
  })

  test("a message that waits in the queue keeps its sender: the turn for it is the turn of the client", async () => {
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ duringTurn: "queue" })))
    await link(t, "phone", false)
    await t.send("tool-hold read_workflow {}")
    await until(() => mock.held() === 1)
    await asDevice(t, "phone")(ADD)
    mock.release()
    await t.idle()
    await until(async () => (await t.history()).queue.length === 0 && !(await t.history()).working)
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await card(t, "add_node"))?.output).toContain("Not allowed")
  })

  test("a client with the switch and the window together: the change saves and names the client", async () => {
    const t = await setup()
    await link(t, "tablet", true)
    await t.send(`tool-hold ${ADD.slice(5)}`)
    await until(() => mock.held() === 1)
    await asDevice(t, "tablet")("go on")
    mock.release()
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(3)
    expect(await lastVersion(t)).toEqual({ source: "chat", device: "tablet" })
  })

  test("a client without the switch can still read and ask: the chat answers", async () => {
    const t = await setup()
    await link(t, "phone", false)
    await asDevice(t, "phone")("tool read_workflow {}")
    await t.idle()
    expect((await t.tool("read_workflow"))?.state).toBe("done")
  })

  test("a retry keeps the sender: the turn after a retry is still the turn of the client", async () => {
    const t = await setup()
    await link(t, "phone", false)
    await asDevice(t, "phone")(ADD)
    await t.idle()
    // The reply is marked as failed, as a failed request would leave it. The retry asks again.
    await t.sql(
      "UPDATE chat_message SET status = 'failed', error_code = 'x' WHERE author = 'assistant'",
    )
    await runRequest(
      t.runtime,
      "chat.retry",
      { workflowId: t.flow.id },
      { id: "phone", name: "phone" },
    )
    await t.idle()
    expect((await t.graph()).nodes).toHaveLength(2)
    expect((await card(t, "add_node"))?.output).toContain("Not allowed")
  })
})
