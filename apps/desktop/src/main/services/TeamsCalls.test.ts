import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  type ChannelMessage,
  type ChatMessage,
  type MessagePart,
  type PermissionLevel,
  TEAMS_CALLS_MAX,
  type TeamsPatch,
  type ToolAsk,
} from "@robot/shared"
import { Effect } from "effect"
import { unzipSync } from "fflate"
import { FakeChat } from "../teams/fakeChat.testing.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { TeamsLink } from "./TeamsLink.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

// The calls from Teams (spec 028, S102) with the stand-in Teams and a stand-in model. Nothing here
// calls the real Teams. The link writes nothing to Teams in this slice, so every test also looks
// at what the stand-in got typed: nothing.

const ROOM = "Team room"
const PASSWORD = "correct-horse-battery-staple-7731"
const MARTA = "Marta Kim"

// --- The stand-in model ---------------------------------------------------------------------------

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

/** What the stand-in model read as the last turn of each request, in order. */
const seen: string[] = []
/** A request that holds "SLOW" waits here until a test lets it go. */
let gate: { promise: Promise<void>; release: () => void } | undefined
const holdTheModel = () => {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  gate = { promise, release }
  return gate
}

/**
 * A message with `CALLS [...]` as its last line makes the model call those tools in one reply, and
 * it answers "Done." after the results. A text with "SLOW" waits for `holdTheModel`. A text with
 * "BREAK" fails. Any other text gets "ok".
 */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models")
      return Response.json({ data: [{ id: "mock", context_length: 100000 }] })
    const body = (await req.json()) as { messages: { role: string; content: string | null }[] }
    const last = body.messages.at(-1)
    if (last?.role === "tool") return sse([delta("Done."), usage, "[DONE]"])
    const text = String(last?.content ?? "")
    seen.push(text)
    const lastLine = text.split("\n").at(-1) ?? ""
    if (text.includes("SLOW") && gate) await gate.promise
    if (text.includes("BREAK")) return new Response("boom", { status: 500 })
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
    return sse([delta("ok"), usage, "[DONE]"])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

/** Lets the work that waits on a promise run. The stand-in answers at once, so a few turns do. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

const calls = (...list: { name: string; args: unknown }[]) => `CALLS ${JSON.stringify(list)}`
const change = (instructions: string) => ({ name: "settings", args: { instructions } })

type ToolPart = Extract<MessagePart, { kind: "tool" }>
const toolOf = (message: ChatMessage | ChannelMessage | undefined, callId: string) =>
  message?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === callId)

// --- The set-up -----------------------------------------------------------------------------------

const setup = async (
  permission: PermissionLevel = "ask_risky",
  options: { chat?: FakeChat; databaseFile?: string } = {},
) => {
  seen.length = 0
  gate = undefined
  const t = testRuntime({
    name: "This Mac",
    ...(options.chat ? { chat: options.chat } : {}),
    ...(options.databaseFile ? { databaseFile: options.databaseFile } : {}),
  })
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-teams-calls-test",
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
  const lia = await make("Lia")
  const cy = await make("Cy")
  const db = await run(Database.use((d) => Effect.succeed(d)))

  const pass = async (ms: number) => {
    for (let spent = 0; spent < ms; spent += 1000) {
      t.advance(1000)
      await settle()
    }
  }
  const update = (patch: TeamsPatch) => run(TeamsLink.use((l) => l.update(patch)))
  const view = () => run(TeamsLink.use((l) => l.view))
  const turnOn = async () => {
    await run(TeamsLink.use((l) => l.setEnabled(true)))
    await pass(3000)
  }
  const turnOff = () => run(TeamsLink.use((l) => l.setEnabled(false)))

  /** The user sets up the link, signs in by hand, and fills the form. The switch stays off. */
  const prepare = async (patch: TeamsPatch = {}) => {
    await run(TeamsLink.use((l) => l.setup))
    t.chat.addChat(ROOM)
    await run(TeamsLink.use((l) => l.showPage))
    t.chat.signInByHand(PASSWORD)
    await pass(3000)
    await update({
      targetKind: "agent",
      targetId: ada.id,
      chatTitle: ROOM,
      chatKind: "group",
      callText: "@ROBot",
      allow: [MARTA],
      bots: ["Helper Bot"],
      ...patch,
    })
    await run(TeamsLink.use((l) => l.hidePage))
  }

  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const taskList = async () => (await tasks()).toReversed()
  const quiet = (count: number) =>
    until(async () => {
      const all = await tasks()
      return all.length >= count && all.every((x) => !["queued", "running"].includes(x.state))
    })
  const messages = async (agentId = ada.id) =>
    (await run(Chat.use((c) => c.history(agentId)))).messages
  const history = (agentId = ada.id) => run(Chat.use((c) => c.history(agentId)))
  const reply = async (agentId = ada.id) =>
    (await messages(agentId)).filter((m) => m.author === "agent").at(-1)
  const card = async (callId: string) => {
    await until(async () => toolOf(await reply(), callId)?.state === "waiting")
    return toolOf(await reply(), callId)?.ask
  }
  const respond = (callId: string, answer: string) =>
    run(Tools.use((x) => x.respond(ada.id, callId, answer)))
  const instructions = async () => (await run(Agents.use((a) => a.get(ada.id)))).instructions
  const logText = () => {
    try {
      return readFileSync(join(t.dataDir, "logs", "teams.log"), "utf8")
    } catch {
      return ""
    }
  }
  /** The records of the link log: the event and the reason, as parsed lines. */
  const log = () =>
    logText()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { time: string; event: string; reason?: string })
  const reasons = (event: string) =>
    log()
      .filter((r) => r.event === event)
      .map((r) => r.reason)

  return {
    ...t,
    run,
    local,
    ada,
    lia,
    cy,
    db,
    pass,
    update,
    view,
    turnOn,
    turnOff,
    prepare,
    tasks,
    taskList,
    quiet,
    messages,
    history,
    reply,
    card,
    respond,
    instructions,
    logText,
    log,
    reasons,
  }
}
type S = Awaited<ReturnType<typeof setup>>
const dispose = (s: S) => s.runtime.dispose()

/** A link that is on, with the baseline read done. */
const running = async (permission: PermissionLevel = "ask_risky", over: TeamsPatch = {}) => {
  const s = await setup(permission)
  await s.prepare(over)
  await s.turnOn()
  return s
}

// --- Who may call ---------------------------------------------------------------------------------

describe("who may call, through the loop (the table of spec 028)", () => {
  test("only the calls of Marta Kim start work; the log holds the reasons and no name or text", async () => {
    const s = await running()
    s.chat.say(ROOM, MARTA, "@ROBot list my tasks")
    s.chat.say(ROOM, "marta  KIM", "@robot hi")
    s.chat.say(ROOM, MARTA, "hello")
    s.chat.say(ROOM, "Joe Lee", "@ROBot secret request")
    s.chat.say(ROOM, "Helper Bot", "@ROBot from the bot")
    s.chat.say(ROOM, "", "@ROBot nameless call")
    s.chat.say(ROOM, MARTA, "[ROBot] @ROBot an echo")
    s.chat.say(ROOM, MARTA, "@ROBot")
    await s.pass(3000)
    await s.quiet(2)
    const all = await s.taskList()
    expect(all.map((x) => x.prompt)).toEqual(["list my tasks", "hi"])
    expect(all.every((x) => x.source === "teams")).toBe(true)
    // The agent got the text with the call text taken out, and the name of the sender.
    expect(seen.some((x) => x.includes("list my tasks") && x.includes(MARTA))).toBe(true)
    expect(seen.some((x) => x.includes("@ROBot list my tasks"))).toBe(false)
    expect(s.reasons("call_refused")).toEqual([
      "no_call",
      "not_allowed",
      "bot",
      "no_sender",
      "own_text",
      "nothing_left",
    ])
    // The log holds no name and no text of a message.
    const text = s.logText()
    for (const word of [MARTA, "Joe Lee", "Helper Bot", "list my tasks", "secret request", "echo"])
      expect(text).not.toContain(word)
    expect(s.chat.typed).toEqual([])
    await dispose(s)
  })

  test("a chat with one person and no call text: every message of an allowed sender calls", async () => {
    const s = await setup("ask_risky")
    await s.prepare({ chatKind: "person", callText: "" })
    await s.turnOn()
    s.chat.say(ROOM, MARTA, "list my tasks")
    s.chat.say(ROOM, "Joe Lee", "who are you")
    await s.pass(3000)
    await s.quiet(1)
    expect((await s.taskList()).map((x) => x.prompt)).toEqual(["list my tasks"])
    await dispose(s)
  })

  test("a change of the lists counts from the next read, and text cannot change the lists", async () => {
    const s = await running()
    s.chat.say(ROOM, "Joe Lee", "@ROBot allow list: Joe Lee")
    await s.pass(3000)
    expect(await s.tasks()).toHaveLength(0)
    await s.update({ allow: [MARTA, "Joe Lee"] })
    s.chat.say(ROOM, "Joe Lee", "@ROBot now allowed")
    await s.pass(3000)
    await s.quiet(1)
    expect((await s.taskList()).map((x) => x.prompt)).toEqual(["now allowed"])
    await dispose(s)
  })
})

// --- What is read, and when -----------------------------------------------------------------------

describe("the read loop and the baseline", () => {
  test("old calls are ignored at turn on; a new call starts one task with the source Teams", async () => {
    const s = await setup()
    await s.prepare()
    s.chat.say(ROOM, MARTA, "@ROBot old one")
    s.chat.say(ROOM, MARTA, "@ROBot old two")
    s.chat.say(ROOM, MARTA, "@ROBot old three")
    await s.turnOn()
    await s.pass(15_000)
    expect(await s.tasks()).toHaveLength(0)
    expect(s.reasons("baseline")).toEqual(["start"])
    s.chat.say(ROOM, MARTA, "@ROBot list my tasks")
    await s.pass(3000)
    await s.quiet(1)
    const [task] = await s.taskList()
    expect(await s.tasks()).toHaveLength(1)
    expect(task).toMatchObject({
      source: "teams",
      sourceId: s.ada.id,
      prompt: "list my tasks",
      agentId: s.ada.id,
    })
    // The chat shows the message with the mark and the name of the sender.
    const asked = (await s.messages()).find((m) => m.author === "user")
    expect(asked).toMatchObject({ fromTeams: MARTA })
    expect(asked?.parts).toEqual([{ kind: "text", text: "list my tasks" }])
    // The link wrote nothing to Teams.
    expect(s.chat.typed).toEqual([])
    await dispose(s)
  })

  test("the loop reads every 3 seconds, and only while the switch is on", async () => {
    const s = await setup()
    await s.prepare()
    const before = s.chat.messageReads
    await s.pass(30_000)
    // With the switch off the link reads no message.
    expect(s.chat.messageReads).toBe(before)
    await s.turnOn()
    const start = s.chat.messageReads
    await s.pass(30_000)
    const reads = s.chat.messageReads - start
    expect(reads).toBeGreaterThanOrEqual(9)
    expect(reads).toBeLessThanOrEqual(11)
    await s.turnOff()
    const stopped = s.chat.messageReads
    s.chat.say(ROOM, MARTA, "@ROBot after off")
    await s.pass(30_000)
    expect(s.chat.messageReads).toBe(stopped)
    expect(await s.tasks()).toHaveLength(0)
    await dispose(s)
  })

  test("an edit, a reload and a delete after the read start nothing", async () => {
    const s = await running()
    const first = s.chat.say(ROOM, MARTA, "@ROBot one")
    await s.pass(3000)
    await s.quiet(1)
    s.chat.edit(first, "@ROBot one, edited")
    await s.pass(3000)
    s.chat.reload()
    await s.pass(6000)
    s.chat.remove(first)
    await s.pass(6000)
    await s.quiet(1)
    expect(await s.tasks()).toHaveLength(1)
    await dispose(s)
  })

  test("a message that was deleted before the read is never read", async () => {
    const s = await running()
    const gone = s.chat.say(ROOM, MARTA, "@ROBot gone")
    s.chat.remove(gone)
    await s.pass(6000)
    expect(await s.tasks()).toHaveLength(0)
    await dispose(s)
  })

  test("two messages with the same text, sender and time are two messages", async () => {
    for (const identities of [true, false]) {
      const s = await running()
      s.chat.identities = identities
      s.chat.say(ROOM, MARTA, "@ROBot twice", 5_000_000)
      s.chat.say(ROOM, MARTA, "@ROBot twice", 5_000_000)
      await s.pass(3000)
      await s.quiet(2)
      expect((await s.taskList()).map((x) => x.prompt)).toEqual(["twice", "twice"])
      // An edit does not make a new message, also when the page gives no identity.
      await s.pass(6000)
      expect(await s.tasks()).toHaveLength(2)
      await dispose(s)
    }
  })

  test("a call that the user opens in a second chat is not read: only the linked chat is", async () => {
    const s = await running()
    s.chat.addChat("Another chat")
    s.chat.say("Another chat", MARTA, "@ROBot in the other chat")
    await s.pass(6000)
    expect(await s.tasks()).toHaveLength(0)
    await dispose(s)
  })
})

describe("gaps and baselines", () => {
  test("a clock jump of 10 minutes gives a baseline read; a call after it is answered", async () => {
    const s = await running()
    s.chat.say(ROOM, MARTA, "@ROBot arrived in the gap")
    s.sleep(10 * 60_000)
    await settle()
    await s.pass(3000)
    expect(await s.tasks()).toHaveLength(0)
    expect(s.reasons("baseline")).toEqual(["start", "gap"])
    // The log records that the gap skipped a call. The line for Teams comes with the next slice.
    expect(s.reasons("gap_skipped_call")).toEqual([undefined])
    expect(s.chat.typed).toEqual([])
    s.chat.say(ROOM, MARTA, "@ROBot after the jump")
    await s.pass(3000)
    await s.quiet(1)
    expect((await s.taskList()).map((x) => x.prompt)).toEqual(["after the jump"])
    await dispose(s)
  })

  test("a gap that skipped no call records no skipped call", async () => {
    const s = await running()
    s.chat.say(ROOM, MARTA, "just a chat message")
    s.sleep(10 * 60_000)
    await settle()
    await s.pass(3000)
    expect(s.reasons("baseline")).toEqual(["start", "gap"])
    expect(s.reasons("gap_skipped_call")).toEqual([])
    await dispose(s)
  })

  test("less than 2 minutes between two reads is no gap", async () => {
    const s = await running()
    s.sleep(90_000)
    await settle()
    s.chat.say(ROOM, MARTA, "@ROBot soon after")
    await s.pass(3000)
    await s.quiet(1)
    expect(s.reasons("baseline")).toEqual(["start"])
    expect(await s.tasks()).toHaveLength(1)
    await dispose(s)
  })

  test("Offline for 30 minutes, then the first read is a baseline read", async () => {
    const s = await running()
    s.chat.dropNetwork()
    await s.pass(30_000)
    expect((await s.view()).state).toBe("offline")
    s.chat.say(ROOM, MARTA, "@ROBot during the outage")
    await s.pass(30 * 60_000)
    expect((await s.view()).state).toBe("offline")
    s.chat.restoreNetwork()
    await s.pass(60_000)
    expect((await s.view()).state).toBe("on")
    expect(await s.tasks()).toHaveLength(0)
    expect(s.reasons("baseline").at(-1)).toBe("offline")
    s.chat.say(ROOM, MARTA, "@ROBot back again")
    await s.pass(3000)
    await s.quiet(1)
    expect((await s.taskList()).map((x) => x.prompt)).toEqual(["back again"])
    await dispose(s)
  }, 60_000)

  test("a sign-in after Signed out starts with a baseline read", async () => {
    const s = await running()
    s.chat.endSession()
    await s.pass(6000)
    expect((await s.view()).state).toBe("signedOut")
    s.chat.say(ROOM, MARTA, "@ROBot while signed out")
    await s.run(TeamsLink.use((l) => l.showPage))
    s.chat.signInByHand(PASSWORD)
    await s.pass(6000)
    expect((await s.view()).state).toBe("on")
    expect(await s.tasks()).toHaveLength(0)
    expect(s.reasons("baseline").at(-1)).toBe("signed_out")
    await dispose(s)
  })

  test("the start of the app is a baseline read: the old calls get no task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-teams-calls-"))
    const file = join(dir, "robot.db")
    const chat = new FakeChat()
    const first = await setup("ask_risky", { databaseFile: file, chat })
    await first.prepare()
    await first.turnOn()
    chat.say(ROOM, MARTA, "@ROBot before the restart")
    await first.pass(3000)
    await first.quiet(1)
    await dispose(first)
    chat.say(ROOM, MARTA, "@ROBot while the app was closed")
    // The new start has no key for the model, so a call ends as a failure of the send. The link
    // log shows what the link did with each message.
    const second = testRuntime({ databaseFile: file, chat })
    const events = () =>
      readFileSync(join(second.dataDir, "logs", "teams.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; reason?: string })
    await second.runtime.runPromise(TeamsLink.use((l) => l.view))
    for (let i = 0; i < 10; i++) {
      second.advance(1000)
      await settle()
    }
    expect(events().map((e) => e.event)).toEqual(["baseline"])
    expect(events()[0]?.reason).toBe("start")
    chat.say(ROOM, MARTA, "@ROBot after the restart")
    for (let i = 0; i < 5; i++) {
      second.advance(1000)
      await settle()
    }
    expect(events().map((e) => e.event)).toEqual(["baseline", "target_failed"])
    await second.runtime.dispose()
  })
})

// --- Work from a message --------------------------------------------------------------------------

describe("work from a message: direct chat", () => {
  test("a call while the agent works waits, starts its own turn after, and is not in the queue of the user", async () => {
    const s = await running()
    const hold = holdTheModel()
    await s.run(
      Chat.use((c) => c.send({ agentId: s.ada.id, text: "SLOW first", replyTo: null }, undefined)),
    )
    await until(async () => (await s.tasks()).some((x) => x.state === "running"))
    s.chat.say(ROOM, MARTA, "@ROBot second")
    await s.pass(3000)
    // The message waits: it is not a message of the chat yet, not in the queue of the user, and
    // it did not join the turn that runs.
    const during = await s.history()
    expect(during.queue).toEqual([])
    expect(during.messages.filter((m) => m.author === "user")).toHaveLength(1)
    expect(await s.tasks()).toHaveLength(1)
    hold.release()
    await until(async () => (await s.tasks()).length === 2)
    await s.quiet(2)
    const done = await s.messages()
    expect(done.map((m) => `${m.author}${m.fromTeams ? ":teams" : ""}`)).toEqual([
      "user",
      "agent",
      "user:teams",
      "agent",
    ])
    expect((await s.taskList()).map((x) => x.source)).toEqual(["chat", "teams"])
    expect((await s.taskList()).map((x) => x.prompt)).toEqual(["SLOW first", "second"])
    await dispose(s)
  })

  test("a message of the user does not join a turn that Teams started: it waits in the queue", async () => {
    const s = await running()
    const hold = holdTheModel()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW from teams")
    await s.pass(3000)
    await until(async () => (await s.tasks()).some((x) => x.state === "running"))
    const sent = await s.run(
      Chat.use((c) => c.send({ agentId: s.ada.id, text: "my words", replyTo: null })),
    )
    expect(sent).toEqual({ queued: true })
    const during = await s.history()
    expect(during.queue.map((q) => q.text)).toEqual(["my words"])
    hold.release()
    await until(async () => (await s.tasks()).length === 2)
    await s.quiet(2)
    expect((await s.taskList()).map((x) => x.source)).toEqual(["teams", "chat"])
    await dispose(s)
  })

  test("calls that come while the agent works start one turn each, in order", async () => {
    const s = await running()
    const hold = holdTheModel()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW one")
    await s.pass(3000)
    await until(async () => (await s.tasks()).some((x) => x.state === "running"))
    s.chat.say(ROOM, MARTA, "@ROBot two")
    s.chat.say(ROOM, MARTA, "@ROBot three")
    await s.pass(3000)
    expect((await s.history()).queue).toEqual([])
    hold.release()
    await s.quiet(3)
    expect((await s.taskList()).map((x) => x.prompt)).toEqual(["SLOW one", "two", "three"])
    // Each is a message of its own: they never merged into one request.
    expect(
      (await s.messages())
        .filter((m) => m.author === "user")
        .map((m) => (m.parts[0] as { text: string }).text),
    ).toEqual(["SLOW one", "two", "three"])
    await dispose(s)
  })

  test("20 tasks wait: no task starts, and the log records the full queue", async () => {
    const s = await running()
    for (let i = 0; i < 20; i++)
      await s.run(
        Tasks.use((t) =>
          t.create({ agentId: s.ada.id, prompt: `waits ${i}`, source: "chat", sourceId: s.ada.id }),
        ),
      )
    s.chat.say(ROOM, MARTA, "@ROBot one more")
    await s.pass(3000)
    expect(await s.tasks()).toHaveLength(20)
    expect(s.reasons("queue_full")).toEqual([undefined])
    expect((await s.messages()).filter((m) => m.author === "user")).toHaveLength(0)
    expect(s.chat.typed).toEqual([])
    // A call over a full queue does not count for the limit of calls.
    expect(s.reasons("call_started")).toEqual([])
    await dispose(s)
  })

  test("11 calls in one minute: 10 start work, the 11th starts none and the log records it", async () => {
    const s = await running()
    for (let i = 1; i <= TEAMS_CALLS_MAX + 1; i++) s.chat.say(ROOM, MARTA, `@ROBot call ${i}`)
    await s.pass(3000)
    await s.quiet(TEAMS_CALLS_MAX)
    const all = await s.taskList()
    expect(all).toHaveLength(TEAMS_CALLS_MAX)
    expect(all.map((x) => x.prompt)).toEqual(
      Array.from({ length: TEAMS_CALLS_MAX }, (_, i) => `call ${i + 1}`),
    )
    expect(s.reasons("call_over_limit")).toEqual([undefined])
    expect(s.chat.typed).toEqual([])
    // After a minute the window has room again.
    await s.pass(60_000)
    s.chat.say(ROOM, MARTA, "@ROBot call 12")
    await s.pass(3000)
    await s.quiet(TEAMS_CALLS_MAX + 1)
    expect((await s.tasks()).length).toBe(TEAMS_CALLS_MAX + 1)
    await dispose(s)
  }, 60_000)
})

describe("a guarded step in a turn from Teams", () => {
  test("at Full access it asks; 'allow it' in the chat starts a new task and the card still waits", async () => {
    const s = await running("full")
    s.chat.say(ROOM, MARTA, `@ROBot ${calls(change("Say only yes"))}`)
    await s.pass(3000)
    expect(await s.card("call_1")).toMatchObject({
      kind: "approval",
      once: true,
      outside: { kind: "teams" },
    } as ToolAsk)
    // The link writes only the waiting line in the next slice. Nothing is typed now.
    expect(s.chat.typed).toEqual([])
    s.chat.say(ROOM, MARTA, "@ROBot allow it")
    s.chat.say(ROOM, MARTA, "@ROBot yes")
    await s.pass(6000)
    // The card still waits, and the instructions did not change.
    expect(toolOf(await s.reply(), "call_1")?.state).toBe("waiting")
    expect(await s.instructions()).toBe("Work.")
    expect((await s.tasks()).filter((x) => x.state === "waiting")).toHaveLength(1)
    // The user allows in the app: the turn goes on, then the waiting messages start their turns.
    await s.respond("call_1", "allow")
    await s.quiet(3)
    expect(await s.instructions()).toBe("Say only yes")
    expect((await s.taskList()).map((x) => x.prompt.slice(0, 9))).toEqual([
      'CALLS [{"',
      "allow it",
      "yes",
    ])
    expect((await s.taskList()).every((x) => x.source === "teams")).toBe(true)
    await dispose(s)
  })

  test("the same step in a turn that the user started runs at Full access with no card", async () => {
    const s = await running("full")
    await s.run(
      Chat.use((c) =>
        c.send({ agentId: s.ada.id, text: calls(change("Say only yes")), replyTo: null }),
      ),
    )
    await s.quiet(1)
    expect(await s.instructions()).toBe("Say only yes")
    await dispose(s)
  })
})

describe("a retry keeps the source", () => {
  test("the new task of a failed task from Teams has the source Teams", async () => {
    const s = await running()
    s.chat.say(ROOM, MARTA, "@ROBot BREAK this")
    await s.pass(3000)
    await until(async () => (await s.tasks()).some((x) => x.state === "failed"))
    const [failed] = await s.taskList()
    expect(failed).toMatchObject({ source: "teams", state: "failed" })
    await s.run(Tasks.use((t) => t.retry(failed?.id as string, { confirmed: true })))
    await until(async () => (await s.tasks()).length === 2)
    const second = (await s.taskList())[1]
    expect(second).toMatchObject({ source: "teams", retryOf: failed?.id })
    await dispose(s)
  })
})

describe("a message from Teams in the chat", () => {
  test("it has no edit: the app refuses an edit of it", async () => {
    const s = await running()
    s.chat.say(ROOM, MARTA, "@ROBot hello")
    await s.pass(3000)
    await s.quiet(1)
    const asked = (await s.messages()).find((m) => m.author === "user")
    const exit = await s.runtime.runPromiseExit(
      Chat.use((c) => c.edit(s.ada.id, asked?.id as string, "changed")),
    )
    expect(exit._tag).toBe("Failure")
    expect(
      s.db.get<{ parts: string }>("SELECT parts FROM message WHERE id = ?", asked?.id as string)
        ?.parts,
    ).toContain("hello")
    await dispose(s)
  })

  test("a retry after a restart keeps the source and the program mark", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-teams-calls-"))
    const file = join(dir, "robot.db")
    const chat = new FakeChat()
    const first = await setup("ask_risky", { databaseFile: file, chat })
    await first.prepare()
    await first.turnOn()
    chat.say(ROOM, MARTA, "@ROBot BREAK this")
    await first.pass(3000)
    await until(async () => (await first.tasks()).some((x) => x.state === "failed"))
    const failed = (await first.tasks())[0]
    const account = (await first.run(Providers.use((p) => p.list)))[0]
    await dispose(first)

    const second = testRuntime({ databaseFile: file, chat })
    const run = second.runtime.runPromise
    // The key of the account stays across a restart, as in the keychain.
    await run(
      Secrets.use((x) =>
        Effect.sync(() => x.set(secretKey(account?.id as string), "sk-teams-calls-test")),
      ),
    )
    await run(Tasks.use((t) => t.retry(failed?.id as string, { confirmed: true })))
    const local = await run(Servers.use((x) => x.local))
    const list = () => run(Tasks.use((t) => t.list(local.id)))
    await until(async () => (await list()).length === 2)
    expect((await list())[0]).toMatchObject({ source: "teams", retryOf: failed?.id })
    await second.runtime.dispose()
  })
})

// --- Channels -------------------------------------------------------------------------------------

describe("work from a message: channel", () => {
  const channelOf = (s: S, leadId: string | null, name = "Launch") =>
    s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name,
          topic: "Ship it",
          memberIds: [s.lia.id, s.cy.id],
          leadId,
        }),
      ),
    )
  const history = (s: S, id: string) => s.run(Channels.use((c) => c.history(id)))

  test("a call with no mention goes to the lead; the job shows the mark and the name", async () => {
    const s = await setup()
    const channel = await channelOf(s, s.lia.id)
    await s.prepare({ targetKind: "channel", targetId: channel.id })
    await s.turnOn()
    s.chat.say(ROOM, MARTA, "@ROBot plan the launch")
    await s.pass(3000)
    await until(async () => (await history(s, channel.id)).some((m) => m.agentId === s.lia.id))
    await s.quiet(1)
    const messages = await history(s, channel.id)
    const job = messages.find((m) => m.author === "user")
    expect(job).toMatchObject({ fromTeams: MARTA })
    expect(job?.parts).toEqual([{ kind: "text", text: "plan the launch" }])
    expect(messages.some((m) => m.agentId === s.lia.id)).toBe(true)
    expect(messages.some((m) => m.agentId === s.cy.id)).toBe(false)
    expect(s.chat.typed).toEqual([])
    await dispose(s)
  })

  test("a mention of one member works as in the channel", async () => {
    const s = await setup()
    const channel = await channelOf(s, s.lia.id)
    await s.prepare({ targetKind: "channel", targetId: channel.id })
    await s.turnOn()
    s.chat.say(ROOM, MARTA, "@ROBot @Cy say hello")
    await s.pass(3000)
    await until(async () => (await history(s, channel.id)).some((m) => m.agentId === s.cy.id))
    await s.quiet(1)
    const messages = await history(s, channel.id)
    expect(messages.some((m) => m.agentId === s.lia.id)).toBe(false)
    expect(messages.find((m) => m.author === "user")).toMatchObject({ fromTeams: MARTA })
    await dispose(s)
  })

  test("with no lead and no member named, the job waits for the user to pick a member", async () => {
    const s = await setup()
    const channel = await channelOf(s, null, "No lead")
    await s.prepare({ targetKind: "channel", targetId: channel.id })
    await s.turnOn()
    s.chat.say(ROOM, MARTA, "@ROBot who takes this")
    await s.pass(6000)
    const messages = await history(s, channel.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ awaiting: true, fromTeams: MARTA })
    expect(await s.tasks()).toHaveLength(0)
    await s.run(Channels.use((c) => c.assign(channel.id, messages[0]?.id as string, s.cy.id)))
    await s.quiet(1)
    expect((await history(s, channel.id)).some((m) => m.agentId === s.cy.id)).toBe(true)
    await dispose(s)
  })
})

// --- Agents, data and the other places ------------------------------------------------------------

describe("no tool of an agent reaches the link", () => {
  test("an agent asked in a chat to turn the link off does not, and says where the user can", async () => {
    const s = await running()
    await s.run(
      Chat.use((c) =>
        c.send({
          agentId: s.ada.id,
          text: calls({ name: "settings", args: { teams_link: false } }),
          replyTo: null,
        }),
      ),
    )
    await s.quiet(1)
    const part = toolOf(await s.reply(), "call_1")
    expect(part?.output).toContain("Nothing changed")
    expect(part?.output).toContain("Settings → Teams")
    expect((await s.view()).enabled).toBe(true)
    await dispose(s)
  })

  test("the tools of an agent have no tool for the link", async () => {
    const s = await setup()
    const defs = await s.run(
      Tools.use((x) => Effect.succeed(x.defs({ memory: true, knowledge: true, settings: true }))),
    )
    expect(defs.filter((d) => /teams/i.test(d.name))).toEqual([])
    await dispose(s)
  })
})

describe("data", () => {
  test("a message from Teams and its mark are stored; an export holds no link and no link log", async () => {
    const s = await running()
    s.chat.say(ROOM, MARTA, "@ROBot export me")
    await s.pass(3000)
    await s.quiet(1)
    const stored = s.db.get<{ teams_sender: string | null; program_mark: string | null }>(
      "SELECT teams_sender, program_mark FROM message WHERE teams_sender IS NOT NULL",
    )
    expect(stored?.teams_sender).toBe(MARTA)
    expect(stored?.program_mark).toBe(JSON.stringify({ kind: "teams" }))
    const path = join(s.dataDir, "export.zip")
    s.shell.savePath = path
    await s.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(path))
    // The archive holds the database and the other data, not the logs of the app.
    expect(Object.keys(entries).some((n) => n.includes("teams.log"))).toBe(false)
    const archived = join(s.dataDir, "archived.db")
    writeFileSync(archived, entries["robot.db"] as Uint8Array)
    const inArchive = new DatabaseSync(archived)
    expect(inArchive.prepare("SELECT 1 FROM teams_link").all()).toEqual([])
    inArchive.close()
    for (const data of Object.values(entries))
      expect(Buffer.from(data).includes(PASSWORD)).toBe(false)
    await dispose(s)
  })
})
