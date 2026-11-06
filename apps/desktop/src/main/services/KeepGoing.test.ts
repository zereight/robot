import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { KEEP_GOING_MAX, KEEP_GOING_MESSAGE, type MessagePart, messageText } from "@robot/shared"
import { Effect } from "effect"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// "Keep going on open steps" (spec 005). A stand-in Claude Code program reports a list of steps,
// and the app asks it to go on while steps are open. The decision comes from the list only.

let fake: FakeRuntimes
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  fake = makeFakeRuntimes()
  saved.ROBOT_CLAUDE_BIN = process.env.ROBOT_CLAUDE_BIN
  process.env.ROBOT_CLAUDE_BIN = fake.claude
  fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
})
afterAll(() => {
  if (saved.ROBOT_CLAUDE_BIN === undefined) delete process.env.ROBOT_CLAUDE_BIN
  else process.env.ROBOT_CLAUDE_BIN = saved.ROBOT_CLAUDE_BIN
})

const until = async (check: () => Promise<boolean> | boolean, ms = 30_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out")
}

/** The turns that the program got so far: the text it was asked. */
const prompts = () =>
  fake
    .claudeCalls()
    .filter((c) => "prompt" in c)
    .map((c) => String(c.prompt))

type KeptLine = Extract<MessagePart, { kind: "note"; note: "kept_going" }>
const keptLines = (parts: readonly MessagePart[]) =>
  parts.filter((p): p is KeptLine => p.kind === "note" && p.note === "kept_going")

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) => p.connect({ kind: "claude_code", name: "Claude" })),
  )
  const local = await run(Servers.use((s) => s.local))
  const make = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: `You are ${name}.`,
          model: { accountId: account.id, model: "sonnet", effort: null },
        }),
      ),
    )
  const ada = await make("Ada")
  const history = () => run(Chat.use((c) => c.history(ada.id)))
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: ada.id, text, replyTo: null })))
  const settled = () =>
    until(async () => {
      const h = await history()
      return (
        h.messages.length > 0 &&
        h.messages.every((m) => m.status !== "streaming") &&
        h.queue.length === 0
      )
    })
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const reply = async () => (await history()).messages.at(-1)
  return { t, run, local, ada, make, history, send, settled, tasks, reply }
}

describe("keep going on open steps (spec 005)", () => {
  test("two open steps: the app asks once, the program closes them, one task ends Done", async () => {
    const before = prompts().length
    const s = await setup()
    await s.send("PLAN:close please")
    await s.settled()
    const sent = prompts().slice(before)
    expect(sent).toHaveLength(2)
    // The second message is the go-on message with the open steps. It is no message of the user.
    expect(sent[1]).toContain(KEEP_GOING_MESSAGE)
    expect(sent[1]).toContain("- Fix the bug")
    expect(sent[1]).toContain("- Run the suite")
    expect(sent[0]).not.toContain(KEEP_GOING_MESSAGE)
    const { messages } = await s.history()
    expect(messages.map((m) => m.author)).toEqual(["user", "agent"])
    expect(JSON.stringify(messages)).not.toContain(KEEP_GOING_MESSAGE)
    const reply = await s.reply()
    expect(reply?.status).toBe("done")
    expect(keptLines(reply?.parts ?? [])).toEqual([
      { kind: "note", note: "kept_going", n: 1, of: KEEP_GOING_MAX },
    ])
    // Both turns are in the one reply, and the usage of both is counted (5+10 in, 7 out each).
    expect(messageText(reply as never)).toContain("I fixed part of it.")
    expect(messageText(reply as never)).toContain("Both steps are done.")
    const tasks = await s.tasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe("done")
    const row = await s.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.get<{ input_tokens: number; output_tokens: number }>(
            "SELECT input_tokens, output_tokens FROM message WHERE id = ?",
            reply?.id ?? "",
          ),
        ),
      ),
    )
    expect(row).toEqual({ input_tokens: 30, output_tokens: 14 })
  })

  test("a turn that a continuation follows makes no notice; the end of the task makes one", async () => {
    const s = await setup()
    // No window has the focus, so a result would show a system notice (spec 015).
    s.t.shell.focused = false
    await s.send("PLAN:close please")
    await s.settled()
    expect(s.t.shell.notices).toHaveLength(1)
    expect(s.t.shell.notices[0]?.body).toContain("Both steps are done.")
  })

  test("the cards of the first turn stay when the program numbers its cards again", async () => {
    const s = await setup()
    await s.send("PLAN:close please")
    await s.settled()
    const tools = ((await s.reply())?.parts ?? []).filter((p) => p.kind === "tool")
    expect(tools.map((p) => p.name)).toEqual(["TodoWrite", "TodoWrite"])
    expect(new Set(tools.map((p) => p.id)).size).toBe(2)
  })

  test("the same open steps after the continuation: the app asked once and the task ends", async () => {
    const before = prompts().length
    const s = await setup()
    await s.send("PLAN:same please")
    await s.settled()
    expect(prompts().length - before).toBe(2)
    expect(keptLines((await s.reply())?.parts ?? [])).toHaveLength(1)
    const tasks = await s.tasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe("done")
    expect((await s.reply())?.status).toBe("done")
  })

  test("a new open step at each end: the app asks 8 times and the task ends", async () => {
    const before = prompts().length
    const s = await setup()
    await s.send("PLAN:grow please")
    await s.settled()
    expect(prompts().length - before).toBe(1 + KEEP_GOING_MAX)
    const lines = keptLines((await s.reply())?.parts ?? [])
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(lines.every((l) => l.of === 8)).toBe(true)
    const tasks = await s.tasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe("done")
  })

  test("the setting off: the first end of the turn ends the task", async () => {
    const before = prompts().length
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ keepGoing: false })))
    await s.send("PLAN:close please")
    await s.settled()
    expect(prompts().length - before).toBe(1)
    expect(keptLines((await s.reply())?.parts ?? [])).toHaveLength(0)
    expect((await s.tasks())[0]?.state).toBe("done")
  })

  test("a last line Blocked: ends the task as Blocked and nothing is sent", async () => {
    const before = prompts().length
    const s = await setup()
    await s.send("PLAN:blocked please")
    await s.settled()
    expect(prompts().length - before).toBe(1)
    expect(keptLines((await s.reply())?.parts ?? [])).toHaveLength(0)
    expect((await s.tasks())[0]?.state).toBe("blocked")
  })

  test("a question in the reply with no open step: nothing is sent", async () => {
    const before = prompts().length
    const s = await setup()
    await s.send("PLAN:doneask please")
    await s.settled()
    expect(prompts().length - before).toBe(1)
    expect(messageText((await s.reply()) as never)).toContain("Shall I continue?")
    expect(keptLines((await s.reply())?.parts ?? [])).toHaveLength(0)
  })

  test("the same question with one open step: the go-on message tells the agent to use a question card and the app sends no yes", async () => {
    const before = prompts().length
    const s = await setup()
    await s.send("PLAN:ask please")
    await s.settled()
    const sent = prompts().slice(before)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain("question card")
    expect(sent[1]).toContain("Do not ask in plain text")
    expect(sent[1]).not.toMatch(/\byes\b/i)
    // The chat holds the one message of the user and nothing else of the user.
    const { messages } = await s.history()
    expect(messages.filter((m) => m.author === "user")).toHaveLength(1)
  })

  test("an agent that reports no list: nothing is sent", async () => {
    const before = prompts().length
    const s = await setup()
    await s.send("hello there")
    await s.settled()
    expect(prompts().length - before).toBe(1)
    expect(keptLines((await s.reply())?.parts ?? [])).toHaveLength(0)
  })
})
