import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { RpcResult, SearchPage } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "../services/Agents.ts"
import { Database } from "../services/Database.ts"
import { Remote } from "../services/Remote.ts"
import { testRuntime } from "../services/testing.ts"
import { pairRuntimes } from "./pairing.testing.ts"

type Rt = ReturnType<typeof testRuntime>

const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

const waitFor = async <T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40))
    last = await read()
  }
  return last
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

const text = (value: string) => JSON.stringify([{ kind: "text", text: value }])

/** A server with an agent and some messages, and a client that is paired with it. */
const pair = async () => {
  const server = side("MacBook 2")
  const client = side("MacBook 1")
  const { entry } = await pairRuntimes(server, client, { canChange: false })
  const serverId = entry.serverId
  const ask = (method: string, input: unknown): Promise<RpcResult<unknown>> =>
    client.runtime.runPromise(
      Remote.use((r) => Effect.promise(() => r.invoke(serverId, method, input))),
    )
  const agent = await server.runtime.runPromise(
    Agents.use((a) => a.create({ serverId, name: "Ada", role: "", instructions: "" })),
  )
  const db = await server.runtime.runPromise(Database.use((d) => Effect.succeed(d)))
  const say = (id: string, body: string, at: number) =>
    db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES (?, ?, 'user', ?, 'done', ?)",
      id,
      agent.id,
      text(body),
      at,
    )
  const search = async (query: string, offset = 0) => {
    const result = await ask("messages.search", { serverId, query, offset })
    if (!result.ok) throw new Error(`search failed: ${result.error.code}`)
    return result.value as SearchPage
  }
  return { server, client, entry, serverId, ask, agent, say, search }
}

describe("message search on a linked server (spec 001, 012)", () => {
  test("the server runs the search for a device that may only read", async () => {
    const p = await pair()
    p.say("m1", "The budget is 4200 euros", 10)
    p.say("m2", "Only a budget", 20)
    const page = await p.search("euros budget")
    expect(page.cached).toBe(false)
    expect(page.hits.map((h) => h.messageId)).toEqual(["m1"])
    expect(page.hits[0]).toMatchObject({ kind: "agent", placeName: "Ada", author: "user" })
    expect((await p.search("budget")).hits.map((h) => h.messageId)).toEqual(["m2", "m1"])
    // A text of one character gives an empty page, from the server.
    expect((await p.search("b")).hits).toEqual([])
  })

  test("a request with a bad offset or a very long text is refused by the server", async () => {
    const p = await pair()
    const long = await p.ask("messages.search", { serverId: p.serverId, query: "a".repeat(400) })
    expect(long.ok).toBe(false)
    const bad = await p.ask("messages.search", { serverId: p.serverId, query: "ab", offset: -1 })
    expect(bad.ok).toBe(false)
  })

  test("the server does not search its archived chats for the client", async () => {
    const p = await pair()
    p.say("m1", "a shared word", 10)
    expect((await p.search("shared")).hits).toHaveLength(1)
    await p.server.runtime.runPromise(Agents.use((a) => a.archive(p.agent.id)))
    expect((await p.search("shared")).hits).toEqual([])
  })

  test("while the server is away the client searches what it saved, and the page says so", async () => {
    const p = await pair()
    // The client opens the place: the list of places and the messages are saved.
    p.say("m1", "The budget is 4200 euros", 10)
    p.say("m2", "A saved note about the budget", 20)
    expect((await p.ask("places.list", { serverId: p.serverId })).ok).toBe(true)
    expect((await p.ask("chat.history", { agentId: p.agent.id })).ok).toBe(true)
    // A message that the client never saw: it is on the server only.
    p.say("m3", "A later budget message that the client did not read", 30)

    await p.server.runtime.dispose()
    await waitFor(
      () =>
        p.client.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.stateOf(p.entry.id)))),
      (state) => state !== "online",
    )

    const page = await p.search("budget")
    expect(page.cached).toBe(true)
    expect(page.hits.map((h) => h.messageId)).toEqual(["m2", "m1"])
    expect(page.hits[0]).toMatchObject({ kind: "agent", placeId: p.agent.id, placeName: "Ada" })
    expect((await p.search("euros budget")).hits.map((h) => h.messageId)).toEqual(["m1"])
    expect((await p.search("later")).hits).toEqual([])
    expect((await p.search("b")).hits).toEqual([])
  })

  test("a client that was never online has nothing to search, and gets an empty cached page", async () => {
    const p = await pair()
    await p.server.runtime.dispose()
    await waitFor(
      () =>
        p.client.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.stateOf(p.entry.id)))),
      (state) => state !== "online",
    )
    expect(await p.search("budget")).toEqual({ hits: [], more: false, capped: false, cached: true })
  })
})
