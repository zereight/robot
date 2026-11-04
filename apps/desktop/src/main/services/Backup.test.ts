import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GO_ON_MESSAGE, HOLD_UNKNOWN_MS, type MessagePart, messageText } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { holdClock } from "./ModelHolds.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// The spec 006 "Backup model": the main model reaches its limit, the main model is held, and the
// backup model takes the turn in the same task. A stand-in server plays both models.

/** What reached the server: the model, and the messages of the request. */
interface Seen {
  readonly model: string
  readonly messages: { role: string; content: string | null; tool_calls?: unknown }[]
}
const seen: Seen[] = []
const callsOf = (model: string) => seen.filter((s) => s.model === model)

const sse = (data: unknown[]) =>
  new Response(
    data.map((d) => `data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
const text = (content: string) => ({ choices: [{ delta: { content } }] })

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models"))
      return Response.json({ data: [{ id: "main-m" }, { id: "backup-m" }, { id: "other-m" }] })
    const body = (await req.json()) as Seen & { tools?: unknown }
    seen.push({ model: body.model, messages: body.messages })
    const last = body.messages.at(-1)
    // What the user asked: the last message of the user that is not the go-on message.
    const asked = [...body.messages]
      .reverse()
      .find((m) => m.role === "user" && !String(m.content).includes(GO_ON_MESSAGE))
    const request = String(asked?.content ?? "")
    const hasToolResult = body.messages.some((m) => m.role === "tool")
    if (body.model === "main-m") {
      if (request.includes("BADKEY"))
        return Response.json({ error: { message: "Incorrect API key" } }, { status: 401 })
      if (request.includes("NOTIME"))
        return Response.json(
          { error: { message: "You have hit your usage limit." } },
          { status: 429 },
        )
      if (request.includes("LIMIT"))
        return Response.json(
          { error: { message: "You have hit your usage limit." } },
          { status: 429, headers: { "retry-after": "7200" } },
        )
      if (request.includes("STEPS")) {
        // A tool step first; the next request, with its result, reaches the limit.
        if (!hasToolResult)
          return sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: {
                          name: "save_memory",
                          arguments: JSON.stringify({ text: "The step ran once" }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            "[DONE]",
          ])
        return Response.json(
          { error: { message: "You have hit your usage limit." } },
          { status: 429, headers: { "retry-after": "7200" } },
        )
      }
      return sse([text(`main answers: ${request}`), "[DONE]"])
    }
    if (body.model === "backup-m") {
      if (request.includes("BOTH"))
        return Response.json(
          { error: { message: "Your credit balance is too low to access the API." } },
          { status: 400 },
        )
      const goOn = String(last?.content ?? "").includes(GO_ON_MESSAGE)
      return sse([text(`backup answers${goOn ? " (go on)" : ""}: ${request}`), "[DONE]"])
    }
    return sse([text(`other answers: ${request}`), "[DONE]"])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

afterEach(() => {
  holdClock.now = () => Date.now()
  seen.length = 0
})

const setup = async (options: { databaseFile?: string; backup?: boolean } = {}) => {
  const t = testRuntime(options.databaseFile ? { databaseFile: options.databaseFile } : {})
  const run = t.runtime.runPromise
  const connect = (name: string) =>
    run(
      Providers.use((p) =>
        p.connect({
          kind: "custom",
          name,
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: `sk-${name}`,
        }),
      ),
    )
  const mainAccount = await connect("Main")
  const backupAccount = await connect("Backup")
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: { accountId: mainAccount.id, model: "main-m", effort: null },
        ...(options.backup === false
          ? {}
          : { backupModel: { accountId: backupAccount.id, model: "backup-m", effort: null } }),
      }),
    ),
  )
  const history = () => run(Chat.use((c) => c.history(agent.id)))
  const send = (message: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text: message, replyTo: null })))
  const settled = () =>
    until(async () => {
      const h = await history()
      return (
        h.messages.length > 0 &&
        h.messages.every((m) => m.status !== "streaming") &&
        h.queue.length === 0
      )
    })
  const current = () => run(Agents.use((a) => a.get(agent.id)))
  const lastReply = async () => (await history()).messages.at(-1)
  const lines = async () =>
    (await history()).messages.flatMap((m) =>
      m.parts.filter(
        (p): p is Extract<MessagePart, { kind: "note"; note: "backup_goes_on" }> =>
          p.kind === "note" && p.note === "backup_goes_on",
      ),
    )
  return {
    ...t,
    run,
    agent,
    local,
    mainAccount,
    backupAccount,
    history,
    send,
    settled,
    current,
    lastReply,
    lines,
  }
}

describe("backup model (spec 006)", () => {
  test("a limit before any step: the main model is held and the backup runs the turn from the start", async () => {
    const t = await setup()
    await t.send("LIMIT please")
    await t.settled()
    const reply = await t.lastReply()
    expect(reply?.status).toBe("done")
    expect(messageText(reply as never)).toBe("backup answers: LIMIT please")
    // The reply says which model made it.
    expect(reply?.model).toBe("backup-m")
    // The backup got the request, as the first request of its own, with no go-on message.
    expect(callsOf("backup-m")).toHaveLength(1)
    expect(JSON.stringify(callsOf("backup-m")[0]?.messages)).not.toContain(GO_ON_MESSAGE)
    // One task, and it ends once.
    const tasks = await t.run(Tasks.use((s) => s.list(t.local.id)))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe("done")
    // The line names both models and the reset time that the provider gave.
    const lines = await t.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.main).toBe("main-m")
    expect(lines[0]?.backup).toBe("backup-m")
    expect(lines[0]?.until).toBeGreaterThan(Date.now() + 7_000_000)
    // The agent shows the hold until that time, with the backup that takes the turns.
    const agent = await t.current()
    expect(agent.hold?.model.model).toBe("backup-m")
    expect(agent.hold?.until).toBe(lines[0]?.until as number)
    expect(agent.backupReady).toBe(true)
  })

  test("while the hold lasts the next turn uses the backup at once", async () => {
    const t = await setup()
    await t.send("LIMIT first")
    await t.settled()
    const mainCalls = callsOf("main-m").length
    await t.send("second message")
    await t.settled()
    expect(messageText((await t.lastReply()) as never)).toBe("backup answers: second message")
    expect(callsOf("main-m")).toHaveLength(mainCalls)
    // No second line: the hold was there when the turn started.
    expect(await t.lines()).toHaveLength(1)
  })

  test("a limit after a step: the backup gets the work so far and a short message, not the request again", async () => {
    const t = await setup()
    await t.send("STEPS please")
    await t.settled()
    const reply = await t.lastReply()
    expect(reply?.status).toBe("done")
    expect(messageText(reply as never)).toContain("backup answers (go on)")
    const [call] = callsOf("backup-m")
    expect(callsOf("backup-m")).toHaveLength(1)
    const last = call?.messages.at(-1)
    // The last message of the backup request is the go-on message. It is no message of the chat.
    expect(last?.role).toBe("user")
    expect(String(last?.content)).toContain(GO_ON_MESSAGE)
    // It sees the step that ran, with its result, once.
    expect(call?.messages.filter((m) => m.role === "tool")).toHaveLength(1)
    expect(JSON.stringify(call?.messages)).toContain("save_memory")
    // The chat has no row for the go-on message: a row of the user and a row of the reply.
    const { messages } = await t.history()
    expect(messages.map((m) => m.author)).toEqual(["user", "agent"])
    expect(JSON.stringify(messages)).not.toContain(GO_ON_MESSAGE)
    // The tool step stays in the reply, and the line comes after it. One task, ended once.
    const kinds = (reply?.parts ?? []).map((p) => (p.kind === "note" ? p.note : p.kind))
    expect(kinds).toContain("tool")
    expect(kinds).toContain("backup_goes_on")
    const tasks = await t.run(Tasks.use((s) => s.list(t.local.id)))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe("done")
  })

  test("a limit on both models fails the turn with the reason of the backup", async () => {
    const t = await setup()
    await t.send("LIMIT BOTH")
    await t.settled()
    const reply = await t.lastReply()
    expect(reply?.status).toBe("failed")
    expect(reply?.error?.code).toBe("provider_limit")
    // It is the reason of the backup: its credit is spent. The main limit gave no such words.
    expect(reply?.error?.detail).toContain("credit balance")
    const tasks = await t.run(Tasks.use((s) => s.list(t.local.id)))
    expect(tasks[0]?.state).toBe("failed")
  })

  test("a key that is not valid does not go to the backup", async () => {
    const t = await setup()
    await t.send("BADKEY")
    await t.settled()
    const reply = await t.lastReply()
    expect(reply?.error?.code).toBe("provider_auth")
    expect(callsOf("backup-m")).toHaveLength(0)
    expect((await t.current()).hold).toBeNull()
  })

  test("a backup that is not ready does not take the turn", async () => {
    const t = await setup()
    await t.run(Providers.use((p) => p.remove(t.backupAccount.id)))
    await t.send("LIMIT please")
    await t.settled()
    const reply = await t.lastReply()
    expect(reply?.error?.code).toBe("provider_limit")
    expect((await t.current()).hold).toBeNull()
    // The account is gone, so the agent has no backup any more.
    expect((await t.current()).backupModel).toBeNull()
  })

  test("an agent with no backup fails with the limit as before", async () => {
    const t = await setup({ backup: false })
    await t.send("LIMIT please")
    await t.settled()
    const reply = await t.lastReply()
    expect(reply?.error?.code).toBe("provider_limit")
    expect(reply?.error?.resetsAt).toBeGreaterThan(Date.now() + 7_000_000)
    expect(await t.lines()).toHaveLength(0)
  })

  test("with no reset time the hold lasts 15 minutes, and then the main model is used again", async () => {
    const t = await setup()
    const start = Date.now()
    holdClock.now = () => start
    await t.send("NOTIME")
    await t.settled()
    const agent = await t.current()
    expect(agent.hold?.until).toBe(start + HOLD_UNKNOWN_MS)
    // The line gives no reset time: the provider named none.
    expect((await t.lines())[0]?.until).toBeNull()
    // With a fake clock, past the end of the hold: the next turn goes to the main model.
    holdClock.now = () => start + HOLD_UNKNOWN_MS + 1
    expect((await t.current()).hold).toBeNull()
    const mainCalls = callsOf("main-m").length
    await t.send("fine now")
    await t.settled()
    expect(messageText((await t.lastReply()) as never)).toBe("main answers: fine now")
    expect(callsOf("main-m")).toHaveLength(mainCalls + 1)
  })

  test("Use the main model now: the next turn tries the main model; a limit again holds it with no second line", async () => {
    const t = await setup()
    await t.send("LIMIT one")
    await t.settled()
    expect((await t.current()).hold).not.toBeNull()
    const held = await t.run(Agents.use((a) => a.useMain(t.agent.id)))
    expect(held.hold).toBeNull()
    const mainCalls = callsOf("main-m").length
    await t.send("LIMIT two")
    await t.settled()
    // The main model was tried, failed with the limit again, and the backup answered.
    expect(callsOf("main-m")).toHaveLength(mainCalls + 1)
    expect(messageText((await t.lastReply()) as never)).toBe("backup answers: LIMIT two")
    expect((await t.current()).hold).not.toBeNull()
    // The chat shows no second line.
    expect(await t.lines()).toHaveLength(1)
  })

  test("Use the main model now, and the main model answers: the next limit is a new one with its line", async () => {
    const t = await setup()
    await t.send("LIMIT one")
    await t.settled()
    await t.run(Agents.use((a) => a.useMain(t.agent.id)))
    await t.send("fine now")
    await t.settled()
    expect(messageText((await t.lastReply()) as never)).toBe("main answers: fine now")
    await t.send("LIMIT again")
    await t.settled()
    expect(await t.lines()).toHaveLength(2)
  })

  test("the hold ends at once when the backup is no longer ready", async () => {
    const t = await setup()
    await t.send("LIMIT one")
    await t.settled()
    expect((await t.current()).hold).not.toBeNull()
    // The account of the backup is disconnected: nothing takes the turns.
    await t.run(Providers.use((p) => p.remove(t.backupAccount.id)))
    expect((await t.current()).hold).toBeNull()
    await t.send("tell me")
    await t.settled()
    expect(messageText((await t.lastReply()) as never)).toBe("main answers: tell me")
  })

  test("the hold stays after a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-hold-")), "robot.db")
    const first = await setup({ databaseFile: file })
    await first.send("LIMIT please")
    await first.settled()
    const until = (await first.current()).hold?.until
    expect(until).toBeGreaterThan(Date.now())
    await first.runtime.dispose()
    // The same data in a new app: the agent is still on its backup.
    const second = testRuntime({ databaseFile: file })
    const agents = await second.runtime.runPromise(Agents.use((a) => a.list(first.local.id, false)))
    expect(agents[0]?.hold?.until).toBe(until as number)
    await second.runtime.dispose()
  })

  test("a routine with its own model keeps it while the agent is on its backup", async () => {
    const t = await setup()
    await t.send("LIMIT one")
    await t.settled()
    await t.run(
      Chat.use((c) =>
        c.send(
          { agentId: t.agent.id, text: "routine job", replyTo: null },
          {
            source: "routine",
            sourceId: "r1",
            model: { accountId: t.mainAccount.id, model: "other-m", effort: null },
          },
        ),
      ),
    )
    await t.settled()
    expect(messageText((await t.lastReply()) as never)).toBe("other answers: routine job")
    // A routine that follows the agent uses the backup.
    await t.run(
      Chat.use((c) =>
        c.send(
          { agentId: t.agent.id, text: "routine two", replyTo: null },
          { source: "routine", sourceId: "r2" },
        ),
      ),
    )
    await t.settled()
    expect(messageText((await t.lastReply()) as never)).toBe("backup answers: routine two")
  })

  test("the form refuses a backup that is the same as the main choice", async () => {
    const t = await setup({ backup: false })
    const same = { accountId: t.mainAccount.id, model: "main-m", effort: null }
    const exit = await t.runtime.runPromiseExit(
      Agents.use((a) => a.update(t.agent.id, { backupModel: same })),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("backup_same")
    // The same model on another account is a different choice.
    const other = { accountId: t.backupAccount.id, model: "main-m", effort: null }
    const ok = await t.run(Agents.use((a) => a.update(t.agent.id, { backupModel: other })))
    expect(ok.backupModel?.model).toBe("main-m")
    // A new main model that equals the backup is refused too.
    const refused = await t.runtime.runPromiseExit(
      Agents.use((a) => a.update(t.agent.id, { model: other })),
    )
    expect(refused._tag).toBe("Failure")
  })

  test("a new main model ends the hold of the old one", async () => {
    const t = await setup()
    await t.send("LIMIT one")
    await t.settled()
    await t.run(
      Agents.use((a) =>
        a.update(t.agent.id, {
          model: { accountId: t.mainAccount.id, model: "other-m", effort: null },
        }),
      ),
    )
    expect((await t.current()).hold).toBeNull()
  })

  test("removing the backup ends the hold", async () => {
    const t = await setup()
    await t.send("LIMIT one")
    await t.settled()
    const agent = await t.run(Agents.use((a) => a.update(t.agent.id, { backupModel: null })))
    expect(agent.backupModel).toBeNull()
    expect(agent.hold).toBeNull()
  })
})
