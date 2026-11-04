import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  handoverOf,
  type MessagePart,
  messageText,
  NO_MARKS,
  THREAD_MAX,
  userWords,
} from "@robot/shared"
import { Effect, Exit } from "effect"
import { unzipSync } from "fflate"
import { appLayer } from "../layers.ts"
import { runRequest } from "../rpc.ts"
import { AgentFiles } from "./AgentFiles.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Handover } from "./Handover.ts"
import { PlaceMarks } from "./PlaceMarks.ts"
import { Providers } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { managedRuntime, testPlatform, testRuntime } from "./testing.ts"

// A stand-in provider. It keeps the messages of every request, so a test can read what the model
// of the new agent got. A message that ends with "slow" streams for about one second.
const requests: { messages: { role: string; content: string }[] }[] = []

const sse = (chunks: unknown[], delay = 0) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks) {
          if (delay) await Bun.sleep(delay)
          controller.enqueue(
            enc.encode(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`),
          )
        }
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
const delta = (content: string) => ({ choices: [{ delta: { content } }] })

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    requests.push({ messages: body.messages })
    const last = body.messages.at(-1)?.content ?? ""
    if (last.endsWith("slow"))
      return sse([...Array.from({ length: 40 }, (_, i) => delta(`w${i} `)), "[DONE]"], 25)
    return sse([delta(`Echo: ${last.split("\n").at(-1)}`), "[DONE]"])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const KEY = "sk-handover-0123456789abcdef"

const setup = async (names: readonly string[] = ["Ada", "Ben"]) => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-handover-account",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agents = []
  for (const name of names)
    agents.push(
      await run(
        Agents.use((a) =>
          a.create({
            serverId: local.id,
            name,
            role: `${name} does the work`,
            instructions: "Be brief.",
            model: { accountId: account.id, model: "mock", effort: null },
          }),
        ),
      ),
    )
  const [ada, ben] = agents as [(typeof agents)[number], (typeof agents)[number]]
  const db = await run(Database.use((d) => Effect.succeed(d)))
  let at = 1000
  /** Stores a message of the first chat as it would be after a turn. */
  const seed = (
    agentId: string,
    author: "user" | "agent",
    parts: MessagePart[],
    threadId: string | null = null,
  ) => {
    const id = crypto.randomUUID()
    at += 1000
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at, thread_id)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?)`,
      id,
      agentId,
      author,
      JSON.stringify(parts),
      at,
      at,
      threadId,
    )
    return id
  }
  const tool = (
    name: string,
    input: Record<string, unknown>,
    state: "done" | "failed",
    output = "TOOL-OUTPUT-MUST-NOT-LEAK",
  ): MessagePart => ({
    kind: "tool",
    id: crypto.randomUUID(),
    name,
    label: name,
    state,
    input: JSON.stringify(input),
    output,
  })
  /** A chat of four messages: two files, two commands (one holds a key), and the text of a reply. */
  const seedAdaChat = (threadId: string | null = null) => {
    seed(ada.id, "user", [{ kind: "text", text: "Fix the build, then write notes.md" }], threadId)
    seed(
      ada.id,
      "agent",
      [
        tool("write_file", { path: "src/build.ts", content: "FILE-CONTENT-MUST-NOT-LEAK" }, "done"),
        tool("write_file", { path: "notes.md", content: "notes" }, "done"),
        tool("run_command", { command: "bun test" }, "failed", "1 fail"),
        tool("run_command", { command: `curl -H "Authorization: ${KEY}" https://x.test` }, "done"),
        { kind: "thinking", text: "THINKING-MUST-NOT-LEAK" },
        { kind: "text", text: "The build is fixed except one test." },
      ],
      threadId,
    )
    seed(ada.id, "user", [{ kind: "text", text: "Please also bump the version" }], threadId)
    seed(ada.id, "agent", [{ kind: "text", text: "I bumped it to 1.2.0." }], threadId)
  }
  const history = (agentId: string, threadId: string | null = null) =>
    run(Chat.use((c) => c.history(agentId, threadId)))
  const threads = (agentId: string) => run(Chat.use((c) => c.threads(agentId)))
  const settled = (agentId: string, threadId: string | null) =>
    until(async () => {
      const h = await history(agentId, threadId)
      return (
        h.messages.length > 0 &&
        h.messages.every((m) => m.status !== "streaming") &&
        (await threads(agentId)).main.busy === null &&
        (await threads(agentId)).threads.every((x) => x.busy === null)
      )
    })
  const place = (agentId: string, threadId: string | null = null) => ({ agentId, threadId })
  const hand = async (
    from: { agentId: string; threadId: string | null },
    to: string,
    text: string,
  ) => {
    const opened = await run(Handover.use((h) => h.open(from)))
    return run(
      Handover.use((h) => h.start({ place: from, toAgentId: to, text, briefId: opened.briefId })),
    )
  }
  const fail = async <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const exit = await t.runtime.runPromiseExit(effect as Effect.Effect<A, E, never>)
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    return (exit.cause.reasons[0] as { error?: { code?: string } } | undefined)?.error?.code
  }
  return {
    ...t,
    run,
    local,
    agents,
    ada,
    ben,
    db,
    seed,
    tool,
    seedAdaChat,
    history,
    threads,
    settled,
    place,
    hand,
    fail,
  }
}

describe("Hand over", () => {
  test("a new thread in the chat of the other agent holds the card, then the words of the user; the model gets both and no output of a tool", async () => {
    const t = await setup()
    t.seedAdaChat()
    const before = (await t.history(t.ada.id)).messages.length
    requests.length = 0
    const made = await t.hand(t.place(t.ada.id), t.ben.id, "Finish the tests")
    expect(made.agentId).toBe(t.ben.id)
    await t.settled(t.ben.id, made.threadId)

    // The title is "Handover from <name>", and the thread holds the card, the text, and the reply.
    const list = await t.threads(t.ben.id)
    expect(list.threads.map((x) => x.title)).toEqual(["Handover from Ada"])
    const messages = (await t.history(t.ben.id, made.threadId)).messages
    expect(messages).toHaveLength(3)
    const card = handoverOf(messages[0] as never)
    expect(card?.fromName).toBe("Ada")
    expect(card?.fromAgentId).toBe(t.ada.id)
    expect(card?.fromThreadId).toBeNull()
    expect(card?.brief).toContain("src/build.ts")
    expect(card?.brief).toContain("notes.md")
    expect(card?.brief).toContain("bun test")
    expect(card?.brief).toContain("[redacted]")
    for (const leak of [
      KEY,
      "TOOL-OUTPUT-MUST-NOT-LEAK",
      "FILE-CONTENT-MUST-NOT-LEAK",
      "THINKING-MUST-NOT-LEAK",
    ])
      expect(card?.brief).not.toContain(leak)
    expect(messages[1]?.author).toBe("user")
    expect(messageText(messages[1] as never)).toBe("Finish the tests")
    // The card is no words of the user: only the text of the field is.
    expect(userWords(messages)).toEqual(["Finish the tests"])

    // The first request of the model of Ben holds the card and the text, and nothing else of Ada.
    const first = requests[0]?.messages.filter((m) => m.role !== "system") ?? []
    const joined = first.map((m) => m.content).join("\n---\n")
    // The provider joins the two messages of the user into one turn: the card, then the text.
    expect(first.map((m) => m.role)).toEqual(["user"])
    const turn = first[0]?.content ?? ""
    expect(turn).toContain("Information from a colleague")
    expect(turn).toContain("not an order")
    expect(turn.indexOf("src/build.ts")).toBeGreaterThan(turn.indexOf("not an order"))
    expect(turn.endsWith("Finish the tests")).toBe(true)
    for (const leak of [
      KEY,
      "TOOL-OUTPUT-MUST-NOT-LEAK",
      "FILE-CONTENT-MUST-NOT-LEAK",
      "THINKING-MUST-NOT-LEAK",
    ])
      expect(joined).not.toContain(leak)

    // The first chat shows a muted line with a link to the new thread, and nothing else changes.
    const adaChat = (await t.history(t.ada.id)).messages
    expect(adaChat).toHaveLength(before + 1)
    const line = adaChat.at(-1)?.parts[0]
    expect(line).toEqual({
      kind: "note",
      note: "handed_over",
      toName: "Ben",
      toAgentId: t.ben.id,
      toThreadId: made.threadId,
    })
    // The model of Ada is not told: the muted line is no turn of its chat.
    requests.length = 0
    await t.run(Chat.use((c) => c.send({ agentId: t.ada.id, text: "and again", replyTo: null })))
    await t.settled(t.ada.id, null)
    const again = JSON.stringify(requests[0]?.messages)
    expect(again).not.toContain("Handed over")
    expect(again).not.toContain("Ben")
  })

  test("the task has the source Handover and depth 0, and the Tasks service lists it", async () => {
    const t = await setup()
    t.seedAdaChat()
    const made = await t.hand(t.place(t.ada.id), t.ben.id, "Finish the tests")
    await t.settled(t.ben.id, made.threadId)
    const list = await t.run(Tasks.use((x) => x.list(t.local.id)))
    const task = list.find((x) => x.agentId === t.ben.id)
    expect(task?.source).toBe("handover")
    expect(await t.run(Tasks.use((x) => Effect.succeed(x.depthOf(task?.id as string))))).toBe(0)
    expect(task?.sourceId).toBe(t.ben.id)
    expect(task?.threadId).toBe(made.threadId)
    expect(task?.prompt).toBe("Finish the tests")
    // The turn was a task of the user: the times count from the message.
    expect(task?.askedAt).not.toBeNull()
  })

  test("it works for a thread, and the card links back to that thread", async () => {
    const t = await setup()
    const thread = await t.run(Chat.use((c) => c.createThread(t.ada.id)))
    t.seedAdaChat(thread.id)
    const made = await t.hand(t.place(t.ada.id, thread.id), t.ben.id, "Go on")
    await t.settled(t.ben.id, made.threadId)
    const card = handoverOf((await t.history(t.ben.id, made.threadId)).messages[0] as never)
    expect(card?.fromThreadId).toBe(thread.id)
    const line = (await t.history(t.ada.id, thread.id)).messages.at(-1)?.parts[0]
    expect(line).toMatchObject({ note: "handed_over", toThreadId: made.threadId })
    // The main thread of the first agent has no line.
    expect((await t.history(t.ada.id)).messages).toHaveLength(0)
  })

  test("a thread title is cut at 60 characters, and the user can rename it", async () => {
    const t = await setup(["A".repeat(40), "Ben"])
    t.seed(t.agents[0]?.id as string, "user", [{ kind: "text", text: "hi" }])
    const made = await t.hand(t.place(t.agents[0]?.id as string), t.ben.id, "Go")
    const title = (await t.threads(t.ben.id)).threads[0]?.title ?? ""
    expect(title).toBe("Handover from AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 60))
    expect(title.length).toBeLessThanOrEqual(60)
    await t.settled(t.ben.id, made.threadId)
    await t.run(Chat.use((c) => c.renameThread(t.ben.id, made.threadId, "Plans")))
    expect((await t.threads(t.ben.id)).threads[0]?.title).toBe("Plans")
  })

  test("it is off, with the reason, with no message of the user, while a turn runs, and with no other agent", async () => {
    const t = await setup()
    const state = (agentId: string, threadId: string | null = null) =>
      t.run(Handover.use((h) => h.state(t.place(agentId, threadId))))
    // No message of the user.
    expect((await state(t.ada.id)).off).toBe("noMessage")
    expect(await t.fail(Handover.use((h) => h.open(t.place(t.ada.id))))).toBe("handover_no_message")
    // A chat that holds only a handover card is no chat with a message of the user.
    // A message of the user: it is on.
    t.seed(t.ada.id, "user", [{ kind: "text", text: "hello" }])
    expect((await state(t.ada.id)).off).toBeNull()
    // A turn runs in this chat: it is off. A turn of another thread of the same agent does not
    // switch it off for this one when this one is idle.
    await t.run(Chat.use((c) => c.send({ agentId: t.ada.id, text: "go slow", replyTo: null })))
    await until(async () => (await t.threads(t.ada.id)).main.busy === "turn")
    expect((await state(t.ada.id)).off).toBe("running")
    expect(
      await t.fail(
        Handover.use((h) =>
          h.start({
            place: t.place(t.ada.id),
            toAgentId: t.ben.id,
            text: "x",
            briefId: "none",
          }),
        ),
      ),
    ).toBe("handover_brief_gone")
    await t.settled(t.ada.id, null)
    expect((await state(t.ada.id)).off).toBeNull()
    // No other agent that is not archived.
    await t.run(Agents.use((a) => a.archive(t.ben.id)))
    expect((await state(t.ada.id)).off).toBe("noAgent")
    expect(await t.fail(Handover.use((h) => h.open(t.place(t.ada.id))))).toBe("handover_no_agent")
  })

  test("the start refuses a turn that began after the dialog opened, and leaves nothing behind", async () => {
    const t = await setup()
    t.seed(t.ada.id, "user", [{ kind: "text", text: "hello" }])
    const opened = await t.run(Handover.use((h) => h.open(t.place(t.ada.id))))
    await t.run(Chat.use((c) => c.send({ agentId: t.ada.id, text: "go slow", replyTo: null })))
    await until(async () => (await t.threads(t.ada.id)).main.busy === "turn")
    expect(
      await t.fail(
        Handover.use((h) =>
          h.start({
            place: t.place(t.ada.id),
            toAgentId: t.ben.id,
            text: "Go",
            briefId: opened.briefId,
          }),
        ),
      ),
    ).toBe("handover_running")
    expect((await t.threads(t.ben.id)).threads).toEqual([])
    await t.settled(t.ada.id, null)
  })

  test("the field needs 1 to 2000 characters, another agent, and an agent that is not archived", async () => {
    const t = await setup()
    t.seed(t.ada.id, "user", [{ kind: "text", text: "hello" }])
    const opened = await t.run(Handover.use((h) => h.open(t.place(t.ada.id))))
    const start = (toAgentId: string, text: string) =>
      Handover.use((h) =>
        h.start({ place: t.place(t.ada.id), toAgentId, text, briefId: opened.briefId }),
      )
    expect(await t.fail(start(t.ben.id, "   "))).toBe("invalid_input")
    expect(await t.fail(start(t.ben.id, "x".repeat(2001)))).toBe("invalid_input")
    expect(await t.fail(start(t.ada.id, "Go"))).toBe("handover_same_agent")
    await t.run(Agents.use((a) => a.archive(t.ben.id)))
    expect(await t.fail(start(t.ben.id, "Go"))).toBe("agent_not_found")
    // The same dialog still works for an agent that is there.
    const third = await setupThird(t)
    const made = await t.run(start(third, "x".repeat(2000)))
    await t.settled(third, made.threadId)
    expect(messageText((await t.history(third, made.threadId)).messages[1] as never)).toBe(
      "x".repeat(2000),
    )
  })

  test("an agent that has 50 threads is off in the list, and a handover to it is refused with nothing made", async () => {
    const t = await setup()
    t.seed(t.ada.id, "user", [{ kind: "text", text: "hello" }])
    for (let i = 0; i < THREAD_MAX - 1; i++) await t.run(Chat.use((c) => c.createThread(t.ben.id)))
    const opened = await t.run(Handover.use((h) => h.open(t.place(t.ada.id))))
    expect(opened.candidates).toEqual([{ agentId: t.ben.id, full: true }])
    const before = (await t.history(t.ada.id)).messages.length
    expect(
      await t.fail(
        Handover.use((h) =>
          h.start({
            place: t.place(t.ada.id),
            toAgentId: t.ben.id,
            text: "Go",
            briefId: opened.briefId,
          }),
        ),
      ),
    ).toBe("thread_limit")
    expect((await t.threads(t.ben.id)).threads).toHaveLength(THREAD_MAX - 1)
    expect((await t.history(t.ada.id)).messages).toHaveLength(before)
  })

  test("the brief the dialog showed is the text the card stores", async () => {
    const t = await setup()
    t.seedAdaChat()
    const opened = await t.run(Handover.use((h) => h.open(t.place(t.ada.id))))
    expect(opened.brief).toContain("Ada")
    expect(opened.brief).toContain("Folder of Ada:")
    expect(opened.brief).toContain(t.ada.workspace)
    // A new message after the dialog opened does not change the stored brief.
    t.seed(t.ada.id, "agent", [{ kind: "text", text: "LATE-REPLY" }])
    const made = await t.run(
      Handover.use((h) =>
        h.start({
          place: t.place(t.ada.id),
          toAgentId: t.ben.id,
          text: "Go",
          briefId: opened.briefId,
        }),
      ),
    )
    const card = handoverOf((await t.history(t.ben.id, made.threadId)).messages[0] as never)
    expect(card?.brief).toBe(opened.brief)
    expect(card?.brief).not.toContain("LATE-REPLY")
    // A brief is used once.
    expect(
      await t.fail(
        Handover.use((h) =>
          h.start({
            place: t.place(t.ada.id),
            toAgentId: t.ben.id,
            text: "Go",
            briefId: opened.briefId,
          }),
        ),
      ),
    ).toBe("handover_brief_gone")
    await t.settled(t.ben.id, made.threadId)
  })

  test("the task waits when the new agent works in another thread, like any message in a thread", async () => {
    const t = await setup()
    t.seed(t.ada.id, "user", [{ kind: "text", text: "hello" }])
    await t.run(Chat.use((c) => c.send({ agentId: t.ben.id, text: "go slow", replyTo: null })))
    await until(async () => (await t.threads(t.ben.id)).main.busy === "turn")
    const made = await t.hand(t.place(t.ada.id), t.ben.id, "Finish the tests")
    // The new thread waits behind the turn in the main thread.
    await until(
      async () =>
        (await t.threads(t.ben.id)).threads.find((x) => x.id === made.threadId)?.busy === "queued",
    )
    const queued = (await t.threads(t.ben.id)).threads[0]?.queued
    expect(queued?.behind).toEqual({ kind: "thread" })
    await t.settled(t.ben.id, null)
    await t.settled(t.ben.id, made.threadId)
    expect((await t.history(t.ben.id, made.threadId)).messages.map((m) => m.author)).toEqual([
      "user",
      "user",
      "agent",
    ])
  })

  test("only the window of this computer reaches Hand over: a linked device gets not allowed", async () => {
    const t = await setup()
    t.seed(t.ada.id, "user", [{ kind: "text", text: "hello" }])
    const actor = { id: "phone", name: "Phone" }
    for (const method of ["chat.handover.state", "chat.handover.open", "chat.handover.start"]) {
      const refused = await runRequest(t.runtime, method, { agentId: t.ada.id }, actor)
      expect(refused).toEqual({ ok: false, error: { code: "not_allowed", message: "Not allowed" } })
    }
    const own = await runRequest(t.runtime, "chat.handover.state", { agentId: t.ada.id })
    expect(own).toEqual({ ok: true, value: { off: null } })
  })

  test("a linked device sees the muted line in a main thread and no other thread", async () => {
    const t = await setup()
    t.seed(t.ada.id, "user", [{ kind: "text", text: "hello" }])
    const made = await t.hand(t.place(t.ada.id), t.ben.id, "Go")
    await t.settled(t.ben.id, made.threadId)
    const actor = { id: "phone", name: "Phone" }
    const main = await runRequest(t.runtime, "chat.history", { agentId: t.ada.id }, actor)
    expect(main.ok).toBe(true)
    const parts = (
      main as { value: { messages: { parts: MessagePart[] }[] } }
    ).value.messages.flatMap((m) => m.parts)
    expect(parts.some((p) => p.kind === "note" && p.note === "handed_over")).toBe(true)
    const thread = await runRequest(
      t.runtime,
      "chat.history",
      { agentId: t.ben.id, threadId: made.threadId },
      actor,
    )
    expect(thread).toEqual({ ok: false, error: { code: "not_allowed", message: "Not allowed" } })
    const ben = await runRequest(t.runtime, "chat.history", { agentId: t.ben.id }, actor)
    expect((ben as { value: { messages: unknown[] } }).value.messages).toEqual([])
  })

  test("deleting the new thread leaves the muted line; deleting the first thread leaves the card", async () => {
    const t = await setup()
    const first = await t.run(Chat.use((c) => c.createThread(t.ada.id)))
    t.seedAdaChat(first.id)
    const made = await t.hand(t.place(t.ada.id, first.id), t.ben.id, "Go")
    await t.settled(t.ben.id, made.threadId)
    // The first thread goes. The card stays, with the name and the ids as text.
    await t.run(Chat.use((c) => c.deleteThread(t.ada.id, first.id)))
    const card = handoverOf((await t.history(t.ben.id, made.threadId)).messages[0] as never)
    expect(card?.fromName).toBe("Ada")
    expect((await t.threads(t.ada.id)).threads).toEqual([])
    // Now the other way.
    const second = await t.run(Chat.use((c) => c.createThread(t.ada.id)))
    t.seed(t.ada.id, "user", [{ kind: "text", text: "again" }], second.id)
    const again = await t.hand(t.place(t.ada.id, second.id), t.ben.id, "Go")
    await t.settled(t.ben.id, again.threadId)
    await t.run(Chat.use((c) => c.deleteThread(t.ben.id, again.threadId)))
    const line = (await t.history(t.ada.id, second.id)).messages.at(-1)?.parts[0]
    expect(line).toMatchObject({ note: "handed_over", toName: "Ben", toThreadId: again.threadId })
  })

  test("a second handover from the same chat takes the last reply of the agent, not the muted line", async () => {
    const t = await setup()
    t.seedAdaChat()
    const one = await t.hand(t.place(t.ada.id), t.ben.id, "First")
    await t.settled(t.ben.id, one.threadId)
    const opened = await t.run(Handover.use((h) => h.open(t.place(t.ada.id))))
    expect(opened.brief).toContain("I bumped it to 1.2.0.")
    expect(opened.brief).toContain("Last reply of Ada")
  })
})

/** A third agent for a test that archives the second one. */
const setupThird = async (t: Awaited<ReturnType<typeof setup>>) => {
  const account = await t.run(Providers.use((p) => p.list))
  const third = await t.run(
    Agents.use((a) =>
      a.create({
        serverId: t.local.id,
        name: "Cleo",
        role: "",
        instructions: "",
        model: { accountId: account[0]?.id as string, model: "mock", effort: null },
      }),
    ),
  )
  return third.id
}

describe("the marks of a handover", () => {
  test("the new thread holds the marks of the first place at the time of Hand over, and the other threads do not", async () => {
    const t = await setup()
    t.seedAdaChat()
    await t.run(
      PlaceMarks.use((m) =>
        Effect.sync(() => m.holdSensitive({ kind: "agent", id: t.ada.id }, "keys")),
      ),
    )
    const made = await t.hand(t.place(t.ada.id), t.ben.id, "Go")
    await t.settled(t.ben.id, made.threadId)
    const marks = (id: string) =>
      t.run(PlaceMarks.use((m) => Effect.succeed(m.get({ kind: "thread", id }))))
    expect(await marks(made.threadId)).toEqual({ outside: null, sensitive: "keys" })
    // The main thread of Ben and a thread that Ben starts later hold none.
    expect(
      await t.run(PlaceMarks.use((m) => Effect.succeed(m.get({ kind: "agent", id: t.ben.id })))),
    ).toEqual(NO_MARKS)
    const other = await t.run(Chat.use((c) => c.createThread(t.ben.id)))
    expect(await marks(other.id)).toEqual(NO_MARKS)
    // The list of threads shows the marks, for the header line of the new thread.
    const listed = (await t.threads(t.ben.id)).threads
    expect(listed.find((x) => x.id === made.threadId)?.marks).toEqual({
      outside: null,
      sensitive: "keys",
    })
    expect(listed.find((x) => x.id === other.id)?.marks).toEqual(NO_MARKS)
    // Clear works on the thread and only on the thread.
    const cleared = await runRequest(t.runtime, "placeMarks.clear", {
      place: { kind: "thread", id: made.threadId },
    })
    expect(cleared).toEqual({ ok: true, value: { outside: null, sensitive: "keys" } })
    expect(await marks(made.threadId)).toEqual(NO_MARKS)
    expect(
      (await t.run(PlaceMarks.use((m) => Effect.succeed(m.get({ kind: "agent", id: t.ada.id })))))
        .sensitive,
    ).toBe("keys")
  })

  test("the marks of the place are copied at the time of the press: a mark set later does not follow", async () => {
    const t = await setup()
    t.seedAdaChat()
    const made = await t.hand(t.place(t.ada.id), t.ben.id, "Go")
    await t.settled(t.ben.id, made.threadId)
    await t.run(
      PlaceMarks.use((m) =>
        Effect.sync(() => m.holdSensitive({ kind: "agent", id: t.ada.id }, "cloud")),
      ),
    )
    expect(
      await t.run(
        PlaceMarks.use((m) => Effect.succeed(m.get({ kind: "thread", id: made.threadId }))),
      ),
    ).toEqual(NO_MARKS)
  })

  test("a thread of a place that holds a mark hands it on from the thread, not from the agent", async () => {
    const t = await setup()
    const thread = await t.run(Chat.use((c) => c.createThread(t.ada.id)))
    t.seedAdaChat(thread.id)
    await t.run(
      PlaceMarks.use((m) =>
        Effect.sync(() => m.holdSensitive({ kind: "thread", id: thread.id }, "browser")),
      ),
    )
    const made = await t.hand(t.place(t.ada.id, thread.id), t.ben.id, "Go")
    await t.settled(t.ben.id, made.threadId)
    expect(
      await t.run(
        PlaceMarks.use((m) => Effect.succeed(m.get({ kind: "thread", id: made.threadId }))),
      ),
    ).toEqual({ outside: null, sensitive: "browser" })
    // The agent Ada itself holds none.
    expect(
      await t.run(PlaceMarks.use((m) => Effect.succeed(m.get({ kind: "agent", id: t.ada.id })))),
    ).toEqual(NO_MARKS)
  })

  test("a fork keeps what the conversation it copied held", async () => {
    const t = await setup()
    const thread = await t.run(Chat.use((c) => c.createThread(t.ada.id)))
    t.seedAdaChat(thread.id)
    await t.run(
      PlaceMarks.use((m) =>
        Effect.sync(() => m.holdSensitive({ kind: "thread", id: thread.id }, "keys")),
      ),
    )
    const messages = (await t.history(t.ada.id, thread.id)).messages
    const forked = await t.run(
      Chat.use((c) => c.fork(t.place(t.ada.id, thread.id), messages[1]?.id as string)),
    )
    expect(forked.marks).toEqual({ outside: null, sensitive: "keys" })
    // A new thread starts with no mark.
    const fresh = await t.run(Chat.use((c) => c.createThread(t.ada.id)))
    expect(fresh.marks).toEqual(NO_MARKS)
  })
})

/** An app on an empty database, with the answers of the file pickers that a test sets. */
const makeApp = (pick: { save?: string; open?: string; agentFile?: string } = {}) => {
  const p = testPlatform()
  const runtime = managedRuntime(
    appLayer({
      platform: {
        ...p.platform,
        pickSavePath: async () => pick.save,
        pickArchive: async () => pick.open,
        pickAgentFileSave: async () => pick.agentFile,
      },
      databaseFile: ":memory:",
      localServerName: "Test computer",
      emit: () => {},
      secrets: Secrets.memory,
    }),
  )
  return { run: runtime.runPromise, dataDir: p.dataDir }
}

describe("export and agent files", () => {
  test("an export holds the new thread, the card, the message and the lines, with the marks; an import brings them back", async () => {
    const out = join(testPlatform().dataDir, "handover-export.zip")
    const a = makeApp({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    const ada = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const ben = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ben", role: "", instructions: "", model: null }),
      ),
    )
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at)
       VALUES ('m1', ?, 'user', ?, 'done', 1, 1)`,
      ada.id,
      JSON.stringify([{ kind: "text", text: "Fix the build" }]),
    )
    // The thread, the card, the words of the user, and the muted line, as a handover stores them.
    db.run(
      `INSERT INTO thread (id, agent_id, title, titled, created_at, sensitive_mark, updated_at)
       VALUES ('th1', ?, 'Handover from Ada', 1, 2, 'keys', 2)`,
      ben.id,
    )
    const brief = `Handover from Ada\n\nA key: ${KEY}`
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at, thread_id)
       VALUES ('c1', ?, 'user', ?, 'done', 3, 3, 'th1'), ('c2', ?, 'user', ?, 'done', 4, 4, 'th1'), ('c3', ?, 'agent', ?, 'done', 5, NULL, NULL)`,
      ben.id,
      JSON.stringify([
        { kind: "handover", brief, fromName: "Ada", fromAgentId: ada.id, fromThreadId: null },
      ]),
      ben.id,
      JSON.stringify([{ kind: "text", text: "Finish the tests" }]),
      ada.id,
      JSON.stringify([
        { kind: "note", note: "handed_over", toName: "Ben", toAgentId: ben.id, toThreadId: "th1" },
      ]),
    )
    await a.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(out))
    for (const data of Object.values(entries)) expect(Buffer.from(data).includes(KEY)).toBe(false)
    const archived = join(a.dataDir, "archived.db")
    writeFileSync(archived, entries["robot.db"] as Uint8Array)
    const inArchive = new DatabaseSync(archived)
    expect(inArchive.prepare("SELECT title, sensitive_mark FROM thread").all()).toEqual([
      { title: "Handover from Ada", sensitive_mark: "keys" },
    ])
    expect(
      String(
        (inArchive.prepare("SELECT parts FROM message WHERE id = 'c1'").get() as { parts: string })
          .parts,
      ),
    ).toContain("[redacted]")
    inArchive.close()

    const b = makeApp({ open: out })
    const imported = await b.run(Data.use((d) => d.import()))
    expect(imported?.agents).toBe(2)
    expect(imported?.messages).toBe(4)
    const bDb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(bDb.all("SELECT id, thread_id FROM message ORDER BY id")).toEqual([
      { id: "c1", thread_id: "th1" },
      { id: "c2", thread_id: "th1" },
      { id: "c3", thread_id: null },
      { id: "m1", thread_id: null },
    ])
    const back = await b.run(
      PlaceMarks.use((m) => Effect.succeed(m.get({ kind: "thread", id: "th1" }))),
    )
    expect(back).toEqual({ outside: null, sensitive: "keys" })
    const text =
      bDb.get<{ parts: string }>("SELECT parts FROM message WHERE id = 'c1'")?.parts ?? ""
    expect(text).toContain("[redacted]")
    expect(text).not.toContain(KEY)
  })

  test("an agent file holds none of the handover", async () => {
    const file = join(testPlatform().dataDir, "ben.agents.json")
    const a = makeApp({ agentFile: file })
    const local = await a.run(Servers.use((s) => s.local))
    const ada = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const ben = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ben", role: "", instructions: "", model: null }),
      ),
    )
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    db.run(
      `INSERT INTO thread (id, agent_id, title, titled, created_at, updated_at)
       VALUES ('th1', ?, 'Handover from Ada', 1, 2, 2)`,
      ben.id,
    )
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at, thread_id)
       VALUES ('c1', ?, 'user', ?, 'done', 3, 3, 'th1'), ('c2', ?, 'user', ?, 'done', 4, 4, 'th1')`,
      ben.id,
      JSON.stringify([
        {
          kind: "handover",
          brief: "A BRIEF ONLY IN THE CHAT",
          fromName: "Ada",
          fromAgentId: ada.id,
          fromThreadId: null,
        },
      ]),
      ben.id,
      JSON.stringify([{ kind: "text", text: "A UNIQUE WORD FOR THE HANDOVER" }]),
    )
    const written = await a.run(
      AgentFiles.use((f) => f.export({ serverId: local.id, agentIds: [ada.id, ben.id] })),
    )
    expect(written.path).toBe(file)
    const text = readFileSync(file, "utf8")
    expect(text).toContain("Ben")
    for (const word of [
      "A BRIEF ONLY IN THE CHAT",
      "A UNIQUE WORD FOR THE HANDOVER",
      "Handover from Ada",
    ])
      expect(text).not.toContain(word)
  })
})
