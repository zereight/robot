import { afterAll, describe, expect, test } from "bun:test"
import type { PlaceSection } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Database } from "./Database.ts"
import { Places } from "./Places.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

// An old muted line of a repaired channel tree (a version before the organizations, spec 030,
// "Migration") stays in the history. No version writes one now, but the line is "not a message of
// an agent": it adds no unread count and does not replace the preview of the place.

const sides: ReturnType<typeof testRuntime>[] = []
afterAll(async () => {
  for (const s of sides) await s.runtime.dispose()
})

/** A computer with one channel, one agent, and helpers that write messages as the old data held them. */
const setup = async () => {
  const rt = testRuntime({ name: "This Mac" })
  sides.push(rt)
  const run = rt.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const ada = await run(
    Agents.use((a) => a.create({ serverId: local.id, name: "Ada", role: "", instructions: "" })),
  )
  const wiki = await run(
    Channels.use((c) =>
      c.create({ serverId: local.id, name: "Wiki", topic: "", memberIds: [ada.id], leadId: null }),
    ),
  )
  const db = await run(Database.use((d) => Effect.succeed(d)))
  /** A message of the agent, or the old muted line, `after` ms after the user last read the channel. */
  const write = (parts: unknown, after: number, author: "agent" | "system" = "agent") => {
    const at =
      (db.get<{ t: number }>("SELECT last_read_at AS t FROM channel WHERE id = ?", wiki.id)?.t ??
        0) + after
    db.run(
      `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, created_at, finished_at)
       VALUES (?, ?, ?, ?, 'text', ?, 'done', ?, ?)`,
      `m-${at}`,
      wiki.id,
      author,
      author === "agent" ? ada.id : null,
      JSON.stringify(parts),
      at,
      at,
    )
  }
  const say = (text: string, after: number) => write([{ kind: "text", text }], after)
  const line = (after: number) =>
    write([{ kind: "note", note: "tree_repaired", why: "levels" }], after, "agent")
  const place = async (): Promise<PlaceSection["places"][number] | undefined> =>
    (await run(Places.use((p) => p.list(local.id))))
      .flatMap((s) => s.places)
      .find((p) => p.id === wiki.id)
  return { run, wiki, say, line, place }
}

describe("an old muted line of a repaired channel tree (spec 030, 'Migration')", () => {
  test("the line adds no unread count and keeps the preview; the channel still shows it", async () => {
    const s = await setup()
    s.say("The wiki is ready.", 1)
    s.line(2)
    expect(await s.place()).toMatchObject({ unread: 1, lastMessage: "The wiki is ready." })
    expect((await s.run(Channels.use((c) => c.get(s.wiki.id)))).unread).toBe(1)
    const history = await s.run(Channels.use((c) => c.history(s.wiki.id)))
    expect(history.map((m) => m.parts)).toEqual([
      [{ kind: "text", text: "The wiki is ready." }],
      [{ kind: "note", note: "tree_repaired", why: "levels" }],
    ])
    // Reading the channel clears the count, and the preview stays the text of the agent.
    await s.run(Channels.use((c) => c.markRead(s.wiki.id)))
    expect(await s.place()).toMatchObject({ unread: 0, lastMessage: "The wiki is ready." })
  })

  test("a channel with the line only has no unread count and no preview", async () => {
    const s = await setup()
    s.line(1)
    expect(await s.place()).toMatchObject({ unread: 0, lastMessage: null })
    expect(await s.run(Channels.use((c) => c.history(s.wiki.id)))).toHaveLength(1)
  })

  test("a message of an agent after the line counts and is the preview", async () => {
    const s = await setup()
    s.line(1)
    s.say("Back to work.", 60_000)
    expect(await s.place()).toMatchObject({ unread: 1, lastMessage: "Back to work." })
  })
})
