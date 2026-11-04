import { afterAll, describe, expect, test } from "bun:test"
import { COMPACT_PAUSE_TURNS, type MessagePart, messageText, THREAD_MAX } from "@robot/shared"
import { Effect, Exit } from "effect"
import { runRequest } from "../rpc.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Places } from "./Places.ts"
import { Providers } from "./Providers.ts"
import { Search } from "./Search.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { testRuntime } from "./testing.ts"

/** The requests that reached the model: the messages of each, and if it asked for a summary. */
const requests: { summary: boolean; messages: { role: string; content: string }[] }[] = []
/** The summary call fails while this is true. */
let summaryFails = false

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
const usage = (prompt: number, completion: number) => ({
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
})

// A model with a context of 1000 tokens. A message that ends with "big" reports 900 tokens of use
// (90 percent). "slow" streams for about one second.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [
          { id: "mock", context_length: 1000 },
          { id: "mock-large", context_length: 1_000_000 },
        ],
      })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const summary = body.messages.some(
      (m) => m.role === "system" && m.content.startsWith("You write the summary"),
    )
    requests.push({ summary, messages: body.messages })
    if (summary) {
      if (summaryFails) return Response.json({ error: { message: "boom" } }, { status: 400 })
      const n = body.messages.filter((m) => m.role !== "system").length
      return sse([delta(`SUMMARY of ${n}`), usage(30, 7), "[DONE]"])
    }
    const last = body.messages.at(-1)?.content ?? ""
    if (last.endsWith("slow"))
      return sse([...Array.from({ length: 40 }, (_, i) => delta(`w${i} `)), "[DONE]"], 25)
    // "use=N" at the end reports a use of N tokens.
    const use = /use=(\d+)$/.exec(last)?.[1]
    return sse([
      delta(`Echo: ${last.split("\n").at(-1)}`),
      use ? usage(Number(use) - 10, 10) : last.endsWith("big") ? usage(890, 10) : usage(12, 5),
      "[DONE]",
    ])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const setup = async (model = "mock") => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-threads",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: { accountId: account.id, model, effort: null },
      }),
    ),
  )
  const history = (threadId: string | null = null) =>
    run(Chat.use((c) => c.history(agent.id, threadId)))
  const send = (text: string, threadId: string | null = null) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null, threadId })))
  const settled = (threadId: string | null = null) =>
    until(async () => {
      const h = await history(threadId)
      return (
        h.messages.length > 0 &&
        h.messages.every((m) => m.status !== "streaming") &&
        h.queue.length === 0 &&
        !(await run(Chat.use((c) => c.meter({ agentId: agent.id, threadId })))).compacting &&
        (await run(Chat.use((c) => c.threads(agent.id)))).main.busy === null
      )
    })
  /** Sends and waits for the end of the turn. */
  const turn = async (text: string, threadId: string | null = null) => {
    await send(text, threadId)
    await settled(threadId)
  }
  const fail = async <A, E>(effect: Effect.Effect<A, E, Chat>) => {
    const exit = await t.runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    return (exit.cause.reasons[0] as { error?: { code?: string } } | undefined)?.error?.code
  }
  const meter = (threadId: string | null = null) =>
    run(Chat.use((c) => c.meter({ agentId: agent.id, threadId })))
  const compactRows = async (threadId: string | null = null) =>
    (await history(threadId)).messages.flatMap((m) =>
      m.parts.filter(
        (p): p is Extract<MessagePart, { kind: "compacted" }> => p.kind === "compacted",
      ),
    )
  return {
    ...t,
    run,
    agent,
    local,
    history,
    send,
    settled,
    turn,
    fail,
    meter,
    compactRows,
  }
}

describe("Threads", () => {
  test("a thread has its own history and unread count; its title is the first line of its first message", async () => {
    const t = await setup()
    await t.turn("hello main")
    const thread = await t.run(Chat.use((c) => c.createThread(t.agent.id)))
    expect(thread.title).toBeNull()
    const long = "x".repeat(80)
    await t.turn(`\n${long}\nsecond line`, thread.id)
    const list = await t.run(Chat.use((c) => c.threads(t.agent.id)))
    expect(list.threads.map((x) => x.title)).toEqual(["x".repeat(60)])
    expect(list.threads[0]?.unread).toBe(1)
    expect(list.main.unread).toBe(1)
    // The model of the thread reads the thread only.
    expect(requests.at(-1)?.messages.some((m) => m.content.includes("hello main"))).toBe(false)
    expect((await t.history()).messages).toHaveLength(2)
    expect((await t.history(thread.id)).messages.every((m) => m.threadId === thread.id)).toBe(true)
    // The place counts the replies of all threads. Each thread is read on its own.
    const unread = async () => (await t.run(Places.use((p) => p.list(t.local.id))))[1]?.places[0]
    expect((await unread())?.unread).toBe(2)
    await t.run(Chat.use((c) => c.markRead(t.agent.id, thread.id)))
    expect((await t.run(Chat.use((c) => c.threads(t.agent.id)))).threads[0]?.unread).toBe(0)
    expect((await unread())?.unread).toBe(1)
    // A rename keeps 60 characters at most. The first message no longer changes the title.
    await t.run(Chat.use((c) => c.renameThread(t.agent.id, thread.id, "Plans")))
    await t.turn("other words", thread.id)
    expect((await t.run(Chat.use((c) => c.threads(t.agent.id)))).threads[0]?.title).toBe("Plans")
  })

  test("an agent has at most 50 threads, the main thread included", async () => {
    const t = await setup()
    for (let i = 0; i < THREAD_MAX - 1; i++)
      await t.run(Chat.use((c) => c.createThread(t.agent.id)))
    expect(await t.fail(Chat.use((c) => c.createThread(t.agent.id)))).toBe("thread_limit")
  })

  test("work from another agent goes to the main thread; an archived thread takes no message", async () => {
    const t = await setup()
    const thread = await t.run(Chat.use((c) => c.createThread(t.agent.id)))
    await t.run(
      Chat.use((c) =>
        c.send(
          { agentId: t.agent.id, text: "from a routine", replyTo: null, threadId: thread.id },
          { source: "routine", sourceId: "r1" },
        ),
      ),
    )
    await t.settled()
    expect((await t.history()).messages.map((m) => m.threadId)).toEqual([null, null])
    expect((await t.history(thread.id)).messages).toHaveLength(0)
    await t.run(Chat.use((c) => c.archiveThread(t.agent.id, thread.id, true)))
    expect(
      await t.fail(
        Chat.use((c) =>
          c.send({ agentId: t.agent.id, text: "hi", replyTo: null, threadId: thread.id }),
        ),
      ),
    ).toBe("thread_archived")
    await t.run(Chat.use((c) => c.archiveThread(t.agent.id, thread.id, false)))
    await t.turn("hi", thread.id)
  })

  test("a thread with a running turn cannot be archived or deleted; delete removes its messages", async () => {
    const t = await setup()
    const thread = await t.run(Chat.use((c) => c.createThread(t.agent.id)))
    await t.send("go slow", thread.id)
    await until(
      async () => (await t.run(Chat.use((c) => c.threads(t.agent.id)))).threads[0]?.busy === "turn",
    )
    expect(await t.fail(Chat.use((c) => c.archiveThread(t.agent.id, thread.id, true)))).toBe(
      "thread_busy",
    )
    expect(await t.fail(Chat.use((c) => c.deleteThread(t.agent.id, thread.id)))).toBe("thread_busy")
    await t.settled(thread.id)
    await until(
      async () => (await t.run(Chat.use((c) => c.threads(t.agent.id)))).threads[0]?.busy === null,
    )
    await t.run(Chat.use((c) => c.deleteThread(t.agent.id, thread.id)))
    expect((await t.run(Chat.use((c) => c.threads(t.agent.id)))).threads).toHaveLength(0)
    const left = await t.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message WHERE thread_id = ?", thread.id),
        ),
      ),
    )
    expect(left?.n).toBe(0)
    // The main thread is no thread to delete.
    expect(await t.fail(Chat.use((c) => c.deleteThread(t.agent.id, t.agent.id)))).toBe(
      "thread_not_found",
    )
  })

  test("fork at the third message of eight: the fork has three, the original eight", async () => {
    const t = await setup()
    for (const text of ["one", "two", "three", "four"]) await t.turn(text)
    const original = (await t.history()).messages
    expect(original).toHaveLength(8)
    const third = original[2]
    const fork = await t.run(
      Chat.use((c) => c.fork({ agentId: t.agent.id, threadId: null }, third?.id ?? "")),
    )
    expect(fork.title).toBe("two")
    expect(fork.fork).toEqual({ threadId: null, messageId: third?.id ?? "" })
    const copied = (await t.history(fork.id)).messages
    expect(copied.map((m) => messageText(m))).toEqual(
      original.slice(0, 3).map((m) => messageText(m)),
    )
    expect(copied.every((m) => !original.some((o) => o.id === m.id))).toBe(true)
    expect((await t.history()).messages).toHaveLength(8)
    // The copies are no news.
    expect((await t.run(Chat.use((c) => c.threads(t.agent.id)))).threads[0]?.unread).toBe(0)
    // The agent reads the copy with the first message of the fork.
    await t.turn("five", fork.id)
    const asked =
      requests
        .at(-1)
        ?.messages.map((m) => m.content)
        .join("|") ?? ""
    expect(asked).toContain("one")
    expect(asked).toContain("two")
    expect(asked).not.toContain("three")
    expect(
      await t.fail(Chat.use((c) => c.fork({ agentId: t.agent.id, threadId: null }, "nope"))),
    ).toBe("message_not_found")
  })

  test("fork at a message of a running turn is refused", async () => {
    const t = await setup()
    await t.send("go slow")
    await until(async () => (await t.history()).messages.length === 2)
    const [question, reply] = (await t.history()).messages
    for (const m of [question, reply])
      expect(
        await t.fail(Chat.use((c) => c.fork({ agentId: t.agent.id, threadId: null }, m?.id ?? ""))),
      ).toBe("fork_running")
    await t.settled()
  })
})

describe("Compact", () => {
  test("Compact is off for 2 turns or fewer, and keeps the newest 2 turns word for word", async () => {
    const t = await setup()
    await t.turn("alpha")
    await t.turn("beta")
    expect((await t.meter()).off).toBe("too_short")
    expect(await t.fail(Chat.use((c) => c.compact({ agentId: t.agent.id, threadId: null })))).toBe(
      "compact_too_short",
    )
    await t.turn("gamma")
    const before = await t.meter()
    expect(before).toEqual({ used: 17, size: 1000, off: null, compacting: false })
    await t.run(Chat.use((c) => c.compact({ agentId: t.agent.id, threadId: null })))
    const summary = requests.at(-1)
    expect(summary?.summary).toBe(true)
    // The summary covers the first turn only.
    expect(summary?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(await t.compactRows()).toEqual([
      expect.objectContaining({ summary: "SUMMARY of 3", auto: false }),
    ])
    // The chat keeps every row. The line shows before the first kept turn.
    const rows = (await t.history()).messages
    expect(rows.map((m) => (m.parts[0]?.kind === "compacted" ? "C" : messageText(m)))).toEqual([
      "alpha",
      "Echo: alpha",
      "C",
      "beta",
      "Echo: beta",
      "gamma",
      "Echo: gamma",
    ])
    // Right after a compact the use is not known.
    expect((await t.meter()).used).toBeNull()
    // The model gets one summary in place of everything older.
    await t.turn("delta")
    const next = requests.at(-1)?.messages.filter((m) => m.role !== "system") ?? []
    expect(next[0]?.content).toContain("SUMMARY of 3")
    expect(next.map((m) => m.content).join("|")).not.toContain("alpha")
    expect(next.map((m) => m.content).join("|")).toContain("beta")
    expect((await t.meter()).used).toBe(17)
  })

  test("a later compact summarises the earlier summary; a fork after the line copies the summary", async () => {
    const t = await setup()
    for (const text of ["a1", "a2", "a3"]) await t.turn(text)
    await t.run(Chat.use((c) => c.compact({ agentId: t.agent.id, threadId: null })))
    await t.turn("a4")
    await t.run(Chat.use((c) => c.compact({ agentId: t.agent.id, threadId: null })))
    const second = requests.at(-1)?.messages ?? []
    expect(second[1]?.content).toContain("SUMMARY of 3")
    const last = (await t.history()).messages.at(-1)
    const fork = await t.run(
      Chat.use((c) => c.fork({ agentId: t.agent.id, threadId: null }, last?.id ?? "")),
    )
    expect((await t.compactRows(fork.id)).map((c) => c.summary)).toEqual(["SUMMARY of 3"])
    await t.turn("a5", fork.id)
    expect(requests.at(-1)?.messages[1]?.content).toContain("SUMMARY of 3")
  })

  test("a message sent during a manual compact waits, and goes when the compact ends", async () => {
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ duringTurn: "join" })))
    for (const text of ["b1", "b2", "b3"]) await t.turn(text)
    const running = t.runtime.runPromise(
      Chat.use((c) => c.compact({ agentId: t.agent.id, threadId: null })),
    )
    await until(async () => (await t.meter()).compacting)
    expect((await t.meter()).off).toBe("agent_working")
    expect((await t.send("b4")).queued).toBe(true)
    await running
    await t.settled()
    const texts = (await t.history()).messages.map((m) => messageText(m))
    expect(texts.slice(-2)).toEqual(["b4", "Echo: b4"])
  })

  test("a compact that fails changes nothing", async () => {
    const t = await setup()
    for (const text of ["c1", "c2", "c3"]) await t.turn(text)
    summaryFails = true
    try {
      expect(
        await t.fail(Chat.use((c) => c.compact({ agentId: t.agent.id, threadId: null }))),
      ).toBeDefined()
    } finally {
      summaryFails = false
    }
    expect(await t.compactRows()).toEqual([])
    expect((await t.meter()).compacting).toBe(false)
  })

  test("a compact of one thread leaves the other threads as they are", async () => {
    const t = await setup()
    const thread = await t.run(Chat.use((c) => c.createThread(t.agent.id)))
    for (const text of ["d1", "d2", "d3"]) await t.turn(text, thread.id)
    await t.turn("main one")
    await t.run(Chat.use((c) => c.compact({ agentId: t.agent.id, threadId: thread.id })))
    expect(await t.compactRows(thread.id)).toHaveLength(1)
    expect(await t.compactRows()).toHaveLength(0)
  })
})

describe("Automatic compact", () => {
  const pause = (t: Awaited<ReturnType<typeof setup>>) =>
    t.run(
      Database.use((db) =>
        Effect.sync(
          () =>
            db.get<{ turns: number }>(
              "SELECT turns FROM compact_pause WHERE agent_id = ?",
              t.agent.id,
            )?.turns ?? 0,
        ),
      ),
    )

  test("at 85 percent or more, the app compacts first and then the turn goes on", async () => {
    const t = await setup()
    await t.turn("e1")
    await t.turn("e2")
    await t.turn("e3 big")
    expect((await t.meter()).used).toBe(900)
    await t.turn("e4")
    const rows = await t.compactRows()
    expect(rows).toEqual([expect.objectContaining({ auto: true })])
    // The open turn is one of the 2 kept turns.
    const [summary, reply] = requests.slice(-2)
    expect(summary?.summary).toBe(true)
    expect(summary?.messages.map((m) => m.content).join("|")).toContain("e2")
    expect(summary?.messages.map((m) => m.content).join("|")).not.toContain("e3 big")
    expect(reply?.messages[1]?.content).toContain("SUMMARY of")
    expect(messageText((await t.history()).messages.at(-1) as never)).toBe("Echo: e4")
    // The tokens of the summary count for the agent.
    const tokens = await t.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.get<{ n: number }>(
            "SELECT SUM(input_tokens + output_tokens) AS n FROM message WHERE parts LIKE '%compacted%'",
          ),
        ),
      ),
    )
    expect(tokens?.n).toBe(37)
  })

  test("at 400000 tokens or more of a large context, whichever comes first", async () => {
    const t = await setup("mock-large")
    await t.turn("k1")
    await t.turn("k2")
    await t.turn("k3 use=399999")
    expect((await t.meter()).used).toBe(399_999)
    await t.turn("k4 use=400000")
    expect(await t.compactRows()).toEqual([])
    expect((await t.meter()).used).toBe(400_000)
    await t.turn("k5")
    expect(await t.compactRows()).toEqual([expect.objectContaining({ auto: true })])
    // The setting turns this rule off too.
    const off = await setup("mock-large")
    await off.run(SettingsStore.use((s) => s.update({ autoCompact: false })))
    for (const text of ["m1", "m2", "m3 use=500000", "m4"]) await off.turn(text)
    expect(await off.compactRows()).toEqual([])
  })

  test("a first reply after a compact at 400000 tokens or more starts the pause too", async () => {
    const t = await setup("mock-large")
    for (const text of ["n1", "n2", "n3 use=400000"]) await t.turn(text)
    await t.turn("n4 use=450000")
    expect(await t.compactRows()).toHaveLength(1)
    expect(await pause(t)).toBe(COMPACT_PAUSE_TURNS)
  })

  test("off by the setting, and never for 2 turns or fewer", async () => {
    const t = await setup()
    await t.turn("f1 big")
    await t.turn("f2")
    expect(await t.compactRows()).toEqual([])
    await t.run(SettingsStore.use((s) => s.update({ autoCompact: false })))
    await t.turn("f3 big")
    await t.turn("f4")
    expect(await t.compactRows()).toEqual([])
  })

  test("a failed compact: the turn goes on with a muted line, and the app waits 5 turns", async () => {
    const t = await setup()
    for (const text of ["g1", "g2", "g3 big"]) await t.turn(text)
    summaryFails = true
    try {
      await t.turn("g4 big")
      const reply = (await t.history()).messages.at(-1)
      expect(reply?.parts.find((p) => p.kind === "note")).toEqual(
        expect.objectContaining({ note: "compact_failed" }),
      )
      expect(messageText(reply as never)).toBe("Echo: g4 big")
      expect(await pause(t)).toBe(COMPACT_PAUSE_TURNS)
      const asked = () => requests.filter((r) => r.summary).length
      const tries = asked()
      for (let i = 0; i < COMPACT_PAUSE_TURNS; i++) await t.turn(`h${i} big`)
      expect(asked()).toBe(tries)
      expect(await pause(t)).toBe(0)
    } finally {
      summaryFails = false
    }
    await t.turn("i1")
    expect(await t.compactRows()).toHaveLength(1)
  })

  test("a first reply after a compact at 85 percent or more starts the pause of 5 turns", async () => {
    const t = await setup()
    for (const text of ["j1", "j2", "j3 big"]) await t.turn(text)
    await t.turn("j4 big")
    expect(await t.compactRows()).toHaveLength(1)
    expect(await pause(t)).toBe(COMPACT_PAUSE_TURNS)
    await t.turn("j5 big")
    expect(await t.compactRows()).toHaveLength(1)
    expect(await pause(t)).toBe(COMPACT_PAUSE_TURNS - 1)
  })
})

describe("Linked devices and search", () => {
  test("a linked device gets the main thread only", async () => {
    const t = await setup()
    const thread = await t.run(Chat.use((c) => c.createThread(t.agent.id)))
    await t.turn("needle in main")
    await t.turn("needle in thread", thread.id)
    const actor = { id: "phone", name: "Phone" }
    const refused = await runRequest(
      t.runtime,
      "chat.history",
      { agentId: t.agent.id, threadId: thread.id },
      actor,
    )
    expect(refused).toEqual({ ok: false, error: { code: "not_allowed", message: "Not allowed" } })
    const own = await runRequest(t.runtime, "chat.history", { agentId: t.agent.id }, actor)
    expect(own.ok).toBe(true)
    const linked = await t.run(Search.use((s) => s.page(t.local.id, "needle", 0, true)))
    expect(linked.hits.map((h) => h.threadId ?? null)).toEqual([null, null])
    const window = await t.run(Search.use((s) => s.page(t.local.id, "needle", 0)))
    expect(window.hits.filter((h) => h.threadId === thread.id)).toHaveLength(2)
    // The events of another thread do not go to linked devices: the window of this computer gets them.
    expect(
      t.events.some(
        (e) =>
          e.event === "chat.message" && (e.payload as { threadId?: string }).threadId === thread.id,
      ),
    ).toBe(true)
  })
})
