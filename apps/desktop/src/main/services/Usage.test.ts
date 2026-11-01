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
  const summary = (days: 7 | 30) => run(Usage.use((u) => u.summary(local.id, days, NOW)))
  return { make, insert, summary }
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
      },
      {
        day: "2026-10-31",
        agentId: bo.id,
        agentName: "Bo",
        replies: 1,
        inputTokens: 7,
        outputTokens: 3,
      },
      {
        day: "2026-10-29",
        agentId: ada.id,
        agentName: "Ada",
        replies: 1,
        inputTokens: 5,
        outputTokens: 5,
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

  test("is empty without replies", async () => {
    const { summary } = await setup()
    expect(await summary(30)).toEqual([])
  })
})
