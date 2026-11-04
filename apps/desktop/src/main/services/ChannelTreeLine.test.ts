import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { PlaceSection, RpcResult } from "@robot/shared"
import { Effect } from "effect"
import { pairRuntimes } from "../link/pairing.testing.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { repairChannelTree } from "./channelTreeRepair.ts"
import { Database } from "./Database.ts"
import { Places } from "./Places.ts"
import { Remote } from "./Remote.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

// The muted line of a repaired channel tree (spec 030, "Repair"): "The line is not a message of an
// agent: it adds no unread count and does not replace the preview of the place." The line still
// shows in the channel. The place list is built on the computer that owns the channels, and the
// phone and a linked computer read it from there, so these tests look at the place list, at the
// sums that the windows make from it, and at the same list over a link.

type Rt = ReturnType<typeof testRuntime>
const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
  process.env.ROBOT_LINK_RETRY_MAX_MS = "300"
  process.env.ROBOT_LINK_NEARBY_WAIT_MS = "80"
})
afterAll(async () => {
  for (const s of sides) await s.runtime.dispose()
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
  delete process.env.ROBOT_LINK_NEARBY_WAIT_MS
})

/** A computer with Product > Docs > Site > Wiki (a fourth level), an agent and one message in "Wiki". */
const setup = async (rt: Rt) => {
  const run = rt.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const ada = await run(
    Agents.use((a) => a.create({ serverId: local.id, name: "Ada", role: "", instructions: "" })),
  )
  const make = (name: string) =>
    run(
      Channels.use((c) =>
        c.create({ serverId: local.id, name, topic: "", memberIds: [ada.id], leadId: null }),
      ),
    )
  const product = await make("Product")
  const docs = await make("Docs")
  const site = await make("Site")
  const wiki = await make("Wiki")
  const db = await run(Database.use((d) => Effect.succeed(d)))
  // The service refuses a fourth level, so the break is written as an import or a sync writes it.
  for (const [id, parent] of [
    [docs.id, product.id],
    [site.id, docs.id],
    [wiki.id, site.id],
  ] as const)
    db.run("UPDATE channel SET parent_channel_id = ? WHERE id = ?", parent, id)
  /** A message of the agent, `after` ms after the user last read the channel. */
  const say = (channelId: string, text: string, after: number) => {
    const at =
      (db.get<{ t: number }>("SELECT last_read_at AS t FROM channel WHERE id = ?", channelId)?.t ??
        0) + after
    db.run(
      `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, created_at, finished_at)
       VALUES (?, ?, 'agent', ?, 'text', ?, 'done', ?, ?)`,
      `m-${channelId}-${at}`,
      channelId,
      ada.id,
      JSON.stringify([{ kind: "text", text }]),
      at,
      at,
    )
  }
  const sections = () => run(Places.use((p) => p.list(local.id)))
  return { run, local, db, ada, product, docs, site, wiki, say, sections }
}

const placeOf = (sections: readonly PlaceSection[], id: string) =>
  sections.flatMap((s) => s.places).find((p) => p.id === id)
const sum = (sections: readonly PlaceSection[]) =>
  sections.flatMap((s) => s.places).reduce((n, p) => n + p.unread, 0)

describe("the muted line of a repaired tree in the place list (spec 030, Repair)", () => {
  test("the line adds no unread count and keeps the preview; the channel still shows it", async () => {
    const s = await setup(side("This Mac"))
    s.say(s.wiki.id, "The wiki is ready.", 1)
    const before = await s.sections()
    expect(placeOf(before, s.wiki.id)).toMatchObject({
      unread: 1,
      lastMessage: "The wiki is ready.",
    })

    const made = repairChannelTree(s.db, { mode: "restore" })
    expect(made.map((r) => [r.channelId, r.reason])).toEqual([[s.wiki.id, "levels"]])

    // One unread message, as before: the line is the newest message, but it is no news.
    const after = await s.sections()
    expect(placeOf(after, s.wiki.id)).toMatchObject({
      unread: 1,
      lastMessage: "The wiki is ready.",
    })
    expect(sum(after)).toBe(1)
    const channel = await s.run(Channels.use((c) => c.get(s.wiki.id)))
    expect(channel.unread).toBe(1)
    // The line shows in the channel.
    const history = await s.run(Channels.use((c) => c.history(s.wiki.id)))
    expect(history.map((m) => m.parts)).toEqual([
      [{ kind: "text", text: "The wiki is ready." }],
      [{ kind: "note", note: "tree_repaired", why: "levels" }],
    ])

    // Reading the channel clears the count, and the preview stays the text of the agent.
    await s.run(Channels.use((c) => c.markRead(s.wiki.id)))
    const read = await s.sections()
    expect(placeOf(read, s.wiki.id)).toMatchObject({
      unread: 0,
      lastMessage: "The wiki is ready.",
    })
    expect(sum(read)).toBe(0)
  })

  test("a channel with the line only has no unread count and no preview", async () => {
    const s = await setup(side("This Mac"))
    repairChannelTree(s.db, { mode: "restore" })
    const sections = await s.sections()
    expect(placeOf(sections, s.wiki.id)).toMatchObject({ unread: 0, lastMessage: null })
    expect(sum(sections)).toBe(0)
    // The line is in the channel all the same.
    const history = await s.run(Channels.use((c) => c.history(s.wiki.id)))
    expect(history).toHaveLength(1)
  })

  test("a message of an agent after the line counts and is the preview", async () => {
    const s = await setup(side("This Mac"))
    repairChannelTree(s.db, { mode: "restore" })
    s.say(s.wiki.id, "Back to work.", 60_000)
    const sections = await s.sections()
    expect(placeOf(sections, s.wiki.id)).toMatchObject({ unread: 1, lastMessage: "Back to work." })
  })

  test("a phone or a linked computer reads the same list from the computer of the channels", async () => {
    const server = side("MacBook 2")
    const client = side("MacBook 1")
    const { entry } = await pairRuntimes(server, client, { canChange: false })
    const s = await setup(server)
    s.say(s.wiki.id, "The wiki is ready.", 1)
    repairChannelTree(s.db, { mode: "restore" })
    const ask = async (): Promise<readonly PlaceSection[]> => {
      const result: RpcResult<unknown> = await client.runtime.runPromise(
        Remote.use((r) =>
          Effect.promise(() => r.invoke(entry.serverId, "places.list", { serverId: s.local.id })),
        ),
      )
      if (!result.ok) throw new Error(`places.list failed: ${result.error.code}`)
      return result.value as PlaceSection[]
    }
    const list = await ask()
    expect(placeOf(list, s.wiki.id)).toMatchObject({
      unread: 1,
      lastMessage: "The wiki is ready.",
    })
    // The sum for the header of a closed section, and for the whole server, is the same.
    expect(sum(list)).toBe(1)
    // After the user reads the channel, the list that the other computer gets shows no count.
    await s.run(Channels.use((c) => c.markRead(s.wiki.id)))
    const read = await ask()
    expect(placeOf(read, s.wiki.id)).toMatchObject({
      unread: 0,
      lastMessage: "The wiki is ready.",
    })
    expect(sum(read)).toBe(0)
  })
})
