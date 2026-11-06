import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cachedShare, hasUsage, tokensOf } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Providers } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

/**
 * A stand-in provider (spec 005, "Usage of a task"). The last message of the user says what each
 * request of the turn reports: `USAGE 4100,5200` is the tokens in all (10 of them output),
 * `USAGE 8000/100/6000` is input/output/cached for one request, and `USAGE none` reports nothing.
 * The words `CALL` make the model call a tool in its first request, so that a turn has 2 requests.
 */
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      messages: { role: string; content: string }[]
      tools?: unknown[]
    }
    const lastUser = body.messages.findLastIndex((m) => m.role === "user")
    const ask = String(body.messages[lastUser]?.content ?? "")
    const index = body.messages.slice(lastUser + 1).filter((m) => m.role === "tool").length
    const spec = /USAGE ([\w/,]+)/.exec(ask)?.[1]
    let usage: unknown
    if (spec && spec !== "none") {
      const list = spec.split(",")
      const entry = (list[Math.min(index, list.length - 1)] ?? "").split("/").map(Number)
      const [first = 0, second, third] = entry
      usage =
        entry.length === 1
          ? { prompt_tokens: first - 10, completion_tokens: 10 }
          : {
              prompt_tokens: first,
              completion_tokens: second ?? 0,
              ...(third !== undefined ? { prompt_tokens_details: { cached_tokens: third } } : {}),
            }
    }
    const enc = new TextEncoder()
    const line = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`)
    const calls = ask.includes("CALL") && body.tools && index === 0
    return new Response(
      new ReadableStream({
        async start(controller) {
          if (calls) {
            controller.enqueue(
              line({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          function: { name: "list_files", arguments: "{}" },
                        },
                      ],
                    },
                  },
                ],
              }),
            )
          } else {
            controller.enqueue(line({ choices: [{ delta: { content: "Done." } }] }))
          }
          if (ask.includes("SLOW")) await Bun.sleep(400)
          if (usage) controller.enqueue(line({ choices: [], usage }))
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const folders = mkdtempSync(join(tmpdir(), "robot-taskusage-"))
afterAll(() => {
  server.stop()
  rmSync(folders, { recursive: true, force: true })
})

const until = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}
const MIN = 60_000

/** Adds what a turn used to a task, as a turn does. */
const spend = (
  s: { run: <A>(e: Effect.Effect<A, never, Tasks>) => Promise<A> },
  id: string,
  spent: { input?: number; output?: number; cached?: number; costMicros?: number },
) => s.run(Tasks.use((x) => Effect.sync(() => x.addSpent(id, spent))))

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-usage-test-key",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(
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
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const idle = () =>
    until(async () =>
      (await tasks()).every((x) => !["queued", "running", "waiting"].includes(x.state)),
    )
  const send = async (agentId: string, text: string) => {
    await run(Chat.use((c) => c.send({ agentId, text, replyTo: null })))
    await idle()
    return (await tasks()).filter((x) => x.agentId === agentId).at(0)
  }
  return { run, local, account, agent, tasks, idle, send }
}

describe("usage of a task (spec 005)", () => {
  test("a turn adds its input, output and cached input to the task", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.send(ada.id, "hello USAGE 8000/100/6000")
    expect(task?.usage).toEqual({ input: 8000, output: 100, cached: 6000, costMicros: null })
    expect(cachedShare(task?.usage as never)).toBe(75)
  })

  test("a provider that reports no cached input has no cached share", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.send(ada.id, "hello USAGE 1000/200")
    expect(task?.usage).toEqual({ input: 1000, output: 200, cached: null, costMicros: null })
    expect(cachedShare(task?.usage as never)).toBeNull()
  })

  test("a provider that reports nothing leaves every number null, never 0", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.send(ada.id, "hello USAGE none")
    expect(task?.usage).toEqual({ input: null, output: null, cached: null, costMicros: null })
    expect(hasUsage(task?.usage as never)).toBe(false)
  })

  test("every request of a turn counts: two requests add up", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.send(ada.id, "look CALL USAGE 1000/100,1500/50")
    expect(task?.usage.input).toBe(2500)
    expect(task?.usage.output).toBe(150)
  })

  test("the numbers sit in the detail of the task, and a task with no child has no tree", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.send(ada.id, "hello USAGE 1000/200")
    const detail = await s.run(Tasks.use((x) => x.get(task?.id as string)))
    expect(detail.task.usage.input).toBe(1000)
    expect(detail.tree).toBeNull()
  })
})

describe("the tree of a job (spec 005)", () => {
  test("the total and one line for each agent, the largest first", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const cy = await s.agent("Cy")
    const make = (agentId: string, parentId: string | null) =>
      s.run(
        Tasks.use((x) =>
          x.create({ agentId, prompt: "p", source: "chat", sourceId: agentId, parentId }),
        ),
      )
    const lead = await make(ada.id, null)
    const one = await make(bo.id, lead.id)
    const two = await make(cy.id, lead.id)
    await spend(s, lead.id, { input: 1000, output: 200 })
    await spend(s, one.id, { input: 3000, output: 500 })
    await spend(s, two.id, { input: 3000, output: 500 })
    const detail = await s.run(Tasks.use((x) => x.get(lead.id)))
    expect(detail.tree?.total).toEqual({
      input: 7000,
      output: 1200,
      cached: null,
      costMicros: null,
    })
    expect(detail.tree?.lines.map((l) => l.agentName)).toEqual(["Bo", "Cy", "Ada"])
  })
})

describe("token limit of a routine (spec 009)", () => {
  const routine = (
    s: Awaited<ReturnType<typeof setup>>,
    agentId: string,
    prompt: string,
    limit: number | null,
  ) =>
    s.run(
      Routines.use((r) =>
        r.create({
          serverId: s.local.id,
          agentId,
          name: "Check",
          prompt,
          schedule: { kind: "every", minutes: 2, from: Date.now() },
          place: { kind: "agent" },
          tokenLimit: limit,
        }),
      ),
    )
  const tick = (s: Awaited<ReturnType<typeof setup>>, at: number) =>
    s.run(Routines.use((r) => r.tick(at)))
  const calendar = (s: Awaited<ReturnType<typeof setup>>) =>
    s.run(
      Routines.use((r) => r.calendar(s.local.id, Date.now() - 86_400_000, Date.now() + 86_400_000)),
    )

  test("the limit is saved with the routine, and a value out of range is refused", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const made = await routine(s, ada.id, "x", 5000)
    expect(made.tokenLimit).toBe(5000)
    const none = await routine(s, ada.id, "x", null)
    expect(none.tokenLimit).toBeNull()
    const refused = await routine(s, ada.id, "x", 999).then(
      () => "ok",
      (e) => e,
    )
    expect(refused).toMatchObject({ code: "invalid_token_limit" })
    const edited = await s.run(Routines.use((r) => r.update(made.id, { tokenLimit: 20_000 })))
    expect(edited.tokenLimit).toBe(20_000)
    const cleared = await s.run(Routines.use((r) => r.update(made.id, { tokenLimit: null })))
    expect(cleared.tokenLimit).toBeNull()
  })

  test("a run at 80 percent shows the line in its details and goes on", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const made = await routine(s, ada.id, "check USAGE 4100", 5000)
    await tick(s, made.createdAt + 2 * MIN + 1000)
    await s.idle()
    const entry = (await calendar(s)).find((e) => e.taskId !== null)
    expect(entry?.state).toBe("done")
    expect(tokensOf(entry?.usage as never)).toBe(4100)
    expect(entry?.limit).toEqual({ tokens: 5000, near: true })
  })

  test("a run under 80 percent has no line", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const made = await routine(s, ada.id, "check USAGE 3000", 5000)
    await tick(s, made.createdAt + 2 * MIN + 1000)
    await s.idle()
    const entry = (await calendar(s)).find((e) => e.taskId !== null)
    expect(entry?.limit).toEqual({ tokens: 5000, near: false })
  })

  test("a run with no limit has no limit info, and still shows its tokens", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const made = await routine(s, ada.id, "check USAGE 3000", null)
    await tick(s, made.createdAt + 2 * MIN + 1000)
    await s.idle()
    const entry = (await calendar(s)).find((e) => e.taskId !== null)
    expect(entry?.limit).toBeUndefined()
    expect(tokensOf(entry?.usage as never)).toBe(3000)
  })

  test("a run that reaches the limit is stopped and fails with the reason", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    // The first request reports 4100 tokens, the next 5200: together they pass 5000.
    const made = await routine(s, ada.id, "check CALL SLOW USAGE 4100,1100", 5000)
    await tick(s, made.createdAt + 2 * MIN + 1000)
    await s.idle()
    const task = (await s.tasks()).find((t) => t.source === "routine")
    expect(task?.state).toBe("failed")
    expect(task?.error).toEqual({ code: "token_limit", detail: "5000" })
    const entry = (await calendar(s)).find((e) => e.taskId === task?.id)
    expect(entry?.state).toBe("failed")
    expect(entry?.reason).toEqual({ code: "token_limit", detail: "5000" })
    // The run fails once: the routine counts it as a failed run.
    const list = await s.run(Routines.use((r) => r.list(s.local.id)))
    expect(list.find((r) => r.id === made.id)?.enabled).toBe(true)
  })

  test("three such runs in a row pause the routine", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const made = await routine(s, ada.id, "check CALL SLOW USAGE 4100,1100", 5000)
    for (let i = 1; i <= 3; i++) {
      await tick(s, made.createdAt + i * 2 * MIN + 1000)
      await s.idle()
    }
    const list = await s.run(Routines.use((r) => r.list(s.local.id)))
    const found = list.find((r) => r.id === made.id)
    expect(found?.enabled).toBe(false)
    expect(found?.pausedAfterFailures?.code).toBe("token_limit")
  })

  test("a later edit of the limit does not change a run that went", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const made = await routine(s, ada.id, "check USAGE 4100", 5000)
    await tick(s, made.createdAt + 2 * MIN + 1000)
    await s.idle()
    await s.run(Routines.use((r) => r.update(made.id, { tokenLimit: 100_000 })))
    const entry = (await calendar(s)).find((e) => e.taskId !== null)
    expect(entry?.limit).toEqual({ tokens: 5000, near: true })
  })
})
