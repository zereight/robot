import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHANNEL_LIMIT_CODE } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { ChannelTools } from "./ChannelTools.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// The daily token limit of a channel (spec 030, "Daily token limit"; spec 005, "Blocked"): the
// count, the line at 80%, a task that the limit stops ends as Blocked with no turn, the limit of a
// parent channel, and the retry after a raise.

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
const folders = mkdtempSync(join(tmpdir(), "robot-channellimit-"))
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
  const channel = (
    name: string,
    memberIds: string[],
    extra: { parentId?: string | null; dailyTokenLimit?: number | null } = {},
  ) =>
    run(
      Channels.use((c) =>
        c.create({ serverId: local.id, name, topic: "", memberIds, leadId: null, ...extra }),
      ),
    )
  const setLimit = (id: string, dailyTokenLimit: number | null) =>
    run(Channels.use((c) => c.update(id, { dailyTokenLimit })))
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const idle = () =>
    until(async () =>
      (await tasks()).every((x) => !["queued", "running", "waiting"].includes(x.state)),
    )
  /** A mention: the member answers, and the reply reports `tokens`. Gives the new task. */
  const mention = async (channelId: string, name: string, tokens: number) => {
    const before = new Set((await tasks()).map((x) => x.id))
    await run(Channels.use((c) => c.send(channelId, `@${name} work USAGE ${tokens}`)))
    await idle()
    return (await tasks()).find((x) => !before.has(x.id))
  }
  const limit = (channelId: string) => run(ChannelTools.use((c) => c.limit(channelId)))
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  return { ...t, run, local, agent, channel, setLimit, tasks, idle, mention, limit, sql }
}

describe("the field", () => {
  test("it is off at first, takes 10,000 to 100,000,000, and turns off again", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id])
    expect(docs.dailyTokenLimit).toBeNull()
    for (const bad of [9_999, 100_000_001, 12_345.5, 0, -5]) {
      const refused = await s.setLimit(docs.id, bad).then(
        () => "ok",
        (e) => (e as { code: string }).code,
      )
      expect(refused).toBe("invalid_daily_limit")
    }
    expect((await s.setLimit(docs.id, 10_000)).dailyTokenLimit).toBe(10_000)
    expect((await s.setLimit(docs.id, 100_000_000)).dailyTokenLimit).toBe(100_000_000)
    expect((await s.setLimit(docs.id, null)).dailyTokenLimit).toBeNull()
    // A new channel can have it from the start, and a bad value makes no channel.
    const made = await s.channel("Site", [ada.id], { dailyTokenLimit: 20_000 })
    expect(made.dailyTokenLimit).toBe(20_000)
    const refused = await s.channel("Bad", [ada.id], { dailyTokenLimit: 5 }).then(
      () => "ok",
      (e) => (e as { code: string }).code,
    )
    expect(refused).toBe("invalid_daily_limit")
  })

  test("a change of another field keeps the limit", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    const renamed = await s.run(Channels.use((c) => c.update(docs.id, { topic: "Pages" })))
    expect(renamed.dailyTokenLimit).toBe(50_000)
  })
})

describe("the count and the line at 80%", () => {
  test("the tokens of the tasks of the channel and of its lower channels count, from today only", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id], { dailyTokenLimit: 100_000 })
    const docs = await s.channel("Docs", [bo.id], { parentId: product.id })
    expect((await s.limit(docs.id)).used).toBe(0)

    await s.mention(docs.id, "Bo", 20_000)
    await s.mention(product.id, "Ada", 5_000)
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

  test("a hand-off to another agent does not count: it is work of that agent", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    const part = await s.mention(docs.id, "Ada", 1_000)
    // Ada sends a message to Bo, who is in no channel: the task has the source "agent".
    const handoff = await s.run(
      Tasks.use((x) =>
        x.create({
          agentId: bo.id,
          prompt: "from Ada",
          source: "agent",
          sourceId: ada.id,
          parentId: part?.id ?? null,
        }),
      ),
    )
    await s.run(Tasks.use((x) => Effect.sync(() => x.addSpent(handoff.id, { input: 30_000 }))))
    expect((await s.limit(docs.id)).used).toBe(1_000)
  })

  test("a task that came with a sync counts like a task of this computer, and it can stop a new task here (spec 019, 030)", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    // A row as the sync of tasks writes it: the source "channel", the channel, the tokens, and the
    // start time of the other computer. The count reads the row, not the computer that ran it.
    const synced = async (tokens: number) => {
      const made = await s.run(
        Tasks.use((x) =>
          x.create({
            agentId: ada.id,
            prompt: "from MacBook 2",
            source: "channel",
            sourceId: docs.id,
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
    expect(await s.limit(docs.id)).toMatchObject({ used: 41_000, state: "near", stoppedBy: null })
    // With the tokens of this computer on top, the limit is used and the next task is blocked.
    await s.mention(docs.id, "Ada", 10_000)
    expect(await s.limit(docs.id)).toMatchObject({ used: 51_000, state: "over" })
    expect((await s.mention(docs.id, "Ada", 100))?.state).toBe("blocked")
  })

  test("at 80% the channel shows the line, and nothing is blocked yet", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    await s.mention(docs.id, "Ada", 39_999)
    expect(await s.limit(docs.id)).toMatchObject({ used: 39_999, state: "ok", stoppedBy: null })
    const near = await s.mention(docs.id, "Ada", 1_001)
    expect(near?.state).toBe("done")
    expect(await s.limit(docs.id)).toMatchObject({ used: 41_000, state: "near", stoppedBy: null })
    // It makes no notification: no notice event, and no blocked task.
    expect((await s.tasks()).some((x) => x.state === "blocked")).toBe(false)
  })

  test("a channel with no limit shows no line, however much it used", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id])
    await s.mention(docs.id, "Ada", 900_000)
    expect(await s.limit(docs.id)).toMatchObject({ limit: null, state: "ok", stoppedBy: null })
    const next = await s.mention(docs.id, "Ada", 10)
    expect(next?.state).toBe("done")
  })
})

describe("at the limit", () => {
  test("the turn that runs goes to its end; the next task ends as Blocked with no turn", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    await s.mention(docs.id, "Ada", 41_000)
    // A part reaches 51,000: the turn goes to its end, and its tokens count.
    const over = await s.mention(docs.id, "Ada", 51_000)
    expect(over?.state).toBe("done")
    expect((await s.limit(docs.id)).used).toBe(92_000)
    expect((await s.limit(docs.id)).stoppedBy).toEqual({ id: docs.id, name: "Docs" })

    const asked = requests
    const blocked = await s.mention(docs.id, "Ada", 500)
    expect(blocked?.state).toBe("blocked")
    expect(blocked?.error).toEqual({ code: CHANNEL_LIMIT_CODE, detail: "Docs" })
    // The model got no request, and the task never ran: it has no start time.
    expect(requests).toBe(asked)
    expect(blocked?.startedAt ?? null).toBeNull()
  })

  test("Retry works after the user raises the limit", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 50_000 })
    await s.mention(docs.id, "Ada", 51_000)
    const blocked = await s.mention(docs.id, "Ada", 500)
    expect(blocked?.state).toBe("blocked")

    // While the limit is used, a retry is blocked again.
    await s.run(Tasks.use((x) => x.retry(blocked?.id ?? "")))
    await s.idle()
    const again = (await s.tasks()).filter((x) => x.state === "blocked")
    expect(again).toHaveLength(2)

    await s.setLimit(docs.id, 100_000)
    const asked = requests
    await s.run(Tasks.use((x) => x.retry(blocked?.id ?? "")))
    await s.idle()
    expect(requests).toBeGreaterThan(asked)
    expect((await s.tasks()).filter((x) => x.state === "done").length).toBeGreaterThanOrEqual(2)
    expect((await s.limit(docs.id)).stoppedBy).toBeNull()
  })

  test("a limit that is turned off lets the task run", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 10_000 })
    await s.mention(docs.id, "Ada", 12_000)
    expect((await s.mention(docs.id, "Ada", 5))?.state).toBe("blocked")
    await s.setLimit(docs.id, null)
    expect((await s.mention(docs.id, "Ada", 5))?.state).toBe("done")
  })

  test("the limit of a parent channel stops its lower channels, and the reason names the parent", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id], { dailyTokenLimit: 50_000 })
    const docs = await s.channel("Docs", [bo.id], { parentId: product.id })
    const site = await s.channel("Site", [bo.id], { parentId: docs.id })
    // The tokens of Docs and of Site count for Product.
    await s.mention(docs.id, "Bo", 30_000)
    await s.mention(site.id, "Bo", 25_000)
    expect((await s.limit(product.id)).used).toBe(55_000)
    expect((await s.limit(site.id)).stoppedBy).toEqual({ id: product.id, name: "Product" })

    const blocked = await s.mention(site.id, "Bo", 100)
    expect(blocked?.state).toBe("blocked")
    expect(blocked?.error).toEqual({ code: CHANNEL_LIMIT_CODE, detail: "Product" })
    // Docs is stopped too. Product itself is stopped by its own limit.
    expect((await s.mention(docs.id, "Bo", 100))?.error?.detail).toBe("Product")
    expect((await s.mention(product.id, "Ada", 100))?.error?.detail).toBe("Product")
  })

  test("the limit of a lower channel does not stop a higher channel or a sibling", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id])
    const docs = await s.channel("Docs", [bo.id], { parentId: product.id, dailyTokenLimit: 10_000 })
    const ops = await s.channel("Ops", [bo.id])
    await s.mention(docs.id, "Bo", 20_000)
    expect((await s.mention(docs.id, "Bo", 5))?.state).toBe("blocked")
    expect((await s.mention(product.id, "Ada", 5))?.state).toBe("done")
    expect((await s.mention(ops.id, "Bo", 5))?.state).toBe("done")
  })

  test("a chat of the same agent is not a task of the channel: no limit stops it", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.channel("Docs", [ada.id], { dailyTokenLimit: 10_000 })
    await s.mention(docs.id, "Ada", 12_000)
    const { Chat } = await import("./Chat.ts")
    await s.run(
      Chat.use((c) => c.send({ agentId: ada.id, text: "hello USAGE 100", replyTo: null })),
    )
    await s.idle()
    const chat = (await s.tasks()).find((x) => x.source === "chat")
    expect(chat?.state).toBe("done")
    // And its tokens do not count for the channel.
    expect((await s.limit(docs.id)).used).toBe(12_000)
  })
})

describe("the usage page", () => {
  test("one row for each channel with a limit, with the tokens of today", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id], { dailyTokenLimit: 100_000 })
    const docs = await s.channel("Docs", [bo.id], { parentId: product.id, dailyTokenLimit: 50_000 })
    await s.channel("Ops", [bo.id])
    await s.mention(docs.id, "Bo", 20_000)
    const rows = await s.run(ChannelTools.use((c) => c.usage(s.local.id)))
    expect(rows).toEqual([
      { channelId: docs.id, name: "Docs", used: 20_000, limit: 50_000 },
      { channelId: product.id, name: "Product", used: 20_000, limit: 100_000 },
    ])
    await s.setLimit(docs.id, null)
    const left = await s.run(ChannelTools.use((c) => c.usage(s.local.id)))
    expect(left.map((r) => r.name)).toEqual(["Product"])
  })
})
