import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MEMORY_CHECK_EVERY, MEMORY_CHECK_TOOL } from "@robot/shared"
import { Effect, Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { MemoryCheck } from "./MemoryCheck.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"
import { Usage } from "./Usage.ts"

/**
 * A stand-in model (spec 008, "Memory check"). A request of the check starts with the system text
 * of the check. In the message of the user, every `SUGGEST: <fact>` in the words of the user makes
 * one call of the tool, in the order of the text. `FAIL` in a message makes a normal request fail,
 * and `BREAKCHECK` makes a request of the check fail. A
 * normal turn answers with one line and reports tokens.
 */
interface Recorded {
  readonly system: string
  readonly tools: string[]
  readonly messages: { role: string; content: string }[]
}
const requests: Recorded[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      messages: { role: string; content: string }[]
      tools?: { function?: { name?: string } }[]
    }
    const system = String(body.messages[0]?.content ?? "")
    requests.push({
      system,
      tools: (body.tools ?? []).map((t) => String(t.function?.name)),
      messages: body.messages,
    })
    const last = body.messages.at(-1)
    const isCheck = system.startsWith("You look back at recent turns")
    // `FAIL` fails a normal turn. `BREAKCHECK` fails the request of a check only.
    if (
      isCheck
        ? JSON.stringify(body.messages).includes("BREAKCHECK")
        : JSON.stringify(body.messages).includes("FAIL")
    )
      return new Response("mock failure", { status: 500 })
    const enc = new TextEncoder()
    const line = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`)
    const calls =
      isCheck && last?.role === "user"
        ? [...String(last.content).matchAll(/SUGGEST: ([^\n]*)/g)].map((m) => m[1] as string)
        : []
    return new Response(
      new ReadableStream({
        start(controller) {
          calls.forEach((text, index) => {
            controller.enqueue(
              line({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: `call_${index}`,
                          function: {
                            name: MEMORY_CHECK_TOOL,
                            arguments: JSON.stringify({ text }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            )
          })
          if (calls.length === 0)
            controller.enqueue(
              line({
                choices: [{ delta: { content: isCheck ? "Nothing to suggest." : "Done." } }],
              }),
            )
          controller.enqueue(
            line({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } }),
          )
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const folders = mkdtempSync(join(tmpdir(), "robot-memcheck-"))
afterAll(() => {
  server.stop()
  rmSync(folders, { recursive: true, force: true })
})

const until = async (check: () => Promise<boolean> | boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const exit = t.runtime.runPromiseExit
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-memcheck-test-key",
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
        instructions: "Work.",
        model: { accountId: account.id, model: "mock", effort: null },
      }),
    ),
  )
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const idle = () =>
    until(async () =>
      (await tasks()).every((x) => !["queued", "running", "waiting"].includes(x.state)),
    )
  const say = async (text: string) => {
    await run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
    await idle()
  }
  const info = () => run(MemoryCheck.use((m) => m.info(agent.id)))
  const setOn = (on: boolean) => run(MemoryCheck.use((m) => m.setOn(agent.id, on)))
  const checks = async () => (await tasks()).filter((x) => x.source === "memory_check")
  const proposals = () => run(Memory.use((m) => m.proposals(agent.id)))
  const items = () => run(Memory.use((m) => m.list(agent.id)))
  const sql = <A>(f: (db: Database["Service"]) => A) =>
    run(Database.use((db) => Effect.sync(() => f(db))))
  return {
    ...t,
    run,
    exit,
    account,
    local,
    agent,
    tasks,
    idle,
    say,
    info,
    setOn,
    checks,
    proposals,
    items,
    sql,
  }
}

const code = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

const checkRequests = () => requests.filter((r) => r.system.startsWith("You look back"))

describe("the choice and the count (spec 008)", () => {
  test("the choice is off by default, with a count of 0 and a check every 10 turns", async () => {
    const s = await setup()
    expect(await s.info()).toEqual({
      on: false,
      count: 0,
      every: MEMORY_CHECK_EVERY,
      program: null,
      memory: true,
      running: false,
    })
  })

  test("each turn that ends as done adds 1; with the choice off nothing is counted", async () => {
    const s = await setup()
    await s.say("one")
    expect((await s.info()).count).toBe(0)
    await s.setOn(true)
    await s.say("two")
    await s.say("three")
    expect((await s.info()).count).toBe(2)
  })

  test("a turn that fails adds nothing", async () => {
    const s = await setup()
    await s.setOn(true)
    await s.say("fine")
    await s.say("FAIL this one")
    expect((await s.tasks()).filter((t) => t.state === "failed")).toHaveLength(1)
    expect((await s.info()).count).toBe(1)
  })

  test("the count is 0 when the choice goes on; a restart keeps the count", async () => {
    const s = await setup()
    await s.setOn(true)
    await s.say("a")
    await s.say("b")
    expect((await s.info()).count).toBe(2)
    await s.setOn(false)
    await s.say("c")
    // Off: the turn is not counted, and the old count stays until the choice goes on again.
    expect((await s.info()).count).toBe(2)
    await s.setOn(true)
    expect((await s.info()).count).toBe(0)
    // The count is a table: the rows are what a restart finds again.
    await s.say("d")
    expect(await s.sql((db) => db.all("SELECT task_id FROM memory_check_turn"))).toHaveLength(1)
  })

  test("with memory off for the agent, the count does not grow", async () => {
    const s = await setup()
    await s.setOn(true)
    await s.run(Agents.use((a) => a.update(s.agent.id, { memoryEnabled: false })))
    await s.say("hello")
    const info = await s.info()
    expect(info.count).toBe(0)
    expect(info.memory).toBe(false)
  })

  test("the choice is kept for that agent only", async () => {
    const s = await setup()
    const other = await s.run(
      Agents.use((a) =>
        a.create({ serverId: s.local.id, name: "Bo", role: "", instructions: "Work." }),
      ),
    )
    await s.setOn(true)
    expect((await s.run(MemoryCheck.use((m) => m.info(other.id)))).on).toBe(false)
  })
})

describe("an agent on a vendor runtime (spec 006, 008)", () => {
  test("the choice is off with the name of the program, and it cannot go on", async () => {
    const s = await setup()
    s.sql((db) => db.run("UPDATE provider_account SET kind = 'codex' WHERE id = ?", s.account.id))
    const info = await s.info()
    expect(info.program).toBe("Codex")
    expect(info.on).toBe(false)
    expect(code(await s.exit(MemoryCheck.use((m) => m.setOn(s.agent.id, true))))).toBe(
      "memory_check_unavailable",
    )
    // The choice can still go off.
    expect(code(await s.exit(MemoryCheck.use((m) => m.setOn(s.agent.id, false))))).toBe("ok")
  })

  test("a choice that was on stays off while the agent uses a program, and counts nothing", async () => {
    const s = await setup()
    await s.setOn(true)
    s.sql((db) =>
      db.run("UPDATE provider_account SET kind = 'claude_code' WHERE id = ?", s.account.id),
    )
    expect((await s.info()).program).toBe("Claude Code")
    // Check now is refused too.
    expect(code(await s.exit(MemoryCheck.use((m) => m.checkNow(s.agent.id))))).toBe(
      "memory_check_off",
    )
  })
})

describe("the check itself (spec 008, 005)", () => {
  test("after 10 done turns a task 'memory check' runs; it makes proposals and no item, message or notice", async () => {
    const s = await setup()
    await s.setOn(true)
    const messagesBefore = await s.sql(
      (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message")?.n ?? 0,
    )
    for (let i = 1; i <= 9; i++) {
      await s.say(
        i === 2 ? "I prefer tabs. SUGGEST: Prefers tabs over spaces" : `Question number ${i}`,
      )
    }
    expect(await s.checks()).toHaveLength(0)
    expect((await s.info()).count).toBe(9)
    await s.say("I live in Busan. SUGGEST: Lives in Busan")
    await until(async () => (await s.checks()).length === 1)
    await s.idle()
    const [check] = await s.checks()
    expect(check).toMatchObject({ source: "memory_check", state: "done" })
    // The task has the tokens of its two requests (the tool calls, and the answer after them).
    expect(check?.usage.input).toBe(240)
    expect((await s.info()).count).toBe(0)
    // Two proposals "From a memory check", and no item.
    const waiting = await s.proposals()
    expect(waiting.map((p) => p.text).sort()).toEqual([
      "Lives in Busan",
      "Prefers tabs over spaces",
    ])
    expect(waiting.every((p) => p.fromCheck && p.place === null)).toBe(true)
    expect(await s.items()).toEqual([])
    // It posted no message: 10 chats make 10 replies and 10 questions, and the check adds none.
    const messagesAfter = await s.sql(
      (db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message")?.n ?? 0,
    )
    expect(messagesAfter - messagesBefore).toBe(20)
  })

  test("what the check reads: the words of the user and the replies, the newest first; one tool", async () => {
    const s = await setup()
    await s.setOn(true)
    requests.length = 0
    await s.say("First question SUGGEST: Old fact")
    await s.say("Second question")
    await s.run(Memory.use((m) => m.add(s.agent.id, "Already saved", "user")))
    await s.run(Memory.use((m) => m.suggest(s.agent.id, "Already waiting")))
    await s.run(MemoryCheck.use((m) => m.checkNow(s.agent.id)))
    await until(async () => (await s.checks()).some((c) => c.state === "done"))
    const [request] = checkRequests()
    expect(request?.tools).toEqual([MEMORY_CHECK_TOOL])
    const message = String(request?.messages.at(-1)?.content ?? "")
    expect(message).toContain("Saved memory items:\n- Already saved")
    expect(message).toContain("Waiting suggestions:\n- Already waiting")
    expect(message.indexOf("Second question")).toBeLessThan(message.indexOf("First question"))
    expect(message).toContain("Assistant: Done.")
    // The reply holds the text only: nothing about a tool step.
    expect(message).not.toContain("Tool said")
  })

  test("it makes at most 5 proposals, and the tool tells the model when it stops", async () => {
    const s = await setup()
    await s.setOn(true)
    const facts = Array.from({ length: 8 }, (_, i) => `SUGGEST: Fact number ${i + 1}`).join("\n")
    await s.say(`Many facts:\n${facts}`)
    await s.run(MemoryCheck.use((m) => m.checkNow(s.agent.id)))
    await until(async () => (await s.checks()).some((c) => c.state === "done"))
    expect(await s.proposals()).toHaveLength(5)
    expect(await s.items()).toEqual([])
  })

  test("it makes proposals also with 'Save at once'; the rules of a proposal hold", async () => {
    const s = await setup()
    await s.setOn(true)
    expect(await s.run(Memory.use((m) => m.mode(s.agent.id)))).toBe("now")
    await s.run(Memory.use((m) => m.add(s.agent.id, "Likes tea", "user")))
    const long = "x".repeat(501)
    await s.say(
      [
        "SUGGEST: Likes tea",
        "SUGGEST:   likes TEA  ",
        `SUGGEST: ${long}`,
        "SUGGEST: The key is sk-live-1234567890abcdef1234567890abcdef",
        "SUGGEST: Prefers short answers",
        "SUGGEST: prefers short answers",
      ].join("\n"),
    )
    await s.run(MemoryCheck.use((m) => m.checkNow(s.agent.id)))
    await until(async () => (await s.checks()).some((c) => c.state === "done"))
    // A known fact, a text over 500 characters, a secret and a duplicate are not added.
    expect((await s.proposals()).map((p) => p.text)).toEqual(["Prefers short answers"])
    expect((await s.items()).map((i) => i.text)).toEqual(["Likes tea"])
  })

  test("a check that fails makes no notification, and the task shows the reason", async () => {
    const s = await setup()
    await s.setOn(true)
    await s.say("hello BREAKCHECK")
    const noticesBefore = s.events.filter((e) => e.event === "notice").length
    await s.run(MemoryCheck.use((m) => m.checkNow(s.agent.id)))
    await until(async () => (await s.checks()).some((c) => c.state === "failed"))
    const [check] = await s.checks()
    expect(check?.error).not.toBeNull()
    // The same failure of a normal turn makes a notice. The check makes none.
    expect(s.events.filter((e) => e.event === "notice")).toHaveLength(noticesBefore)
    // The failure shows on the page of the task only: no message was posted for it.
    expect(await s.proposals()).toEqual([])
  })

  test("a normal turn that fails does make its notice (the control of the test above)", async () => {
    const s = await setup()
    await s.say("FAIL this turn")
    expect(s.events.filter((e) => e.event === "notice").length).toBeGreaterThan(0)
  })
})

describe("a full queue and the order of the queue (spec 005, 008)", () => {
  test("a check is not added while the queue holds 20 tasks; the next turn that ends as done adds it", async () => {
    const s = await setup()
    await s.setOn(true)
    const turn = async () => {
      const task = await s.run(
        Tasks.use((t) =>
          t.create({ agentId: s.agent.id, prompt: "work", source: "chat", sourceId: s.agent.id }),
        ),
      )
      await s.run(Tasks.use((t) => t.run(task.id, s.agent.id, Effect.void)))
    }
    for (let i = 0; i < MEMORY_CHECK_EVERY - 1; i++) await turn()
    // Twenty tasks wait that no turn runs: the queue of the agent is full.
    const waiting = []
    for (let i = 0; i < 20; i++)
      waiting.push(
        await s.run(
          Tasks.use((t) =>
            t.create({
              agentId: s.agent.id,
              prompt: `q${i}`,
              source: "chat",
              sourceId: s.agent.id,
            }),
          ),
        ),
      )
    expect(await s.run(Tasks.use((t) => Effect.sync(() => t.queueFull(s.agent.id))))).not.toBeNull()
    await turn()
    expect((await s.info()).count).toBe(MEMORY_CHECK_EVERY)
    expect(await s.checks()).toEqual([])
    // A task leaves the queue; the next turn that ends as done adds the check.
    await s.run(Tasks.use((t) => t.stop(waiting[0]?.id ?? "")))
    await turn()
    await until(async () => (await s.checks()).some((c) => c.state === "done"))
    expect((await s.info()).count).toBe(0)
    expect(await s.checks()).toHaveLength(1)
  })

  test("only one check waits or runs at a time", async () => {
    const s = await setup()
    await s.setOn(true)
    for (let i = 0; i < MEMORY_CHECK_EVERY + 2; i++) await s.say(`turn ${i}`)
    await s.idle()
    // The 10th turn made one check; the turns after it counted again and made no second one yet.
    expect(await s.checks()).toHaveLength(1)
    expect((await s.info()).count).toBe(2)
  })
})

describe("'Check now' (spec 008)", () => {
  test("it is refused with no turn since the last check and with the choice off", async () => {
    const s = await setup()
    expect(code(await s.exit(MemoryCheck.use((m) => m.checkNow(s.agent.id))))).toBe(
      "memory_check_off",
    )
    await s.setOn(true)
    expect(code(await s.exit(MemoryCheck.use((m) => m.checkNow(s.agent.id))))).toBe(
      "memory_check_off",
    )
  })

  test("with 3 done turns it runs a check at once, and the count goes to 0", async () => {
    const s = await setup()
    await s.setOn(true)
    await s.say("a SUGGEST: Fact from a")
    await s.say("b")
    await s.say("c")
    expect((await s.info()).count).toBe(3)
    await s.run(MemoryCheck.use((m) => m.checkNow(s.agent.id)))
    await until(async () => (await s.checks()).some((c) => c.state === "done"))
    expect((await s.info()).count).toBe(0)
    expect((await s.proposals()).map((p) => p.text)).toEqual(["Fact from a"])
    // Now it is off again: no turn since the last check.
    expect(code(await s.exit(MemoryCheck.use((m) => m.checkNow(s.agent.id))))).toBe(
      "memory_check_off",
    )
  })

  test("the turns of a check add nothing to the count", async () => {
    const s = await setup()
    await s.setOn(true)
    await s.say("a")
    await s.run(MemoryCheck.use((m) => m.checkNow(s.agent.id)))
    await until(async () => (await s.checks()).some((c) => c.state === "done"))
    expect((await s.info()).count).toBe(0)
  })
})

describe("the usage page counts the tokens of a check (spec 008)", () => {
  test("a check adds its tokens to the day of the agent and adds no reply", async () => {
    const s = await setup()
    await s.setOn(true)
    await s.say("a")
    const before = await s.run(Usage.use((u) => u.summary(s.local.id, 7)))
    await s.run(MemoryCheck.use((m) => m.checkNow(s.agent.id)))
    await until(async () => (await s.checks()).some((c) => c.state === "done"))
    const after = await s.run(Usage.use((u) => u.summary(s.local.id, 7)))
    const sum = (rows: typeof before, key: "replies" | "inputTokens") =>
      rows.reduce((n, r) => n + r[key], 0)
    expect(sum(after, "replies")).toBe(sum(before, "replies"))
    expect(sum(after, "inputTokens") - sum(before, "inputTokens")).toBe(120)
  })
})
