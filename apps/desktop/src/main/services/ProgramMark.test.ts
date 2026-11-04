import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import {
  type ChannelMessage,
  type ChatMessage,
  type MarkPlace,
  type MessagePart,
  NO_MARKS,
  type OutsideSource,
  type PermissionLevel,
  type ToolAsk,
} from "@robot/shared"
import { Effect } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat, type TaskOrigin } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Handover } from "./Handover.ts"
import { Memory } from "./Memory.ts"
import { PlaceMarks } from "./PlaceMarks.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

// The program mark (spec 007, "Program mark"; 023, 028). The producer of the mark for Teams (the
// Teams link of spec 028) calls the chat with the origin below. The outside programs of spec 023
// are not in the app yet. Nothing here needs the Teams page.

const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks)
          controller.enqueue(
            enc.encode(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`),
          )
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
const delta = (content: string) => ({ choices: [{ delta: { content } }] })
const usage = { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }

/**
 * A stand-in model. A message with `CALLS [...]` makes it call those tools in one reply, and it
 * answers "Done." after the results. A last line `PLAN [...]` makes a plan with those parts (for
 * the lead of a channel). `FLIP word` answers with the word reversed, so that a search can find
 * the reply and not the message. Any other text gets "ok".
 */
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    // A context of 1000 tokens, so that a compact has a size to work with.
    if (url.pathname === "/v1/models")
      return Response.json({ data: [{ id: "mock", context_length: 1000 }] })
    const body = (await req.json()) as { messages: { role: string; content: string | null }[] }
    const last = body.messages.at(-1)
    if (last?.role === "tool") return sse([delta("Done."), usage, "[DONE]"])
    const text = String(last?.content ?? "")
    const lastLine = text.split("\n").at(-1) ?? ""
    const plan = /^PLAN (\[.*\])$/.exec(lastLine)
    if (plan)
      return sse([
        delta(JSON.stringify({ plan: "Split", parts: JSON.parse(plan[1] as string) })),
        usage,
        "[DONE]",
      ])
    const calls = /^CALLS (\[.*\])$/.exec(lastLine)
    if (calls) {
      const list = JSON.parse(calls[1] as string) as { name: string; args: unknown }[]
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: list.map((c, index) => ({
                  index,
                  id: `call_${index + 1}`,
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              },
            },
          ],
        },
        "[DONE]",
      ])
    }
    const flip = /FLIP (\w+)/.exec(lastLine)
    if (flip) return sse([delta([...(flip[1] as string)].reverse().join("")), usage, "[DONE]"])
    return sse([delta("ok"), usage, "[DONE]"])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => boolean | Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const TEAMS: OutsideSource = { kind: "teams" }
/** The origin of a turn that a message from Teams starts. The real link gives the same fields. */
const fromTeams = (agentId: string): TaskOrigin => ({
  source: "teams",
  sourceId: agentId,
  starter: "program",
  outside: TEAMS,
  teamsSender: "Marta Kim",
})

const calls = (...list: { name: string; args: unknown }[]) => `CALLS ${JSON.stringify(list)}`
const save = (text: string) => ({ name: "save_memory", args: { text } })
const change = (instructions: string) => ({ name: "settings", args: { instructions } })
const search = (query: string) => ({ name: "search_chats", args: { query } })
const tell = (to: string, text: string) => ({ name: "send_message", args: { to, text } })

type ToolPart = Extract<MessagePart, { kind: "tool" }>
const toolOf = (message: ChatMessage | ChannelMessage | undefined, callId: string) =>
  message?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === callId)

const setup = async (permission: PermissionLevel) => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-program-mark-test",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const make = async (name: string) => {
    const agent = await run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: "Work.",
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
    await run(Agents.use((a) => a.update(agent.id, { permission })))
    mkdirSync(agent.workspace, { recursive: true })
    return agent
  }
  const ada = await make("Ada")
  const bo = await make("Bo")
  const lia = await make("Lia")
  const cy = await make("Cy")
  const db = await run(Database.use((d) => Effect.succeed(d)))

  // --- direct chat ---
  const send = (
    agentId: string,
    text: string,
    options: { origin?: TaskOrigin; threadId?: string | null } = {},
  ) =>
    run(
      Chat.use((c) =>
        c.send(
          { agentId, text, replyTo: null, threadId: options.threadId ?? null },
          options.origin,
        ),
      ),
    )
  const messages = async (agentId: string, threadId: string | null = null) =>
    (await run(Chat.use((c) => c.history(agentId, threadId)))).messages
  const reply = async (agentId: string, threadId: string | null = null) =>
    (await messages(agentId, threadId)).filter((m) => m.author === "agent").at(-1)
  /** Waits until every task has ended or waits for the user, and at least `count` tasks exist. */
  const quiet = (count: number) =>
    until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      return all.length >= count && all.every((x) => !["queued", "running"].includes(x.state))
    })
  const tasksCount = async () => (await run(Tasks.use((x) => x.list(local.id)))).length
  /** Sends and waits until the new turn ended or waits for an answer. */
  const turn = async (
    agentId: string,
    text: string,
    options: { origin?: TaskOrigin; threadId?: string | null } = {},
  ) => {
    const before = await tasksCount()
    await send(agentId, text, options)
    await quiet(before + 1)
  }
  const card = async (
    agentId: string,
    callId: string,
    threadId: string | null = null,
  ): Promise<ToolAsk | undefined> => {
    await until(async () => toolOf(await reply(agentId, threadId), callId)?.state === "waiting")
    return toolOf(await reply(agentId, threadId), callId)?.ask
  }
  const respond = (agentId: string, callId: string, answer: string) =>
    run(Tools.use((x) => x.respond(agentId, callId, answer)))
  const memory = async (agentId: string) =>
    (await run(Memory.use((m) => m.list(agentId)))).map((i) => i.text).sort()
  const instructions = async (agentId: string) =>
    (await run(Agents.use((a) => a.get(agentId)))).instructions
  const marks = (place: MarkPlace) => run(PlaceMarks.use((m) => Effect.succeed(m.get(place))))
  const clear = (place: MarkPlace) => run(PlaceMarks.use((m) => Effect.sync(() => m.clear(place))))
  const log = () => run(ActionLog.use((l) => l.list()))
  const column = (table: "message" | "channel_message", id: string) =>
    db.get<{ program_mark: string | null }>(`SELECT program_mark FROM ${table} WHERE id = ?`, id)
      ?.program_mark ?? null

  // --- channel ---
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId: local.id,
        name: "Launch",
        topic: "Ship it",
        memberIds: [lia.id, bo.id, cy.id],
        leadId: lia.id,
      }),
    ),
  )
  const channelPlace: MarkPlace = { kind: "channel", id: channel.id }
  const post = (text: string, origin?: { outside: OutsideSource }, id: string = channel.id) =>
    run(Channels.use((c) => c.send(id, text, null, origin)))
  const channelHistory = (id: string = channel.id) => run(Channels.use((c) => c.history(id)))
  const part = (prompt: unknown[], member = "Cy") =>
    `PLAN ${JSON.stringify([{ member, label: "Remember", prompt: calls(...(prompt as never[])) }])}`
  const channelCard = async (memberId: string, callId = "call_1") => {
    await until(async () =>
      (await channelHistory()).some(
        (m) => m.agentId === memberId && toolOf(m, callId)?.state === "waiting",
      ),
    )
    return toolOf((await channelHistory()).filter((m) => m.agentId === memberId).at(-1), callId)
      ?.ask
  }
  const channelQuiet = () =>
    until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      return all.length > 0 && all.every((x) => !["queued", "running"].includes(x.state))
    })

  return {
    ...t,
    run,
    local,
    ada,
    bo,
    lia,
    cy,
    db,
    send,
    turn,
    messages,
    reply,
    quiet,
    card,
    respond,
    memory,
    instructions,
    marks,
    clear,
    log,
    column,
    channel,
    channelPlace,
    post,
    part,
    channelHistory,
    channelCard,
    channelQuiet,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>
const agentPlace = (s: Setup): MarkPlace => ({ kind: "agent", id: s.ada.id })

describe("a turn that a message from Teams starts", () => {
  test("at every level that does not refuse, also at Full access, a save asks and names Teams", async () => {
    for (const level of ["ask_all", "ask_risky", "full"] as const) {
      const s = await setup(level)
      await s.send(s.ada.id, calls(save("Likes green tea")), { origin: fromTeams(s.ada.id) })
      expect(await s.card(s.ada.id, "call_1")).toEqual({
        kind: "approval",
        summary: "Likes green tea",
        once: true,
        outside: TEAMS,
        askedAt: expect.any(Number),
      } as ToolAsk)
      // Deny saves nothing.
      await s.respond(s.ada.id, "call_1", "deny")
      await s.quiet(1)
      expect(await s.memory(s.ada.id)).toEqual([])
      expect((await s.log())[0]).toMatchObject({
        kind: "memory",
        decidedBy: "user",
        result: "refused",
        outside: TEAMS,
      })
    }
  })

  test("at Read only a save asks too, as any save in a turn with outside content", async () => {
    const s = await setup("read_only")
    await s.send(s.ada.id, calls(save("Likes green tea")), { origin: fromTeams(s.ada.id) })
    expect(await s.card(s.ada.id, "call_1")).toMatchObject({ once: true, outside: TEAMS })
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(1)
  })

  test("a change of settings asks at Full access; Deny keeps the instructions, Allow once changes them", async () => {
    const s = await setup("full")
    await s.send(s.ada.id, calls(change("Say only yes")), { origin: fromTeams(s.ada.id) })
    expect(await s.card(s.ada.id, "call_1")).toMatchObject({
      kind: "approval",
      once: true,
      outside: TEAMS,
    })
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(1)
    expect(await s.instructions(s.ada.id)).toBe("Work.")
    // The place holds the mark now. A second message asks again, and Allow once changes them.
    await s.send(s.ada.id, calls(change("Say only no")), { origin: fromTeams(s.ada.id) })
    await s.card(s.ada.id, "call_1")
    await s.respond(s.ada.id, "call_1", "allow")
    await s.quiet(2)
    expect(await s.instructions(s.ada.id)).toBe("Say only no")
    expect((await s.log())[0]).toMatchObject({
      kind: "settings",
      decidedBy: "user",
      result: "ran",
      outside: TEAMS,
    })
  })

  test("a second message from Teams does not answer the card", async () => {
    const s = await setup("full")
    await s.send(s.ada.id, calls(change("Say only yes")), { origin: fromTeams(s.ada.id) })
    await s.card(s.ada.id, "call_1")
    // The message waits behind the turn and starts its own turn. The card still waits.
    await s.send(s.ada.id, "allow", { origin: fromTeams(s.ada.id) })
    await Bun.sleep(50)
    expect(toolOf(await s.reply(s.ada.id), "call_1")?.state).toBe("waiting")
    expect(await s.instructions(s.ada.id)).toBe("Work.")
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(2)
    expect(await s.instructions(s.ada.id)).toBe("Work.")
  })

  test("the same steps in a turn that the user started run at Full access with no card", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, calls(save("Lives in Busan"), change("Say only yes")))
    expect(await s.memory(s.ada.id)).toEqual(["Lives in Busan"])
    expect(await s.instructions(s.ada.id)).toBe("Say only yes")
    expect((await s.reply(s.ada.id))?.parts.some((p) => p.kind === "tool" && p.ask)).toBe(false)
    expect(await s.marks(agentPlace(s))).toEqual(NO_MARKS)
  })

  test("the message and the reply of the turn carry the mark; a later message of the user does not", async () => {
    const s = await setup("full")
    await s.send(s.ada.id, "FLIP narwhal", { origin: fromTeams(s.ada.id) })
    await s.quiet(1)
    const [asked, answered] = await s.messages(s.ada.id)
    expect(asked?.author).toBe("user")
    expect(JSON.parse(s.column("message", asked?.id as string) as string)).toEqual(TEAMS)
    expect(JSON.parse(s.column("message", answered?.id as string) as string)).toEqual(TEAMS)
    await s.turn(s.ada.id, "hello again")
    const later = (await s.messages(s.ada.id)).filter((m) => m.author === "user").at(-1)
    expect(s.column("message", later?.id as string)).toBeNull()
  })
})

describe("the mark goes to later turns of the same place", () => {
  test("Full access: the user denies, then writes 'hi', and the save asks; Clear and its confirm end it", async () => {
    const s = await setup("full")
    await s.send(s.ada.id, calls(save("From the program")), { origin: fromTeams(s.ada.id) })
    await s.card(s.ada.id, "call_1")
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(1)
    expect(await s.marks(agentPlace(s))).toEqual({
      outside: { source: TEAMS, program: true },
      sensitive: null,
    })
    // The user writes, and the agent saves a fact: a card shows with the source of the mark.
    await s.send(s.ada.id, calls(save("A fact")))
    expect(await s.card(s.ada.id, "call_1")).toMatchObject({ once: true, outside: TEAMS })
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(2)
    expect(await s.memory(s.ada.id)).toEqual([])
    // "Clear" removes the outside mark, and with it the program mark.
    const removed = await s.clear(agentPlace(s))
    expect(removed.outside).toEqual({ source: TEAMS, program: true })
    expect(await s.marks(agentPlace(s))).toEqual(NO_MARKS)
    await s.turn(s.ada.id, calls(save("A fact")))
    expect(await s.memory(s.ada.id)).toEqual(["A fact"])
    // A new message from Teams sets the mark again.
    await s.send(s.ada.id, "hello", { origin: fromTeams(s.ada.id) })
    await s.quiet(4)
    expect((await s.marks(agentPlace(s))).outside?.program).toBe(true)
  })

  test("the first source stays when other messages from the program come", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, "hello", { origin: fromTeams(s.ada.id) })
    await s.run(
      PlaceMarks.use((m) =>
        Effect.sync(() => m.holdProgram(agentPlace(s), { kind: "agent", name: "Bo" })),
      ),
    )
    expect((await s.marks(agentPlace(s))).outside?.source).toEqual(TEAMS)
  })

  test("a new thread starts with no mark, and its turn runs the same save with no card", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, "hello", { origin: fromTeams(s.ada.id) })
    const thread = await s.run(Chat.use((c) => c.createThread(s.ada.id)))
    expect(await s.marks({ kind: "thread", id: thread.id })).toEqual(NO_MARKS)
    await s.turn(s.ada.id, calls(save("In a thread")), { threadId: thread.id })
    expect(await s.memory(s.ada.id)).toEqual(["In a thread"])
    expect(
      (await s.reply(s.ada.id, thread.id))?.parts.some((p) => p.kind === "tool" && p.ask),
    ).toBe(false)
    // The main thread still holds the mark.
    expect((await s.marks(agentPlace(s))).outside?.program).toBe(true)
  })

  test("a message from Teams goes to the main thread, so a thread of the agent holds no mark", async () => {
    const s = await setup("full")
    const thread = await s.run(Chat.use((c) => c.createThread(s.ada.id)))
    const here: MarkPlace = { kind: "thread", id: thread.id }
    await s.send(s.ada.id, calls(save("x y")), { threadId: thread.id })
    await s.quiet(1)
    await s.send(s.ada.id, "hello", { origin: fromTeams(s.ada.id) })
    await s.quiet(2)
    // A message from Teams goes to the main thread (spec 003), so the thread holds nothing.
    expect(await s.marks(here)).toEqual(NO_MARKS)
    expect((await s.marks(agentPlace(s))).outside?.program).toBe(true)
  })

  test("a compact keeps the mark", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, "alpha", { origin: fromTeams(s.ada.id) })
    await s.turn(s.ada.id, "beta")
    await s.turn(s.ada.id, "gamma")
    const before = await s.marks(agentPlace(s))
    expect(before.outside?.program).toBe(true)
    await s.run(Chat.use((c) => c.compact({ agentId: s.ada.id, threadId: null })))
    expect(
      (await s.messages(s.ada.id)).some((m) => m.parts.some((p) => p.kind === "compacted")),
    ).toBe(true)
    expect(await s.marks(agentPlace(s))).toEqual(before)
    await s.send(s.ada.id, calls(save("After the compact")))
    expect(await s.card(s.ada.id, "call_1")).toMatchObject({ once: true, outside: TEAMS })
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(4)
  })
})

describe("a fork", () => {
  const ask = async (s: Setup) => {
    await s.turn(s.ada.id, "first words")
    await s.turn(s.ada.id, "from the program", { origin: fromTeams(s.ada.id) })
    await s.turn(s.ada.id, "last words")
    return (await s.messages(s.ada.id)).filter((m) => m.author === "agent")
  }

  test("keeps the mark when its copy holds the turn of the program, and not when it does not", async () => {
    const s = await setup("full")
    const replies = await ask(s)
    const [first, program] = replies
    // A fork of the first reply copies a chat with no outside content.
    const early = await s.run(
      Chat.use((c) => c.fork({ agentId: s.ada.id, threadId: null }, first?.id as string)),
    )
    expect(early.marks).toEqual(NO_MARKS)
    await s.turn(s.ada.id, calls(save("In the early fork")), { threadId: early.id })
    expect(await s.memory(s.ada.id)).toEqual(["In the early fork"])
    // A fork of the reply of the program turn copies that turn.
    const late = await s.run(
      Chat.use((c) => c.fork({ agentId: s.ada.id, threadId: null }, program?.id as string)),
    )
    expect(late.marks).toEqual({ outside: { source: TEAMS, program: true }, sensitive: null })
    // The copy holds the mark on its own rows.
    expect(
      JSON.parse(
        s.column("message", (await s.messages(s.ada.id, late.id))[0]?.id as string) as string,
      ),
    ).toBeDefined
    await s.send(s.ada.id, calls(save("In the late fork")), { threadId: late.id })
    expect(await s.card(s.ada.id, "call_1", late.id)).toMatchObject({ once: true, outside: TEAMS })
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(5)
  })

  test("a fork made after Clear still holds the mark when its copy holds the turn of the program", async () => {
    const s = await setup("full")
    const replies = await ask(s)
    await s.clear(agentPlace(s))
    const fork = await s.run(
      Chat.use((c) => c.fork({ agentId: s.ada.id, threadId: null }, replies[2]?.id as string)),
    )
    expect(fork.marks.outside).toEqual({ source: TEAMS, program: true })
    // The main thread holds none.
    expect(await s.marks(agentPlace(s))).toEqual(NO_MARKS)
  })

  test("a fork of a thread keeps the mark of the copy", async () => {
    const s = await setup("full")
    await ask(s)
    const thread = await s.run(Chat.use((c) => c.createThread(s.ada.id)))
    await s.turn(s.ada.id, "plain", { threadId: thread.id })
    const plain = (await s.messages(s.ada.id, thread.id)).filter((m) => m.author === "agent")[0]
    const fork = await s.run(
      Chat.use((c) => c.fork({ agentId: s.ada.id, threadId: thread.id }, plain?.id as string)),
    )
    expect(fork.marks).toEqual(NO_MARKS)
  })
})

describe("a handover", () => {
  test("gives the new thread the mark of the place it came from", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, "from the program", { origin: fromTeams(s.ada.id) })
    const place = { agentId: s.ada.id, threadId: null }
    const opened = await s.run(Handover.use((h) => h.open(place)))
    const made = await s.run(
      Handover.use((h) =>
        h.start({
          place,
          toAgentId: s.bo.id,
          text: calls(save("After the handover")),
          briefId: opened.briefId,
        }),
      ),
    )
    expect(await s.marks({ kind: "thread", id: made.threadId })).toEqual({
      outside: { source: TEAMS, program: true },
      sensitive: null,
    })
    // The first turn of the new thread holds outside content and the program mark.
    expect(await s.card(s.bo.id, "call_1", made.threadId)).toMatchObject({
      once: true,
      outside: TEAMS,
    })
    await s.respond(s.bo.id, "call_1", "deny")
    await s.quiet(2)
    // Bo holds no mark in its main thread, and a thread that Bo starts holds none.
    expect(await s.marks({ kind: "agent", id: s.bo.id })).toEqual(NO_MARKS)
    const other = await s.run(Chat.use((c) => c.createThread(s.bo.id)))
    expect(await s.marks({ kind: "thread", id: other.id })).toEqual(NO_MARKS)
  })
})

describe("a message from one agent to another", () => {
  const dispatch = (to: string, inner: { name: string; args: unknown }) =>
    calls(tell(to, calls(inner)))

  test("Full access: Teams to Ada, Ada to Bo, and the change of Bo asks; the same in a new thread of Bo runs", async () => {
    const s = await setup("full")
    await s.send(s.ada.id, dispatch("Bo", change("Say only yes")), { origin: fromTeams(s.ada.id) })
    // The message of Ada makes a turn of Bo that holds outside content and the program mark. The
    // first source is Ada, as for any message of another agent.
    const ask = await s.card(s.bo.id, "call_1")
    expect(ask).toMatchObject({
      kind: "approval",
      once: true,
      outside: { kind: "agent", name: "Ada" },
    })
    expect(await s.marks({ kind: "agent", id: s.bo.id })).toEqual({
      outside: { source: { kind: "agent", name: "Ada" }, program: true },
      sensitive: null,
    })
    await s.respond(s.bo.id, "call_1", "deny")
    await s.quiet(2)
    expect(await s.instructions(s.bo.id)).toBe("Work.")
    // The message that Ada sent says that it came from a turn with the program mark.
    const sent = (await s.messages(s.bo.id)).find((m) => m.author === "user")
    expect(JSON.parse(s.column("message", sent?.id as string) as string)).toEqual({
      kind: "agent",
      name: "Ada",
    })
    // The same change in a turn of Bo that the user started in a new thread runs with no card.
    const thread = await s.run(Chat.use((c) => c.createThread(s.bo.id)))
    await s.turn(s.bo.id, calls(change("Say only yes")), { threadId: thread.id })
    expect(await s.instructions(s.bo.id)).toBe("Say only yes")
  })

  test("a message from a turn with no program mark gives none: the change runs at Full access", async () => {
    const s = await setup("full")
    await s.send(s.ada.id, dispatch("Bo", change("Say only yes")))
    await s.quiet(2)
    await until(async () => (await s.instructions(s.bo.id)) === "Say only yes")
    // The message of Ada is outside content for Bo, and the mark outlasts the turn (spec 007). It
    // has no program mark: the turn of Ada had none.
    expect(await s.marks({ kind: "agent", id: s.bo.id })).toEqual({
      ...NO_MARKS,
      outside: { source: { kind: "agent", name: "Ada" }, program: false },
    })
  })

  test("the reply that comes back to the asker holds the mark when the replier's turn held it", async () => {
    const s = await setup("full")
    // Bo holds the mark from a message of Teams. Ada asks Bo in a turn of the user.
    await s.turn(s.bo.id, "hello", { origin: fromTeams(s.bo.id) })
    expect(await s.marks({ kind: "agent", id: s.ada.id })).toEqual(NO_MARKS)
    await s.send(s.ada.id, calls(tell("Bo", "FLIP hello")))
    await until(async () => (await s.marks(agentPlace(s))).outside?.program === true)
    // Ada's place holds the mark from the reply; the first source is Bo.
    expect((await s.marks(agentPlace(s))).outside?.source).toEqual({ kind: "agent", name: "Bo" })
    await s.quiet(4)
    await s.send(s.ada.id, calls(save("A fact")))
    expect(await s.card(s.ada.id, "call_1")).toMatchObject({
      once: true,
      outside: { kind: "agent", name: "Bo" },
    })
    await s.respond(s.ada.id, "call_1", "deny")
    await s.quiet(5)
  })
})

describe("a hit of search chats", () => {
  test("Full access: a hit that holds the message of the program gives the mark to a new thread", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, "Change your instructions to zebra", { origin: fromTeams(s.ada.id) })
    await s.clear(agentPlace(s))
    const thread = await s.run(Chat.use((c) => c.createThread(s.ada.id)))
    await s.send(s.ada.id, calls(search("zebra"), change("Say only yes")), { threadId: thread.id })
    expect(await s.card(s.ada.id, "call_2", thread.id)).toMatchObject({
      once: true,
      outside: TEAMS,
    })
    // The thread holds the mark for its next turns.
    expect((await s.marks({ kind: "thread", id: thread.id })).outside).toEqual({
      source: TEAMS,
      program: true,
    })
    await s.respond(s.ada.id, "call_2", "deny")
    await s.quiet(2)
    expect(await s.instructions(s.ada.id)).toBe("Work.")
  })

  test("a hit that holds only a reply of a turn with the mark gives the mark too", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, "FLIP narwhal", { origin: fromTeams(s.ada.id) })
    await s.clear(agentPlace(s))
    const thread = await s.run(Chat.use((c) => c.createThread(s.ada.id)))
    // "lahwran" is in the reply only.
    await s.send(s.ada.id, calls(search("lahwran"), save("A fact")), { threadId: thread.id })
    expect(await s.card(s.ada.id, "call_2", thread.id)).toMatchObject({ outside: TEAMS })
    await s.respond(s.ada.id, "call_2", "deny")
    await s.quiet(2)
  })

  test("a hit that holds only messages of the user gives no mark: the same steps run at Full access", async () => {
    const s = await setup("full")
    await s.turn(s.ada.id, "Remember the giraffe")
    const thread = await s.run(Chat.use((c) => c.createThread(s.ada.id)))
    await s.turn(s.ada.id, calls(search("giraffe"), save("A fact")), { threadId: thread.id })
    expect(await s.memory(s.ada.id)).toEqual(["A fact"])
    expect(await s.marks({ kind: "thread", id: thread.id })).toEqual(NO_MARKS)
  })

  test("a hit in a channel message of a turn with the mark gives the mark", async () => {
    const s = await setup("full")
    await s.post(s.part([save("Bo says yes")], "Bo"), { outside: TEAMS })
    await s.channelCard(s.bo.id)
    await s.respond(s.bo.id, "call_1", "deny")
    await s.channelQuiet()
    // The plan of the lead and the reply of Bo are messages of turns that held the mark. Cy is a
    // member, so a search of Cy finds the plan.
    const thread = await s.run(Chat.use((c) => c.createThread(s.cy.id)))
    await s.send(s.cy.id, calls(search("Remember"), save("A fact")), { threadId: thread.id })
    expect(await s.card(s.cy.id, "call_2", thread.id)).toMatchObject({ once: true, outside: TEAMS })
    await s.respond(s.cy.id, "call_2", "deny")
    await s.quiet(1)
  })
})

describe("a channel", () => {
  test("a job from Teams: every part holds the mark, and a member's save asks, also at Full access", async () => {
    const s = await setup("full")
    expect(await s.post(s.part([save("Cy answers yes")]), { outside: TEAMS })).toEqual({
      awaiting: false,
    })
    // The channel holds the mark from the arrival of the job.
    expect(await s.marks(s.channelPlace)).toEqual({
      outside: { source: TEAMS, program: true },
      sensitive: null,
    })
    // The job came from Teams, so the part holds outside content from its start. The first source
    // is the one of the channel: Teams (spec 007, "Outside content").
    expect(await s.channelCard(s.cy.id)).toMatchObject({
      kind: "approval",
      once: true,
      outside: TEAMS,
    })
    await s.respond(s.cy.id, "call_1", "deny")
    await s.channelQuiet()
    expect(await s.memory(s.cy.id)).toEqual([])
    const history = await s.channelHistory()
    // The job, the plan of the lead and the reply of the member say that the program mark is there.
    expect(history.map((m) => s.column("channel_message", m.id) !== null)).toEqual([
      true,
      true,
      true,
      true,
    ])
  })

  test("the same job from the user runs at Full access with no card", async () => {
    const s = await setup("full")
    await s.post(s.part([save("Cy answers yes")]))
    await s.channelQuiet()
    expect(await s.memory(s.cy.id)).toEqual(["Cy answers yes"])
    expect(await s.marks(s.channelPlace)).toEqual(NO_MARKS)
  })

  test("a later job from the user holds the mark, also when the older messages left the history", async () => {
    const s = await setup("full")
    await s.post(s.part([save("One")]), { outside: TEAMS })
    await s.channelCard(s.cy.id)
    await s.respond(s.cy.id, "call_1", "deny")
    await s.channelQuiet()
    // 45 plain messages follow: the job from Teams is not in the 40 that a turn reads any more.
    const newest = s.db.get<{ t: number }>(
      "SELECT MAX(created_at) AS t FROM channel_message WHERE channel_id = ?",
      s.channel.id,
    )?.t as number
    for (let i = 0; i < 45; i++)
      s.db.run(
        `INSERT INTO channel_message (id, channel_id, author, kind, parts, status, created_at, finished_at)
         VALUES (?, ?, 'user', 'text', ?, 'done', ?, ?)`,
        `filler-${i}`,
        s.channel.id,
        JSON.stringify([{ kind: "text", text: `filler ${i}` }]),
        newest + 1 + i,
        newest + 1 + i,
      )
    await Bun.sleep(100)
    await s.post(s.part([save("Two")], "Bo"))
    expect(await s.channelCard(s.bo.id)).toMatchObject({ once: true })
    await s.respond(s.bo.id, "call_1", "deny")
    await s.channelQuiet()
    // "Clear" for the channel ends it: the next job runs with no card.
    const removed = await s.clear(s.channelPlace)
    expect(removed.outside?.program).toBe(true)
    await s.post(s.part([save("Three")], "Bo"))
    await s.channelQuiet()
    await until(async () => (await s.memory(s.bo.id)).includes("Three"))
  })

  test("a job that waits for the user to pick a member keeps the mark: the member's save asks", async () => {
    const s = await setup("full")
    const open = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "No lead",
          topic: "",
          memberIds: [s.bo.id, s.cy.id],
          leadId: null,
        }),
      ),
    )
    expect(await s.post(calls(save("Cy answers yes")), { outside: TEAMS }, open.id)).toEqual({
      awaiting: true,
    })
    expect((await s.marks({ kind: "channel", id: open.id })).outside?.program).toBe(true)
    const job = (await s.channelHistory(open.id))[0]
    expect(s.column("channel_message", job?.id as string)).not.toBeNull()
    await s.run(Channels.use((c) => c.assign(open.id, job?.id as string, s.cy.id)))
    await until(async () =>
      (await s.channelHistory(open.id)).some((m) => toolOf(m, "call_1")?.state === "waiting"),
    )
    const card = toolOf(
      (await s.channelHistory(open.id)).find((m) => m.agentId === s.cy.id),
      "call_1",
    )?.ask
    expect(card).toMatchObject({ once: true })
    await s.respond(s.cy.id, "call_1", "deny")
    await s.channelQuiet()
    // The other channel holds nothing.
    expect(await s.marks(s.channelPlace)).toEqual(NO_MARKS)
  })
})

describe("older data and stored forms", () => {
  test("a place with no outside mark, or a text that is no mark, reads as no mark", async () => {
    const s = await setup("full")
    expect(await s.marks(agentPlace(s))).toEqual(NO_MARKS)
    for (const text of ["", "not json", '{"source":{"kind":"x"},"program":true}', "[]", "5"])
      for (const table of ["agent", "channel"] as const) {
        s.db.run(`UPDATE ${table} SET outside_mark = ?`, text)
        expect(
          (await s.marks({ kind: table, id: table === "agent" ? s.ada.id : s.channel.id })).outside,
        ).toBeNull()
      }
    // A turn in such a place holds nothing, and the save runs.
    await s.turn(s.ada.id, calls(save("Plain")))
    expect(await s.memory(s.ada.id)).toEqual(["Plain"])
  })

  test("a message from before this step has no mark, and a search over it gives none", async () => {
    const s = await setup("full")
    s.db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('old-1', ?, 'user', ?, 'done', ?)`,
      s.ada.id,
      JSON.stringify([{ kind: "text", text: "an old wombat" }]),
      Date.now() - 1000,
    )
    s.db.run("UPDATE message SET program_mark = 'garbage' WHERE id = 'old-1'")
    const thread = await s.run(Chat.use((c) => c.createThread(s.ada.id)))
    await s.turn(s.ada.id, calls(search("wombat"), save("A fact")), { threadId: thread.id })
    expect(await s.memory(s.ada.id)).toEqual(["A fact"])
  })

  test("the action log keeps and lists an entry whose source is Teams", async () => {
    const s = await setup("full")
    await s.send(s.ada.id, calls(save("x y")), { origin: fromTeams(s.ada.id) })
    await s.card(s.ada.id, "call_1")
    await s.respond(s.ada.id, "call_1", "allow")
    await s.quiet(1)
    expect((await s.log())[0]).toMatchObject({ kind: "memory", result: "ran", outside: TEAMS })
    expect(await s.memory(s.ada.id)).toEqual(["x y"])
  })
})
