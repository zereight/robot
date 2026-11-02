import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Usage } from "./Usage.ts"

const NOW = new Date(2026, 9, 31, 15, 0).getTime()
const daysAgo = (n: number, hour = 12) => new Date(2026, 9, 31 - n, hour).getTime()

const setup = async () => {
  const { runtime } = testRuntime()
  const run = runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const make = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: local.id, name, role: "", instructions: "", model: null }),
      ),
    )
  const db = await run(Database.use((d) => Effect.succeed(d)))
  const insert = (
    agentId: string,
    finishedAt: number,
    input: number,
    output: number,
    status = "done",
    author = "agent",
  ) =>
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, input_tokens, output_tokens, created_at, finished_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      agentId,
      author,
      status,
      input,
      output,
      finishedAt,
      finishedAt,
    )
  const task = (
    agentId: string,
    o: {
      readonly finishedAt: number
      readonly firstReply: number | null
      readonly asked?: boolean
      readonly source?: string
      readonly state?: string
    },
  ) => {
    const createdAt = o.finishedAt - 10_000
    db.run(
      `INSERT INTO task (id, agent_id, prompt, label, source, state, created_at, started_at,
         finished_at, asked_at, first_reply_at) VALUES (?, ?, 'q', 'q', ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      agentId,
      o.source ?? "chat",
      o.state ?? "done",
      createdAt,
      createdAt,
      o.finishedAt,
      o.asked ? createdAt - 1000 : null,
      o.firstReply === null ? null : createdAt + o.firstReply,
    )
  }
  const summary = (days: 7 | 30) => run(Usage.use((u) => u.summary(local.id, days, NOW)))
  return { make, insert, task, summary }
}

describe("Usage", () => {
  test("adds up finished replies per agent and local day", async () => {
    const { make, insert, summary } = await setup()
    const ada = await make("Ada")
    const bo = await make("Bo")
    insert(ada.id, daysAgo(0, 9), 10, 4)
    insert(ada.id, daysAgo(0, 14), 20, 6)
    insert(bo.id, daysAgo(0, 10), 7, 3)
    insert(ada.id, daysAgo(2), 5, 5)

    const rows = await summary(7)
    expect(rows).toEqual([
      {
        day: "2026-10-31",
        agentId: ada.id,
        agentName: "Ada",
        replies: 2,
        inputTokens: 30,
        outputTokens: 10,
        firstReplyMs: null,
      },
      {
        day: "2026-10-31",
        agentId: bo.id,
        agentName: "Bo",
        replies: 1,
        inputTokens: 7,
        outputTokens: 3,
        firstReplyMs: null,
      },
      {
        day: "2026-10-29",
        agentId: ada.id,
        agentName: "Ada",
        replies: 1,
        inputTokens: 5,
        outputTokens: 5,
        firstReplyMs: null,
      },
    ])
  })

  test("ignores user messages, failed and stopped replies, and days outside the range", async () => {
    const { make, insert, summary } = await setup()
    const ada = await make("Ada")
    insert(ada.id, daysAgo(0), 1, 1, "done", "user")
    insert(ada.id, daysAgo(0), 9, 9, "failed")
    insert(ada.id, daysAgo(0), 9, 9, "stopped")
    insert(ada.id, daysAgo(7), 9, 9)
    insert(ada.id, daysAgo(6), 2, 3)

    expect(await summary(7)).toHaveLength(1)
    expect((await summary(7))[0]).toMatchObject({ day: "2026-10-25", inputTokens: 2 })
    expect(await summary(30)).toHaveLength(2)
  })

  test("the median first reply of done chat tasks, per agent and day", async () => {
    const { make, insert, task, summary } = await setup()
    const ada = await make("Ada")
    const bo = await make("Bo")
    insert(ada.id, daysAgo(0), 1, 1)
    task(ada.id, { finishedAt: daysAgo(0, 9), firstReply: 1000 })
    task(ada.id, { finishedAt: daysAgo(0, 10), firstReply: 3000 })
    // Counted from the message that started the task: one second more.
    task(ada.id, { finishedAt: daysAgo(0, 11), firstReply: 1000, asked: true })
    // Not counted: not done, not from a chat, no known time.
    task(ada.id, { finishedAt: daysAgo(0), firstReply: 50, state: "failed" })
    task(ada.id, { finishedAt: daysAgo(0), firstReply: 50, source: "routine" })
    task(ada.id, { finishedAt: daysAgo(0), firstReply: null })
    // A day with a time and no counted reply.
    task(bo.id, { finishedAt: daysAgo(1), firstReply: 4000 })

    const rows = await summary(7)
    expect(rows.map((r) => [r.day, r.agentName, r.replies, r.firstReplyMs])).toEqual([
      ["2026-10-31", "Ada", 1, 2000],
      ["2026-10-30", "Bo", 0, 4000],
    ])
  })

  test("is empty without replies", async () => {
    const { summary } = await setup()
    expect(await summary(30)).toEqual([])
  })
})
