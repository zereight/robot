import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chatFiles, chatText, type WorkflowChatMessage } from "@robot/shared"
import { Effect } from "effect"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import { runRequest } from "../rpc.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { RunFacts } from "./RunFacts.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

let mock: MockProvider
let fake: FakeRuntimes
const savedClaudeBin = process.env.ROBOT_CLAUDE_BIN
const savedCodexBin = process.env.ROBOT_CODEX_BIN
beforeAll(async () => {
  mock = await startMockProvider()
  fake = makeFakeRuntimes()
  process.env.ROBOT_CLAUDE_BIN = fake.claude
  process.env.ROBOT_CODEX_BIN = fake.codex
})
afterAll(async () => {
  if (savedClaudeBin === undefined) delete process.env.ROBOT_CLAUDE_BIN
  else process.env.ROBOT_CLAUDE_BIN = savedClaudeBin
  if (savedCodexBin === undefined) delete process.env.ROBOT_CODEX_BIN
  else process.env.ROBOT_CODEX_BIN = savedCodexBin
  await mock.close()
})

const until = async (ok: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("timeout")
}

const setup = async (options: { connect?: boolean } = {}) => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  if (options.connect !== false)
    await run(
      Providers.use((p) =>
        p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
      ),
    )
  const flow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Report" })))
  const chat = <A>(f: (c: Chat["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Chat.use(f))
  const send = (text: string, extra: Record<string, unknown> = {}) =>
    chat((c) => c.send({ workflowId: flow.id, text, ...extra }))
  const history = () => chat((c) => c.history(flow.id))
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const rows = <T>(statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all<T>(statement, ...params))))
  const idle = async () => until(async () => !(await history()).working)
  const code = async (f: Promise<unknown>) => {
    try {
      await f
      return "ok"
    } catch (e) {
      return (e as { code?: string }).code ?? String(e)
    }
  }
  return { ...t, run, flow, chat, send, history, sql, rows, idle, code, server }
}

const texts = (messages: readonly WorkflowChatMessage[]) =>
  messages.map((m) => `${m.author}:${chatText(m)}:${m.status}`)

describe("chat of a workflow (spec 003)", () => {
  test("a new chat has no message and is ready to send", async () => {
    const t = await setup()
    const h = await t.history()
    expect(h.messages).toEqual([])
    expect(h.workflowName).toBe("Report")
    expect(h.block).toBeNull()
    expect(h.working).toBe(false)
  })

  test("with no provider connected, the chat is blocked and send is refused", async () => {
    const t = await setup({ connect: false })
    expect((await t.history()).block).toBe("no_provider")
    expect(await t.code(t.send("hello"))).toBe("provider_not_connected")
    expect((await t.history()).messages).toEqual([])
  })

  test("send stores the message and the streamed reply", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    const h = await t.history()
    expect(texts(h.messages)).toEqual(["user:hello:done", "assistant:You said: hello:done"])
    const stored = await t.rows<{ model: string; output_tokens: number }>(
      "SELECT model, output_tokens FROM chat_message WHERE author = 'assistant'",
    )
    expect(stored[0]?.model).toBe("mock-fast")
    expect(stored[0]?.output_tokens).toBe(5)
  })

  test("an empty message is refused", async () => {
    const t = await setup()
    expect(await t.code(t.send("   "))).toBe("message_empty")
  })

  test("stop ends the turn, keeps the partial reply, and the next send works", async () => {
    const t = await setup()
    await t.send("slow please")
    await until(async () => {
      const m = (await t.history()).messages.at(-1)
      return m !== undefined && chatText(m).includes("word2")
    })
    await t.chat((c) => c.stop(t.flow.id))
    await t.idle()
    const stopped = (await t.history()).messages.at(-1)
    expect(stopped?.status).toBe("stopped")
    expect(chatText(stopped as WorkflowChatMessage)).toContain("word1")
    await t.send("again")
    await t.idle()
    expect(texts((await t.history()).messages).slice(-2)).toEqual([
      "user:again:done",
      "assistant:You said: again:done",
    ])
  })

  test("join the current turn: the message waits, the next request holds it, one turn only", async () => {
    const t = await setup()
    await t.send("slow start")
    await until(async () => (await t.history()).working)
    const joined = await t.send("Use b.txt instead")
    expect(joined.pending).toBe(true)
    await t.idle()
    const h = await t.history()
    expect(h.messages.filter((m) => m.author === "assistant")).toHaveLength(1)
    expect(h.messages.find((m) => m.id === joined.id)?.pending).toBe(false)
    const last = mock.requests.at(-1)
    const lastUser = last?.body.messages.at(-1)
    expect(JSON.stringify(lastUser)).toContain("Use b.txt instead")
  })

  test("a joined message that is deleted before it is read never reaches the model", async () => {
    const t = await setup()
    const before = mock.requests.length
    await t.send("slow start")
    await until(async () => (await t.history()).working)
    const joined = await t.send("never mind this")
    const back = await t.chat((c) => c.deleteWaiting(joined.id))
    expect(back.text).toBe("never mind this")
    await t.chat((c) => c.stop(t.flow.id))
    await t.idle()
    const sent = mock.requests.slice(before).map((r) => JSON.stringify(r.body.messages))
    expect(sent.some((s) => s.includes("never mind this"))).toBe(false)
    expect(texts((await t.history()).messages).join("|")).not.toContain("never mind")
  })

  test("a message that was not read when the turn ends starts the next turn", async () => {
    const t = await setup()
    const before = mock.requests.length
    await t.send("slow start")
    await until(async () => (await t.history()).working)
    await t.send("second request")
    await t.chat((c) => c.stop(t.flow.id))
    // The second turn asks the model with the unread message (the stand-in streams slowly again,
    // because it reads the joined user turns as one).
    await until(() =>
      mock.requests
        .slice(before + 1)
        .some((r) => JSON.stringify(r.body.messages).includes("second request")),
    )
    const h = await t.history()
    expect(h.messages.filter((m) => m.author === "assistant")).toHaveLength(2)
    expect(h.messages.map((m) => m.author)).toEqual(["user", "assistant", "user", "assistant"])
    await t.chat((c) => c.stop(t.flow.id))
    await t.idle()
  })

  test("wait in a queue: the message waits above the box and goes when the turn ends", async () => {
    const t = await setup()
    const before = mock.requests.length
    await t.run(SettingsStore.use((s) => s.update({ duringTurn: "queue" })))
    await t.send("slow start")
    await until(async () => (await t.history()).working)
    await t.send("queued one")
    const h = await t.history()
    expect(h.queue.map((q) => q.text)).toEqual(["queued one"])
    expect(h.messages.map((m) => chatText(m)).join("|")).not.toContain("queued one")
    await t.chat((c) => c.stop(t.flow.id))
    await until(() =>
      mock.requests
        .slice(before + 1)
        .some((r) => JSON.stringify(r.body.messages).includes("queued one")),
    )
    const x = await t.history()
    expect(x.queue).toEqual([])
    expect(x.messages.some((m) => chatText(m) === "queued one")).toBe(true)
    await t.chat((c) => c.stop(t.flow.id))
    await t.idle()
  })

  test("the queue holds at most 10 messages", async () => {
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ duringTurn: "queue" })))
    await t.send("slow start")
    await until(async () => (await t.history()).working)
    for (let i = 0; i < 10; i++) await t.send(`q${i}`)
    expect(await t.code(t.send("q10"))).toBe("queue_full")
    expect((await t.history()).queue).toHaveLength(10)
    await t.chat((c) => c.stop(t.flow.id))
  })

  test("a queued message can be taken back, and sent now into the turn that works", async () => {
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ duringTurn: "queue" })))
    await t.send("slow start")
    await until(async () => (await t.history()).working)
    const a = await t.send("remove me")
    const b = await t.send("send me now")
    expect((await t.chat((c) => c.deleteWaiting(a.id))).text).toBe("remove me")
    await t.chat((c) => c.sendNow(b.id))
    const h = await t.history()
    expect(h.queue).toEqual([])
    expect(h.messages.find((m) => m.id === b.id)?.pending).toBe(true)
    await t.chat((c) => c.stop(t.flow.id))
  })

  test("an attached file is copied into the folder of the workflow, with a unique name", async () => {
    const t = await setup()
    const dir = mkdtempSync(join(tmpdir(), "robot-attach-"))
    const file = join(dir, "notes.txt")
    writeFileSync(file, "hello")
    await t.send("see this", { files: [file] })
    await t.idle()
    const again = await t.send("and again", { files: [file] })
    await t.idle()
    expect(readFileSync(join(t.flow.folder, "attachments", "notes.txt"), "utf8")).toBe("hello")
    expect(readFileSync(join(t.flow.folder, "attachments", "notes 2.txt"), "utf8")).toBe("hello")
    expect(chatFiles(again)[0]?.path).toBe(join("attachments", "notes 2.txt"))
    expect(await t.code(t.send("gone", { files: [join(dir, "missing.txt")] }))).toBe(
      "file_unreadable",
    )
  })

  test("send is refused when the account was disconnected", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    const account = (await t.run(Providers.use((p) => p.list)))[0]
    await t.run(Providers.use((p) => p.disconnect(account?.id ?? "")))
    expect(await t.code(t.send("again"))).toBe("provider_not_connected")
  })

  test("a failed reply keeps the reason, and Retry asks again with the same conversation", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    // The provider failed in this reply: the row holds the reason, as a failed turn stores it.
    await t.sql(
      "UPDATE chat_message SET status = 'failed', error_code = 'provider_error', error_detail = 'boom', parts = '[]' WHERE author = 'assistant'",
    )
    const failed = (await t.history()).messages.at(-1)
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toEqual({ code: "provider_error", detail: "boom" })
    const before = mock.requests.length
    await t.chat((c) => c.retry(t.flow.id))
    await t.idle()
    const h = await t.history()
    expect(texts(h.messages)).toEqual(["user:hello:done", "assistant:You said: hello:done"])
    // One new request, with the user message and no failed reply in it.
    expect(mock.requests.length).toBe(before + 1)
    const sent = mock.requests.at(-1)?.body.messages.map((m) => m.role)
    expect(sent).toEqual(["system", "user"])
    // Retry on a reply that did not fail is refused.
    expect(await t.code(t.chat((c) => c.retry(t.flow.id)))).toBe("message_read")
  })

  test("a reply that was streaming at a restart is marked stopped and the notice shows", async () => {
    const dir = await import("node:fs").then((fs) =>
      fs.mkdtempSync(`${require("node:os").tmpdir()}/robot-chat-`),
    )
    const file = `${dir}/robot.db`
    const first = testRuntime({ databaseFile: file })
    const server = await first.runtime.runPromise(Servers.use((s) => s.local))
    await first.runtime.runPromise(
      Providers.use((p) =>
        p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
      ),
    )
    const flow = await first.runtime.runPromise(
      Workflows.use((w) => w.create({ serverId: server.id, name: "Restart" })),
    )
    await first.runtime.runPromise(
      Database.use((d) =>
        Effect.sync(() => {
          d.run(
            "INSERT INTO chat_message (id, workflow_id, author, parts, status, created_at) VALUES ('u1', ?, 'user', '[{\"kind\":\"text\",\"text\":\"do it\"}]', 'done', 1)",
            flow.id,
          )
          d.run(
            "INSERT INTO chat_message (id, workflow_id, author, parts, status, created_at) VALUES ('a1', ?, 'assistant', '[]', 'streaming', 2)",
            flow.id,
          )
        }),
      ),
    )
    await first.runtime.dispose()
    const second = testRuntime({ databaseFile: file })
    const h = await second.runtime.runPromise(Chat.use((c) => c.history(flow.id)))
    expect(h.messages.map((m) => m.status)).toEqual(["done", "stopped"])
    expect(h.notice).toEqual({ messageId: "a1", notSent: true })
    // "Send again" sends the same request again: the model answers it.
    await second.runtime.runPromise(
      Providers.use((p) =>
        p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
      ),
    )
    await second.runtime.runPromise(Chat.use((c) => c.resume(flow.id, "again")))
    await until(async () => {
      const x = await second.runtime.runPromise(Chat.use((c) => c.history(flow.id)))
      return !x.working && x.messages.at(-1)?.status === "done"
    })
    const x = await second.runtime.runPromise(Chat.use((c) => c.history(flow.id)))
    expect(texts(x.messages)).toEqual(["user:do it:done", "assistant:You said: do it:done"])
    expect(x.notice).toBeNull()
  })
})

describe("questions about a run and feedback (spec 003)", () => {
  const KEY = "sk-abcdefghijklmnopqrstuvwxyz123456"

  /** A workflow with a text node, a decision node and a text node, like the 4-node case of 003. */
  const withNodes = async () => {
    const t = await setup()
    for (const input of [
      { kind: "text" as const, name: "Fetch" },
      { kind: "text" as const, name: "Summarise" },
      { kind: "decision" as const, name: "Pick", options: ["yes", "no"] },
      { kind: "text" as const, name: "Send" },
    ])
      await t.run(Workflows.use((w) => w.addNode(t.flow.id, input)))
    return t
  }
  const seedRun = async (
    t: Awaited<ReturnType<typeof setup>>,
    id: string,
    state: string,
    finished: boolean,
    tasks: [number, string, string, string?, string?][],
  ) => {
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at, finished_at) VALUES (?, ?, ?, 'hand', ?, ?)",
      id,
      t.flow.id,
      state,
      Date.parse("2026-11-07T10:00:00Z"),
      finished ? Date.parse("2026-11-07T10:05:00Z") : null,
    )
    for (const [n, name, taskState, result, detail] of tasks)
      await t.sql(
        `INSERT INTO task (id, run_id, workflow_id, node_name, node_number, state, result, error_detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${id}-${n}`,
        id,
        t.flow.id,
        name,
        n,
        taskState,
        result ?? "",
        detail ?? null,
        n,
      )
  }
  const system = (before: number) =>
    JSON.stringify(mock.requests.slice(before)[0]?.body.messages[0])

  test('a workflow that never ran gets the rule for the answer "No run yet."', async () => {
    const t = await withNodes()
    const before = mock.requests.length
    await t.send("How far is the run?")
    await t.idle()
    const sys = system(before)
    expect(sys).toContain("This workflow has never run.")
    expect(sys).toContain("No run yet.")
  })

  test("the model gets the states, reasons and results of the run; a key is redacted; a long result is cut", async () => {
    const t = await withNodes()
    await seedRun(t, "run-a", "running", false, [
      [1, "Fetch", "done", `The key is ${KEY}. ${"long ".repeat(300)}`],
      [2, "Summarise", "running"],
    ])
    const before = mock.requests.length
    await t.send("How far is the run?")
    await t.idle()
    const sys = system(before)
    expect(sys).toContain('Node 1 \\"Fetch\\" (text): done')
    expect(sys).toContain('Node 2 \\"Summarise\\" (text): running')
    expect(sys).toContain('Node 3 \\"Pick\\" (decision): not reached')
    expect(sys).toContain('Node 4 \\"Send\\" (text): not reached')
    expect(sys).toContain("[redacted]")
    expect(sys).not.toContain(KEY)
    expect(sys).toContain("this is its first part only")
    expect(sys).not.toContain("run view")
    expect(sys).toContain("2026-11-07 10:00 UTC")
  })

  test("a failed node and a node that waits for an approval give their reasons", async () => {
    const t = await withNodes()
    await seedRun(t, "run-b", "waiting", false, [
      [1, "Fetch", "failed", "", "The app stopped"],
      [2, "Summarise", "waiting"],
    ])
    await t.sql(
      "UPDATE task SET error_code = 'approval', error_detail = 'run curl' WHERE id = 'run-b-2'",
    )
    const before = mock.requests.length
    await t.send("Why does it wait?")
    await t.idle()
    const sys = system(before)
    expect(sys).toContain("Reason: The app stopped")
    expect(sys).toContain(
      "Waits for your approval of the step: run curl. The approval card is in the chat.",
    )
  })

  test("feedback while a run works is added to the run, with the nodes that will get it", async () => {
    const t = await withNodes()
    await seedRun(t, "run-c", "running", false, [
      [1, "Fetch", "done", "result one"],
      [2, "Summarise", "done", "result two"],
    ])
    await t.send('tool add_run_feedback {"text":"Too long. Keep it to five lines.","node":2}')
    await t.idle()
    const stored = await t.rows<{ run_id: string; node_number: number; text: string }>(
      "SELECT run_id, node_number, text FROM run_feedback",
    )
    expect(stored).toEqual([
      { run_id: "run-c", node_number: 2, text: "Too long. Keep it to five lines." },
    ])
    const reply = (await t.history()).messages.at(-1)
    const note = reply?.parts.find((p) => p.kind === "note" && p.note === "feedback_added")
    // Node 3 is a decision node: it never gets feedback. Node 4 starts after the feedback.
    expect(note).toMatchObject({ runId: "run-c", nodes: [4] })
    // The graph and the prompts did not change.
    const graph = await t.run(Workflows.use((w) => w.graph(t.flow.id)))
    expect(graph.nodes.map((n) => n.prompt)).toEqual(["", "", "", ""])
    // The engine reads the feedback for a node that starts later.
    const notes = await t.run(RunFacts.use((f) => f.feedbackFor("run-c")))
    expect(notes).toEqual(["About node 2: Too long. Keep it to five lines."])
  })

  test("feedback when no text node starts after it says that no node will get it", async () => {
    const t = await withNodes()
    await seedRun(t, "run-d", "running", false, [
      [1, "Fetch", "done"],
      [2, "Summarise", "done"],
      [3, "Pick", "running"],
      [4, "Send", "running"],
    ])
    await t.send('tool add_run_feedback {"text":"All fine"}')
    await t.idle()
    const reply = (await t.history()).messages.at(-1)
    expect(reply?.parts.find((p) => p.kind === "note")).toMatchObject({ nodes: [] })
  })

  test("feedback is not added to a run that ended, or when no run works", async () => {
    const t = await withNodes()
    await seedRun(t, "run-e", "done", true, [[1, "Fetch", "done"]])
    await t.send('tool add_run_feedback {"text":"Too long"}')
    await t.idle()
    expect(await t.rows("SELECT * FROM run_feedback")).toEqual([])
    const reply = (await t.history()).messages.at(-1)
    expect(chatText(reply as WorkflowChatMessage)).toContain("no run works or waits")
    expect(reply?.parts.some((p) => p.kind === "note")).toBe(false)
  })

  test("with two runs that work, feedback that names no run is not added", async () => {
    const t = await withNodes()
    await seedRun(t, "run-f1", "running", false, [[1, "Fetch", "running"]])
    await seedRun(t, "run-f2", "running", false, [[1, "Fetch", "running"]])
    await t.send('tool add_run_feedback {"text":"Too long"}')
    await t.idle()
    expect(await t.rows("SELECT * FROM run_feedback")).toEqual([])
    expect(chatText((await t.history()).messages.at(-1) as WorkflowChatMessage)).toContain(
      "more than one run works",
    )
  })

  test("a chat message never changes the prompt of a node or the document", async () => {
    const t = await withNodes()
    const before = await t.run(Workflows.use((w) => w.get(t.flow.id)))
    await t.send("Change the prompt of node 1 to: be rude")
    await t.idle()
    const after = await t.run(Workflows.use((w) => w.get(t.flow.id)))
    expect(after.document).toBe(before.document)
    expect(after.graph).toEqual(before.graph)
  })
})

describe("the tools of the chat (spec 007, 003)", () => {
  const claudeTurns = () => fake.claudeCalls().filter((c) => "prompt" in c)

  test("an API account gets the tools of the chat and no others, in the folder of the workflow", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    const request = mock.requests.at(-1)
    expect(request?.body.tools?.map((x) => x.function.name)).toEqual(["add_run_feedback"])
    const h = await t.history()
    expect(h.answer).toMatchObject({ accountName: "Mock", model: "mock-fast", feedback: true })
    expect(JSON.stringify(request?.body.messages[0])).toContain("call the tool add_run_feedback")
  })

  test("a runtime account answers in text only: no tools, no shell, not in the folder", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = await setup({ connect: false })
    await t.run(Providers.use((p) => p.connect({ kind: "claude_code", name: "Claude" })))
    await t.send("hello")
    await t.idle()
    const reply = (await t.history()).messages.at(-1)
    expect(reply?.status).toBe("done")
    const turn = claudeTurns().at(-1) as { args: string[]; cwd: string; prompt: string }
    // The program starts with the empty list of tools, not the tools of the program.
    const at = turn.args.indexOf("--tools")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(turn.args[at + 1]).toBe("")
    expect(turn.args).not.toContain("--disallowedTools")
    expect(turn.args).not.toContain("--mcp-config")
    // The program runs outside the folder of the workflow.
    const { realpathSync } = await import("node:fs")
    expect(realpathSync(turn.cwd)).not.toContain(realpathSync(t.flow.folder))
    expect(turn.cwd).not.toBe(t.flow.folder)
    // It is also outside the data folder, which holds the database and the sign-ins.
    expect(realpathSync(turn.cwd).startsWith(realpathSync(t.dataDir))).toBe(false)
    expect(realpathSync(t.dataDir).startsWith(realpathSync(turn.cwd))).toBe(false)
    // The prompt does not claim a tool that the turn lacks.
    const system = turn.args[turn.args.indexOf("--append-system-prompt") + 1] ?? ""
    expect(system).toContain("You have no tools in this chat")
    expect(system).not.toContain("call the tool add_run_feedback")
    // The header says why feedback is not there.
    expect((await t.history()).answer).toMatchObject({ accountName: "Claude", feedback: false })
  })
})

describe("the model of the chat (spec 003; the choice is not decided, docs/spec-questions.md)", () => {
  const second = async (t: Awaited<ReturnType<typeof setup>>) =>
    t.run(
      Providers.use((p) =>
        p.connect({ kind: "openai", name: "Second", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
      ),
    )

  test("the header data names the account and the model, and the choice stays between turns", async () => {
    const t = await setup()
    expect((await t.history()).answer).toMatchObject({ accountName: "Mock", model: "mock-fast" })
    await t.send("one")
    await t.idle()
    // A node that names another account would win the first choice. The chat keeps its own.
    const other = await second(t)
    await t.run(
      Workflows.use((w) =>
        w.addNode(t.flow.id, {
          kind: "text",
          name: "A",
          accountId: other.id,
          model: "gpt-5",
        }),
      ),
    )
    await t.send("two")
    await t.idle()
    expect(mock.requests.at(-1)?.body.model).toBe("mock-fast")
    expect((await t.history()).answer).toMatchObject({ accountName: "Mock", model: "mock-fast" })
  })

  test("the user picks another account and model; an unknown model is refused", async () => {
    const t = await setup()
    await t.send("one")
    await t.idle()
    const other = await second(t)
    expect(await t.code(t.chat((c) => c.setModel(t.flow.id, other.id, "nope")))).toBe(
      "chat_model_unknown",
    )
    expect(await t.code(t.chat((c) => c.setModel(t.flow.id, "gone", "gpt-5")))).toBe(
      "provider_not_connected",
    )
    await t.chat((c) => c.setModel(t.flow.id, other.id, "gpt-5"))
    expect((await t.history()).answer).toMatchObject({ accountName: "Second", model: "gpt-5" })
    await t.send("two")
    await t.idle()
    expect(mock.requests.at(-1)?.body.model).toBe("gpt-5")
  })

  test("the choice changes when its account is gone", async () => {
    const t = await setup()
    await t.send("one")
    await t.idle()
    const other = await second(t)
    const first = (await t.run(Providers.use((p) => p.list))).find((a) => a.name === "Mock")
    await t.run(Providers.use((p) => p.disconnect(first?.id ?? "")))
    expect((await t.history()).answer).toMatchObject({ accountId: other.id })
    await t.send("two")
    await t.idle()
    expect(mock.requests.at(-1)?.body.model).toBe("mock-fast")
    expect(
      await t.rows<{ account_id: string }>("SELECT account_id FROM workflow_chat_model"),
    ).toEqual([{ account_id: other.id }])
  })

  test("a reload of the history does not look at a program again", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = await setup({ connect: false })
    await t.run(Providers.use((p) => p.connect({ kind: "claude_code", name: "Claude" })))
    await t.history()
    const asked = fake.asks("claude").length
    for (let i = 0; i < 5; i++) await t.history()
    expect(fake.asks("claude").length).toBe(asked)
  })
})

describe("a restart that cut a turn with a joined message (spec 003, Rules)", () => {
  const cut = async (reached: boolean) => {
    const dir = await import("node:fs").then((fs) =>
      fs.mkdtempSync(`${require("node:os").tmpdir()}/robot-chat-`),
    )
    const file = `${dir}/robot.db`
    const first = testRuntime({ databaseFile: file })
    const server = await first.runtime.runPromise(Servers.use((s) => s.local))
    await first.runtime.runPromise(
      Providers.use((p) =>
        p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
      ),
    )
    const flow = await first.runtime.runPromise(
      Workflows.use((w) => w.create({ serverId: server.id, name: "Restart" })),
    )
    const parts = reached ? '[{"kind":"text","text":"Working. "}]' : "[]"
    await first.runtime.runPromise(
      Database.use((d) =>
        Effect.sync(() => {
          d.run(
            "INSERT INTO chat_message (id, workflow_id, author, parts, status, created_at) VALUES ('u1', ?, 'user', '[{\"kind\":\"text\",\"text\":\"do it\"}]', 'done', 1)",
            flow.id,
          )
          d.run(
            "INSERT INTO chat_message (id, workflow_id, author, parts, status, created_at) VALUES ('a1', ?, 'assistant', ?, 'streaming', 2)",
            flow.id,
            parts,
          )
          d.run(
            "INSERT INTO chat_message (id, workflow_id, author, parts, status, joined_to, created_at) VALUES ('u2', ?, 'user', '[{\"kind\":\"text\",\"text\":\"use b.txt\"}]', 'done', 'a1', 3)",
            flow.id,
          )
        }),
      ),
    )
    await first.runtime.dispose()
    const second = testRuntime({ databaseFile: file })
    await second.runtime.runPromise(
      Providers.use((p) =>
        p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
      ),
    )
    const history = () => second.runtime.runPromise(Chat.use((c) => c.history(flow.id)))
    return { second, flow, history }
  }

  test("the notice shows with Continue when the model had read the request", async () => {
    const { second, flow, history } = await cut(true)
    const h = await history()
    expect(h.messages.map((m) => [m.author, m.status, m.pending])).toEqual([
      ["user", "done", false],
      ["assistant", "stopped", false],
      ["user", "done", false],
    ])
    expect(h.notice).toEqual({ messageId: "a1", notSent: false })
    await second.runtime.runPromise(Chat.use((c) => c.resume(flow.id, "continue")))
    await until(async () => {
      const x = await history()
      return !x.working && x.messages.at(-1)?.status === "done"
    })
    const x = await history()
    expect(x.notice).toBeNull()
    // The model read the joined message with the request to go on.
    const asked = JSON.stringify(mock.requests.at(-1)?.body.messages)
    expect(asked).toContain("use b.txt")
  })

  test("the notice shows with Send again when the request had not reached the model", async () => {
    const { second, flow, history } = await cut(false)
    expect((await history()).notice).toEqual({ messageId: "a1", notSent: true })
    await second.runtime.runPromise(Chat.use((c) => c.resume(flow.id, "again")))
    await until(async () => {
      const x = await history()
      return !x.working && x.messages.at(-1)?.status === "done"
    })
    const x = await history()
    expect(x.notice).toBeNull()
    expect(JSON.stringify(mock.requests.at(-1)?.body.messages)).toContain("use b.txt")
  })
})

describe("who can add feedback today (spec 003, 010; the guard is W6)", () => {
  test("feedback reaches a run only from a message in the chat, through the tool of the chat", async () => {
    const t = await setup()
    await t.run(Workflows.use((w) => w.addNode(t.flow.id, { kind: "text", name: "Fetch" })))
    await t.run(Workflows.use((w) => w.addNode(t.flow.id, { kind: "text", name: "Send" })))
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', 1)",
      t.flow.id,
    )
    await t.sql(
      "INSERT INTO task (id, run_id, workflow_id, node_name, node_number, state, result, created_at) VALUES ('t1', 'r1', ?, 'Fetch', 1, 'done', 'x', 1)",
      t.flow.id,
    )
    // No method of the app takes feedback except the chat: no rpc handler, no method of the chat.
    const { handlers } = await import("../rpc.ts")
    expect(Object.keys(handlers).filter((k) => /feedback/i.test(k))).toEqual([])
    const methods = await t.run(Chat.use((c) => Effect.succeed(Object.keys(c))))
    expect(methods.filter((k) => /feedback/i.test(k))).toEqual([])
    // Today the text is whatever the model wrote in the call. No check compares it with the
    // words of the user, and no check looks at outside content. W6 owns both.
    await t.send('tool add_run_feedback {"text":"Words that the user did not write","node":1}')
    await t.idle()
    const stored = await t.rows<{ text: string }>("SELECT text FROM run_feedback")
    expect(stored).toEqual([{ text: "Words that the user did not write" }])
  })
})

describe("a program that cannot be locked to text only (spec 007, 003)", () => {
  const codexTurns = () => fake.codexCalls().filter((c) => Array.isArray(c.args))
  const connectCodex = (t: Awaited<ReturnType<typeof setup>>) => {
    fake.setCodex({ loggedIn: true, method: "chatgpt" })
    return t.run(Providers.use((p) => p.connect({ kind: "codex", name: "Codex" })))
  }

  test("with only such an account connected, the chat is blocked with the reason and sends nothing", async () => {
    const t = await setup({ connect: false })
    await connectCodex(t)
    const h = await t.history()
    expect(h.block).toBe("no_provider")
    expect(h.answer).toBeNull()
    expect(h.unsafeAccount).toBe("Codex")
    const turns = codexTurns().length
    expect(await t.code(t.send("hello"))).toBe("provider_not_connected")
    expect(codexTurns().length).toBe(turns)
    expect((await t.history()).messages).toEqual([])
  })

  test("the account is not listed for the chat and cannot be picked", async () => {
    const t = await setup()
    await connectCodex(t)
    const listed = await runRequest(t.runtime, "models.available", {}, null)
    expect(listed.ok).toBe(true)
    const choices = (listed as { value: { accountName: string; chatSafe?: boolean }[] }).value
    // The list marks the account, and the picker of the chat leaves it out.
    expect(choices.map((c) => [c.accountName, c.chatSafe])).toEqual([
      ["Mock", true],
      ["Codex", false],
    ])
    const codex = (await t.run(Providers.use((p) => p.list))).find((a) => a.name === "Codex")
    expect(await t.code(t.chat((c) => c.setModel(t.flow.id, codex?.id ?? "", "default")))).toBe(
      "chat_account_unsafe",
    )
    const h = await t.history()
    expect(h.answer).toMatchObject({ accountName: "Mock" })
    await t.send("hello")
    await t.idle()
    expect(codexTurns().length).toBe(0)
    expect(mock.requests.at(-1)?.body.model).toBe("mock-fast")
  })

  test("a stored choice of such an account is replaced, with the reason, and a read stores nothing", async () => {
    const t = await setup()
    const codex = await connectCodex(t)
    await t.sql(
      "INSERT INTO workflow_chat_model (workflow_id, account_id, model, effort) VALUES (?, ?, 'default', NULL)",
      t.flow.id,
      codex.id,
    )
    const h = await t.history()
    expect(h.answer).toMatchObject({ accountName: "Mock" })
    expect(h.unsafeAccount).toBe("Codex")
    // The history only computes: the stored row is as it was.
    expect(
      await t.rows<{ account_id: string }>("SELECT account_id FROM workflow_chat_model"),
    ).toEqual([{ account_id: codex.id }])
    await t.send("hello")
    await t.idle()
    expect(codexTurns().length).toBe(0)
    const stored = await t.rows<{ account_id: string }>(
      "SELECT account_id FROM workflow_chat_model",
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]?.account_id).not.toBe(codex.id)
    // The reason is shown once: the next read has none.
    expect((await t.history()).unsafeAccount).toBeNull()
  })

  test("reading the history does not write the choice", async () => {
    const t = await setup()
    await t.history()
    await t.history()
    expect(await t.rows("SELECT 1 FROM workflow_chat_model")).toEqual([])
    await t.send("hello")
    await t.idle()
    expect(await t.rows("SELECT 1 FROM workflow_chat_model")).toHaveLength(1)
  })
})
