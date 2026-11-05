import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ORG_LIMIT_CODE } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Database } from "./Database.ts"
import { Organizations } from "./Organizations.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// The daily token limit of an organization (spec 030, "Daily token limit"; spec 005, "Blocked"): the
// count over every source, the line at 80%, a task that the limit stops ends as Blocked with no
// turn, the limit of a higher organization, the direct chat that is never stopped, the usage page,
// and the retry after a raise.

/**
 * A stand-in provider. The last message of the user says what the request reports: `USAGE 41000`
 * is 41,000 tokens in all, 10 of them output. It counts the requests that it gets.
 */
let requests = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    requests++
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const lastUser = body.messages.findLastIndex((m) => m.role === "user")
    const ask = String(body.messages[lastUser]?.content ?? "")
    const tokens = Number(/USAGE (\d+)/.exec(ask)?.[1] ?? 0)
    const enc = new TextEncoder()
    const line = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`)
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(line({ choices: [{ delta: { content: "Done." } }] }))
          if (tokens > 0)
            controller.enqueue(
              line({ choices: [], usage: { prompt_tokens: tokens - 10, completion_tokens: 10 } }),
            )
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const folders = mkdtempSync(join(tmpdir(), "robot-orglimit-"))
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

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-limit-test-key",
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
  const org = (
    name: string,
    memberIds: string[],
    extra: { parentId?: string | null; dailyTokenLimit?: number | null } = {},
  ) =>
    run(
      Organizations.use((o) =>
        o.create({ serverId: local.id, name, memberIds, leadId: null, ...extra }),
      ),
    )
  const setLimit = (id: string, dailyTokenLimit: number | null) =>
    run(Organizations.use((o) => o.update(id, { dailyTokenLimit })))
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const idle = () =>
    until(async () =>
      (await tasks()).every((x) => !["queued", "running", "waiting"].includes(x.state)),
    )
  // The place of the jobs. A channel is no part of the limit: its members only give the mentions.
  let place: string | undefined
  const placeFor = async () => {
    if (place) return place
    const all = await run(Agents.use((a) => a.list(local.id, false)))
    const made = await run(
      Channels.use((c) =>
        c.create({
          serverId: local.id,
          name: "Work",
          topic: "",
          memberIds: all.map((a) => a.id),
          leadId: null,
        }),
      ),
    )
    place = made.id
    return place
  }
  /** A mention in the channel "Work": the member answers, and the reply reports `tokens`. Gives the new task. */
  const mention = async (name: string, tokens: number) => {
    const channelId = await placeFor()
    const before = new Set((await tasks()).map((x) => x.id))
    await run(Channels.use((c) => c.send(channelId, `@${name} work USAGE ${tokens}`)))
    await idle()
    return (await tasks()).find((x) => !before.has(x.id))
  }
  /** A message in the direct chat of the agent (a task with the source "chat"). */
  const chat = async (agentId: string, tokens: number) => {
    const { Chat } = await import("./Chat.ts")
    const before = new Set((await tasks()).map((x) => x.id))
    await run(Chat.use((c) => c.send({ agentId, text: `hello USAGE ${tokens}`, replyTo: null })))
    await idle()
    return (await tasks()).find((x) => !before.has(x.id))
  }
  /** A task of another source, started at once: the one place where a task starts decides. */
  const started = async (
    agentId: string,
    source: "routine" | "workflow" | "agent" | "question",
  ) => {
    const made = await run(
      Tasks.use((x) => x.create({ agentId, prompt: "p", source, sourceId: null })),
    )
    await run(Tasks.use((x) => Effect.exit(x.run(made.id, agentId, Effect.void))))
    return (await tasks()).find((x) => x.id === made.id)
  }
  const limit = (orgId: string) => run(Organizations.use((o) => o.limit(orgId)))
  const usage = () => run(Organizations.use((o) => o.usage(local.id)))
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  return {
    ...t,
    run,
    local,
    agent,
    org,
    setLimit,
    tasks,
    idle,
    mention,
    chat,
    started,
    limit,
    usage,
    sql,
  }
}

describe("the count and the line at 80%", () => {
  test("the tasks of the members and of the lower organizations count, from today only (spec 030 'What counts')", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.org("Product", [ada.id], { dailyTokenLimit: 100_000 })
    const docs = await s.org("Docs", [bo.id], { parentId: product.id })
    expect((await s.limit(docs.id)).used).toBe(0)

    await s.mention("Bo", 20_000)
    await s.mention("Ada", 5_000)
    // The tokens of Docs count for Product. The tokens of Product do not count for Docs.
    expect((await s.limit(product.id)).used).toBe(25_000)
    expect((await s.limit(docs.id)).used).toBe(20_000)

    // A task that started yesterday is another day, and it counts for no limit of today.
    const old = (await s.tasks()).find((x) => x.agentId === bo.id)
    await s.sql(
      "UPDATE task SET started_at = ?, created_at = ? WHERE id = ?",
      Date.now() - 36 * 3_600_000,
      Date.now() - 36 * 3_600_000,
      old?.id ?? "",
    )
    expect((await s.limit(product.id)).used).toBe(5_000)
  })

  test("every source counts: a chat, a routine, a message of another agent (spec 030 'What counts')", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { dailyTokenLimit: 500_000 })
    await s.mention("Ada", 1_000)
    await s.chat(ada.id, 2_000)
    for (const [i, source] of (["routine", "agent", "workflow", "question"] as const).entries()) {
      const made = await s.run(
        Tasks.use((x) => x.create({ agentId: ada.id, prompt: "p", source, sourceId: null })),
      )
      await s.run(
        Tasks.use((x) => Effect.sync(() => x.addSpent(made.id, { input: 100 * (i + 1) }))),
      )
    }
    expect((await s.limit(docs.id)).used).toBe(1_000 + 2_000 + 100 + 200 + 300 + 400)
  })

  test("an agent counts once in an organization, also when it is in a lower one too", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const product = await s.org("Product", [ada.id], { dailyTokenLimit: 100_000 })
    await s.org("Docs", [ada.id], { parentId: product.id })
    await s.mention("Ada", 7_000)
    expect((await s.limit(product.id)).used).toBe(7_000)
  })

  test("a task that came with a sync counts like a task of this computer, and it can stop a new task here (spec 019, 030)", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    // A row as the sync of tasks writes it: the agent, the tokens, and the start time of the other
    // computer. The count reads the row, not the computer that ran it.
    const synced = async (tokens: number) => {
      const made = await s.run(
        Tasks.use((x) =>
          x.create({
            agentId: ada.id,
            prompt: "from MacBook 2",
            source: "routine",
            sourceId: null,
          }),
        ),
      )
      await s.sql(
        "UPDATE task SET state = 'done', started_at = ?, input_tokens = ?, output_tokens = 0 WHERE id = ?",
        Date.now() - 60_000,
        tokens,
        made.id,
      )
    }
    await synced(41_000)
    expect(await s.limit(docs.id)).toMatchObject({ used: 41_000, state: "near" })
    // With the tokens of this computer on top, the limit is used and the next task is blocked.
    await s.mention("Ada", 10_000)
    expect(await s.limit(docs.id)).toMatchObject({ used: 51_000, state: "over" })
    expect((await s.mention("Ada", 100))?.state).toBe("blocked")
  })

  test("at 80% the form shows the line, and nothing is blocked yet", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    await s.mention("Ada", 39_999)
    expect(await s.limit(docs.id)).toMatchObject({ used: 39_999, state: "ok" })
    const near = await s.mention("Ada", 1_001)
    expect(near?.state).toBe("done")
    expect(await s.limit(docs.id)).toMatchObject({ used: 41_000, state: "near" })
    // It makes no notification: no blocked task.
    expect((await s.tasks()).some((x) => x.state === "blocked")).toBe(false)
  })

  test("an organization with no limit shows no line, however much it used", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id])
    await s.mention("Ada", 900_000)
    expect(await s.limit(docs.id)).toMatchObject({ limit: null, state: "ok" })
    expect((await s.mention("Ada", 10))?.state).toBe("done")
  })

  test("an archived member is skipped while it is archived (spec 030 'Member')", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const docs = await s.org("Docs", [ada.id, bo.id], { dailyTokenLimit: 50_000 })
    await s.mention("Bo", 30_000)
    await s.mention("Ada", 1_000)
    await s.run(Agents.use((a) => a.archive(bo.id)))
    expect((await s.limit(docs.id)).used).toBe(1_000)
  })
})

describe("at the limit", () => {
  test("the turn that runs goes to its end; the next task ends as Blocked with no turn (spec 030, 005 'Blocked')", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    await s.mention("Ada", 41_000)
    // A part reaches 51,000: the turn goes to its end, and its tokens count.
    const over = await s.mention("Ada", 51_000)
    expect(over?.state).toBe("done")
    expect((await s.limit(docs.id)).used).toBe(92_000)

    const asked = requests
    const blocked = await s.mention("Ada", 500)
    expect(blocked?.state).toBe("blocked")
    expect(blocked?.error).toEqual({ code: ORG_LIMIT_CODE, detail: "Docs" })
    // The model got no request, and the task never ran: it has no start time.
    expect(requests).toBe(asked)
    expect(blocked?.startedAt ?? null).toBeNull()
  })

  test("a task of any other source is blocked too: routine, workflow, agent, question", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.org("Docs", [ada.id], { dailyTokenLimit: 10_000 })
    await s.mention("Ada", 12_000)
    for (const source of ["routine", "workflow", "agent", "question"] as const) {
      const task = await s.started(ada.id, source)
      expect(task?.state).toBe("blocked")
      expect(task?.error).toEqual({ code: ORG_LIMIT_CODE, detail: "Docs" })
    }
  })

  test("Retry works after the user raises the limit", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    await s.mention("Ada", 51_000)
    const blocked = await s.mention("Ada", 500)
    expect(blocked?.state).toBe("blocked")

    // While the limit is used, a retry is blocked again.
    await s.run(Tasks.use((x) => x.retry(blocked?.id ?? "")))
    await s.idle()
    expect((await s.tasks()).filter((x) => x.state === "blocked")).toHaveLength(2)

    await s.setLimit(docs.id, 100_000)
    const asked = requests
    await s.run(Tasks.use((x) => x.retry(blocked?.id ?? "")))
    await s.idle()
    expect(requests).toBeGreaterThan(asked)
    expect((await s.tasks()).filter((x) => x.state === "done").length).toBeGreaterThanOrEqual(2)
  })

  test("Retry works after the next midnight: the tokens of yesterday no longer count", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.org("Docs", [ada.id], { dailyTokenLimit: 10_000 })
    const used = await s.mention("Ada", 12_000)
    const blocked = await s.mention("Ada", 5)
    expect(blocked?.state).toBe("blocked")
    // The day changes: the tokens move to yesterday.
    const yesterday = Date.now() - 36 * 3_600_000
    await s.sql(
      "UPDATE task SET started_at = ?, created_at = ? WHERE id = ?",
      yesterday,
      yesterday,
      used?.id ?? "",
    )
    await s.run(Tasks.use((x) => x.retry(blocked?.id ?? "")))
    await s.idle()
    expect((await s.tasks()).filter((x) => x.state === "done")).toHaveLength(2)
  })

  test("a limit that is turned off lets the task run", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { dailyTokenLimit: 10_000 })
    await s.mention("Ada", 12_000)
    expect((await s.mention("Ada", 5))?.state).toBe("blocked")
    await s.setLimit(docs.id, null)
    expect((await s.mention("Ada", 5))?.state).toBe("done")
  })

  test("the limit of a higher organization stops the members of its lower organizations; the reason names it", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.org("Product", [ada.id], { dailyTokenLimit: 50_000 })
    const docs = await s.org("Docs", [bo.id], { parentId: product.id })
    await s.org("Site", [], { parentId: docs.id })
    await s.mention("Bo", 30_000)
    await s.mention("Ada", 25_000)
    expect((await s.limit(product.id)).used).toBe(55_000)

    const blocked = await s.mention("Bo", 100)
    expect(blocked?.state).toBe("blocked")
    expect(blocked?.error).toEqual({ code: ORG_LIMIT_CODE, detail: "Product" })
    // Product itself is stopped by its own limit.
    expect((await s.mention("Ada", 100))?.error?.detail).toBe("Product")
  })

  test("the limit of a lower organization does not stop a higher organization or a sibling", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const cy = await s.agent("Cy")
    const product = await s.org("Product", [ada.id])
    await s.org("Docs", [bo.id], { parentId: product.id, dailyTokenLimit: 10_000 })
    await s.org("Ops", [cy.id], { parentId: product.id })
    await s.mention("Bo", 20_000)
    expect((await s.mention("Bo", 5))?.state).toBe("blocked")
    expect((await s.mention("Ada", 5))?.state).toBe("done")
    expect((await s.mention("Cy", 5))?.state).toBe("done")
  })

  test("more than one limit is used: the reason names the first organization in the order of names, ignoring case", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    await s.org("zeta", [ada.id], { dailyTokenLimit: 10_000 })
    await s.org("Alpha", [ada.id, bo.id], { dailyTokenLimit: 10_000 })
    await s.mention("Ada", 20_000)
    expect((await s.mention("Ada", 5))?.error?.detail).toBe("Alpha")
    // Bo is only in Alpha, which counts the tokens of Ada too.
    expect((await s.mention("Bo", 5))?.error?.detail).toBe("Alpha")
  })

  test("an agent in two organizations is stopped by the limit of either one", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    await s.org("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    await s.org("Ops", [ada.id, bo.id], { dailyTokenLimit: 10_000 })
    await s.mention("Bo", 12_000)
    expect((await s.mention("Ada", 5))?.error?.detail).toBe("Ops")
  })

  test("an agent in no organization has no limit", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    await s.agent("Bo")
    await s.org("Docs", [ada.id], { dailyTokenLimit: 10_000 })
    await s.mention("Bo", 50_000)
    expect((await s.mention("Bo", 5))?.state).toBe("done")
  })
})

describe("a direct chat", () => {
  test("is never stopped by the limit, and its tokens count (spec 030 'At the limit')", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { dailyTokenLimit: 10_000 })
    await s.mention("Ada", 12_000)
    expect((await s.mention("Ada", 5))?.state).toBe("blocked")
    const chat = await s.chat(ada.id, 3_000)
    expect(chat?.source).toBe("chat")
    expect(chat?.state).toBe("done")
    expect((await s.limit(docs.id)).used).toBe(15_000)
  })
})

describe("the usage page", () => {
  test("one row for each organization with a limit, with the tokens of today", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.org("Product", [ada.id], { dailyTokenLimit: 100_000 })
    const docs = await s.org("Docs", [bo.id], { parentId: product.id, dailyTokenLimit: 50_000 })
    await s.org("Ops", [bo.id])
    await s.mention("Bo", 20_000)
    expect(await s.usage()).toEqual([
      { orgId: docs.id, name: "Docs", used: 20_000, limit: 50_000 },
      { orgId: product.id, name: "Product", used: 20_000, limit: 100_000 },
    ])
    await s.setLimit(docs.id, null)
    expect((await s.usage()).map((r) => r.name)).toEqual(["Product"])
  })
})
