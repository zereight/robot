import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chatText, type WorkflowChatMessage } from "@robot/shared"
import { Effect } from "effect"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

// Edit of the last message, "Mark as unread" and the unread count (spec 003, "Message rows" and
// "Mark as unread"). The spec states no rule for an edit after a step ran: the rules here fail
// closed (docs/spec-questions.md, rows for B4).

let mock: MockProvider
beforeAll(async () => {
  mock = await startMockProvider()
})
afterAll(async () => {
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

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  await run(
    Providers.use((p) =>
      p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
    ),
  )
  const flow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Report" })))
  const chat = <A>(f: (c: Chat["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Chat.use(f))
  const send = (text: string) => chat((c) => c.send({ workflowId: flow.id, text }))
  const history = () => chat((c) => c.history(flow.id))
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const idle = async () => until(async () => !(await history()).working)
  const code = async (f: Promise<unknown>) => {
    try {
      await f
      return "ok"
    } catch (e) {
      return (e as { code?: string }).code ?? String(e)
    }
  }
  /** A stored message, as a finished turn leaves it. `at` orders it. */
  const put = (id: string, author: "user" | "assistant", parts: unknown[], at: number) =>
    sql(
      "INSERT INTO chat_message (id, workflow_id, author, parts, status, created_at) VALUES (?, ?, ?, ?, 'done', ?)",
      id,
      flow.id,
      author,
      JSON.stringify(parts),
      at,
    )
  const text = (value: string) => ({ kind: "text", text: value })
  return { ...t, run, flow, chat, send, history, sql, idle, code, put, text }
}

const words = (messages: readonly WorkflowChatMessage[]) =>
  messages.map((m) => `${m.author}:${chatText(m)}:${m.status}`)

describe("edit of the last message (spec 003)", () => {
  test("the new text replaces the old one, the replies go, and the model answers the new text", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    const first = await t.history()
    expect(first.editableId).toBe(first.messages[0]?.id ?? "")
    const before = mock.requests.length
    await t.chat((c) => c.edit(first.messages[0]?.id ?? "", "  hi again  "))
    await t.idle()
    const h = await t.history()
    expect(words(h.messages)).toEqual(["user:hi again:done", "assistant:You said: hi again:done"])
    // The same message: its id stays, and the model never gets the old text.
    expect(h.messages[0]?.id).toBe(first.messages[0]?.id ?? "")
    const sent = mock.requests.slice(before).map((r) => JSON.stringify(r.body.messages))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("hi again")
    expect(sent[0]).not.toContain("hello")
  })

  test("only the last message of the user can be edited, and the answer must be there", async () => {
    const t = await setup()
    await t.send("one")
    await t.idle()
    await t.send("two")
    await t.idle()
    const h = await t.history()
    const [one, , two] = h.messages
    expect(h.editableId).toBe(two?.id ?? "")
    expect(await t.code(t.chat((c) => c.edit(one?.id ?? "", "x")))).toBe("edit_not_last")
    // The reply is not a message of the user.
    expect(await t.code(t.chat((c) => c.edit(h.messages[1]?.id ?? "", "x")))).toBe("edit_not_last")
    // A message that no reply follows (an answer to a question card) is not edited.
    await t.put("u3", "user", [t.text("three")], Date.now() + 1000)
    expect((await t.history()).editableId).toBeNull()
    expect(await t.code(t.chat((c) => c.edit("u3", "x")))).toBe("edit_not_last")
    expect(await t.code(t.chat((c) => c.edit("none", "x")))).toBe("edit_not_last")
    expect(words((await t.history()).messages).slice(0, 4)).toEqual([
      "user:one:done",
      "assistant:You said: one:done",
      "user:two:done",
      "assistant:You said: two:done",
    ])
  })

  test("no edit while a turn works", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    const id = (await t.history()).messages[0]?.id ?? ""
    await t.send("slow start")
    await until(async () => (await t.history()).working)
    expect((await t.history()).editableId).toBeNull()
    // Neither the old message nor the new one can change while the turn works.
    expect(await t.code(t.chat((c) => c.edit(id, "x")))).toBe("edit_working")
    await t.chat((c) => c.stop(t.flow.id))
    await t.idle()
  })

  test("after a step ran in a later reply, edit is refused and nothing changes", async () => {
    const t = await setup()
    await t.put("u1", "user", [t.text("add a node")], 1)
    await t.put(
      "a1",
      "assistant",
      [
        {
          kind: "tool",
          id: "c1",
          name: "add_node",
          label: "add_node",
          state: "done",
          input: "{}",
          output: "ok",
        },
        t.text("Done."),
      ],
      2,
    )
    const h = await t.history()
    expect(h.editableId).toBeNull()
    expect(await t.code(t.chat((c) => c.edit("u1", "add two nodes")))).toBe("edit_steps_ran")
    expect(words((await t.history()).messages)).toEqual([
      "user:add a node:done",
      "assistant:Done.:done",
    ])
  })

  test("a step that did not happen does not block the edit", async () => {
    const t = await setup()
    await t.put("u1", "user", [t.text("remove node 9")], 1)
    await t.put(
      "a1",
      "assistant",
      [
        {
          kind: "tool",
          id: "c1",
          name: "remove_node",
          label: "remove_node",
          state: "done",
          notRun: true,
          input: "{}",
          output: "refused",
        },
        t.text("I could not."),
      ],
      2,
    )
    expect((await t.history()).editableId).toBe("u1")
    await t.chat((c) => c.edit("u1", "remove node 2"))
    await t.idle()
    expect(words((await t.history()).messages)).toEqual([
      "user:remove node 2:done",
      "assistant:You said: remove node 2:done",
    ])
  })

  test("a run that the chat started after the message blocks the edit", async () => {
    const t = await setup()
    await t.put("u1", "user", [t.text("start it")], 1000)
    await t.put("a1", "assistant", [t.text("Started.")], 1001)
    expect((await t.history()).editableId).toBe("u1")
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'done', 'chat', 1500)",
      t.flow.id,
    )
    expect((await t.history()).editableId).toBeNull()
    expect(await t.code(t.chat((c) => c.edit("u1", "x")))).toBe("edit_steps_ran")
    // A run that the user started by hand, or an older run of the chat, does not block it.
    await t.sql("UPDATE run SET source = 'hand' WHERE id = 'r1'")
    expect((await t.history()).editableId).toBe("u1")
    await t.sql("UPDATE run SET source = 'chat', started_at = 500 WHERE id = 'r1'")
    expect((await t.history()).editableId).toBe("u1")
  })

  test("feedback and a proposal in a reply block the edit too", async () => {
    const t = await setup()
    await t.put("u1", "user", [t.text("node 2 is too long")], 1)
    await t.put(
      "a1",
      "assistant",
      [
        {
          kind: "note",
          note: "feedback_added",
          runId: "r",
          startedAt: 1,
          nodes: [3],
        },
      ],
      2,
    )
    expect((await t.history()).editableId).toBeNull()
  })

  test("an empty text is refused when nothing else is in the message; a file stays", async () => {
    const t = await setup()
    await t.put("u1", "user", [t.text("look")], 1)
    await t.put("a1", "assistant", [t.text("Seen.")], 2)
    expect(await t.code(t.chat((c) => c.edit("u1", "   ")))).toBe("message_empty")
    await t.put(
      "u2",
      "user",
      [t.text("and this"), { kind: "file", name: "a.txt", path: "attachments/a.txt", size: 1 }],
      3,
    )
    await t.put("a2", "assistant", [t.text("Seen too.")], 4)
    await t.chat((c) => c.edit("u2", "and that"))
    await t.idle()
    const m = (await t.history()).messages.find((x) => x.id === "u2")
    expect(m?.parts.map((p) => p.kind)).toEqual(["text", "file"])
    expect(m ? chatText(m) : "").toBe("and that")
  })

  test("with no provider connected, edit is refused before anything changes", async () => {
    const t = await setup()
    await t.put("u1", "user", [t.text("hi")], 1)
    await t.put("a1", "assistant", [t.text("Hello.")], 2)
    const account = (await t.run(Providers.use((p) => p.list)))[0]
    await t.run(Providers.use((p) => p.disconnect(account?.id ?? "")))
    expect(await t.code(t.chat((c) => c.edit("u1", "hi there")))).toBe("provider_not_connected")
    expect(words((await t.history()).messages)).toEqual(["user:hi:done", "assistant:Hello.:done"])
  })

  test("a message that a linked device sent is not edited here", async () => {
    const t = await setup()
    await t.put("u1", "user", [t.text("from the phone")], 1)
    await t.put("a1", "assistant", [t.text("Hi.")], 2)
    await t.sql("UPDATE chat_message SET actor_id = 'phone', actor_name = 'Phone' WHERE id = 'u1'")
    expect((await t.history()).editableId).toBeNull()
    expect(await t.code(t.chat((c) => c.edit("u1", "x")))).toBe("edit_not_last")
  })
})

describe("Mark as unread (spec 003)", () => {
  /** Eight messages. The messages 2, 4, 5, 7 and 8 are replies, as the acceptance line says. */
  const eight = async () => {
    const t = await setup()
    const author = [
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ] as const
    for (const [i, a] of author.entries())
      await t.put(`m${i + 1}`, a, [t.text(`message ${i + 1}`)], i + 1)
    return t
  }

  test("marking message 5 shows the count 3 and the first unread reply", async () => {
    const t = await eight()
    expect((await t.history()).unread).toEqual({ count: 0, firstId: null })
    await t.chat((c) => c.markUnread("m5"))
    expect((await t.history()).unread).toEqual({ count: 3, firstId: "m5" })
    // Marking an earlier reply moves the place.
    await t.chat((c) => c.markUnread("m2"))
    expect((await t.history()).unread).toEqual({ count: 5, firstId: "m2" })
  })

  test("the count follows the marked place and grows with new replies, then read clears it", async () => {
    const t = await eight()
    await t.chat((c) => c.markUnread("m7"))
    expect((await t.history()).unread.count).toBe(2)
    await t.put("m9", "assistant", [t.text("message 9")], 9)
    expect((await t.history()).unread).toEqual({ count: 3, firstId: "m7" })
    await t.chat((c) => c.read(t.flow.id))
    expect((await t.history()).unread).toEqual({ count: 0, firstId: null })
    // Read twice is harmless.
    await t.chat((c) => c.read(t.flow.id))
  })

  test("only a finished reply can be marked", async () => {
    const t = await eight()
    expect(await t.code(t.chat((c) => c.markUnread("m1")))).toBe("mark_not_reply")
    expect(await t.code(t.chat((c) => c.markUnread("none")))).toBe("mark_not_reply")
    await t.sql("UPDATE chat_message SET status = 'streaming' WHERE id = 'm8'")
    expect(await t.code(t.chat((c) => c.markUnread("m8")))).toBe("mark_not_reply")
    await t.sql("UPDATE chat_message SET status = 'failed' WHERE id = 'm8'")
    expect(await t.code(t.chat((c) => c.markUnread("m8")))).toBe("mark_not_reply")
    expect((await t.history()).unread.count).toBe(0)
  })

  test("the mark is stored for the workflow", async () => {
    const t = await eight()
    await t.chat((c) => c.markUnread("m5"))
    const rows = await t.run(
      Database.use((d) =>
        Effect.sync(() => d.all<{ message_id: string }>("SELECT message_id FROM chat_unread")),
      ),
    )
    expect(rows).toEqual([{ message_id: "m5" }])
  })

  test("when an edit removes the marked reply, the new reply takes its place", async () => {
    const t = await setup()
    await t.send("hello")
    await t.idle()
    const [user, reply] = (await t.history()).messages
    await t.chat((c) => c.markUnread(reply?.id ?? ""))
    expect((await t.history()).unread).toEqual({ count: 1, firstId: reply?.id ?? "" })
    await t.chat((c) => c.edit(user?.id ?? "", "hello again"))
    await t.idle()
    const h = await t.history()
    const fresh = h.messages[1]
    expect(fresh?.id).not.toBe(reply?.id ?? "")
    expect(h.unread).toEqual({ count: 1, firstId: fresh?.id ?? "" })
  })
})
