import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { AppServices } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Devices } from "./Devices.ts"
import { Memory } from "./Memory.ts"
import { Places } from "./Places.ts"
import { Providers } from "./Providers.ts"
import { Remote } from "./Remote.ts"
import { Servers } from "./Servers.ts"
import { Sync } from "./Sync.ts"
import { testRuntime } from "./testing.ts"

type Rt = ReturnType<typeof testRuntime>

const model = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})
afterAll(() => model.stop())

const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

const waitFor = async <T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40))
    last = await read()
  }
  return last
}

const run = <A, E>(rt: Rt, f: Effect.Effect<A, E, AppServices>) => rt.runtime.runPromise(f)

/** B opens A (and A opens B, when `twoWay`). */
const link = async (a: Rt, b: Rt, twoWay: boolean) => {
  const pairing = await run(
    a,
    Devices.use((d) => d.pairStart()),
  )
  const found = await run(
    b,
    Remote.use((r) => r.probe({ link: pairing.link })),
  )
  const done = run(
    b,
    Remote.use((r) => r.finish(found.session, twoWay)),
  )
  await waitFor(
    () =>
      run(
        a,
        Devices.use((d) => Effect.sync(() => d.joins())),
      ),
    (j) => j.length > 0,
  )
  await run(
    a,
    Devices.use((d) =>
      Effect.sync(() => d.joins()[0]).pipe(Effect.flatMap((j) => d.decide(j?.id ?? "", true))),
    ),
  )
  const entry = await done
  await waitFor(
    () =>
      run(
        b,
        Remote.use((r) => Effect.sync(() => r.stateOf(entry.id))),
      ),
    (state) => state === "online",
  )
  return entry
}

beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
  process.env.ROBOT_LINK_RETRY_MAX_MS = "300"
})
afterAll(async () => {
  for (const s of sides) await s.runtime.dispose()
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
})

const localId = (rt: Rt) =>
  run(
    rt,
    Servers.use((s) => s.local),
  ).then((s) => s.id)
const agentNames = async (rt: Rt) => {
  const id = await localId(rt)
  const list = await run(
    rt,
    Agents.use((a) => a.list(id, false)),
  )
  return list.map((a) => a.name).sort()
}
const makeAgent = async (rt: Rt, name: string, instructions = "Be brief.") => {
  const serverId = await localId(rt)
  return run(
    rt,
    Agents.use((a) => a.create({ serverId, name, role: "", instructions, model: null })),
  )
}
const status = (rt: Rt) =>
  run(
    rt,
    Sync.use((s) => Effect.sync(() => s.statuses()[0])),
  )

/** Starts a sync from `b` (which opens `a`) and lets `a` allow it. */
const turnOn = async (a: Rt, b: Rt, linkId: string, mode: "merge" | "take" | "send") => {
  const started = run(
    b,
    Sync.use((s) => s.start(linkId, mode)),
  )
  await waitFor(
    () =>
      run(
        a,
        Sync.use((s) => Effect.sync(() => s.requests())),
      ),
    (r) => r.length > 0,
  )
  await run(
    a,
    Sync.use((s) =>
      Effect.sync(() => s.requests()[0]).pipe(Effect.flatMap((r) => s.decide(r?.id ?? "", true))),
    ),
  )
  await started
  const live = (rt: Rt) =>
    waitFor(
      () => status(rt),
      (s) => s?.state === "live",
    )
  return { a: await live(a), b: await live(b) }
}

describe("sync between two computers", () => {
  test("merge: both keep their data, a clashing name gets the origin in brackets, secrets stay", async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    const account = await run(
      a,
      Providers.use((p) =>
        p.connect({
          kind: "custom",
          name: "Model",
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          apiKey: "SECRET-A",
        }),
      ),
    )
    await makeAgent(a, "Writer")
    const onlyA = await makeAgent(a, "Planner")
    await makeAgent(b, "Writer")
    const entry = await link(a, b, false)
    void account
    await run(
      a,
      Memory.use((m) => m.add(onlyA.id, "Likes tea", "user")),
    )

    const states = await turnOn(a, b, entry.id, "merge")
    expect(states.a?.state).toBe("live")
    expect(states.b?.state).toBe("live")

    const namesA = await agentNames(a)
    const namesB = await agentNames(b)
    expect(namesA).toEqual(namesB)
    expect(namesA).toHaveLength(3)
    expect(namesA).toContain("Planner")
    expect(namesA.filter((n) => n.startsWith("Writer"))).toHaveLength(2)
    expect(namesA.some((n) => /^Writer \(.+\)$/.test(n))).toBe(true)

    // Arrived agents ask for everything, have their own empty folder, and no secret came along.
    const idB = await localId(b)
    const arrived = await run(
      b,
      Agents.use((x) => x.list(idB, false)),
    )
    const planner = arrived.find((x) => x.name === "Planner")
    expect(planner?.permission).toBe("ask_all")
    expect(planner?.workspace).not.toBe(onlyA.workspace)
    expect(existsSync(planner?.workspace ?? "")).toBe(true)
    const mem = await run(
      b,
      Memory.use((m) => m.list(planner?.id ?? "")),
    )
    expect(mem.map((x) => x.text)).toEqual(["Likes tea"])
    const accounts = await run(
      b,
      Providers.use((p) => p.list),
    )
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.connected).toBe(false)

    // A backup exists on both computers.
    for (const rt of [a, b]) {
      const files = readdirSync(join(rt.dataDir, "backups"))
      expect(files.some((f) => f.startsWith("sync-") && f.endsWith(".zip"))).toBe(true)
    }
  })

  test("a rename and a delete reach the other computer, and the workspace folder stays", async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    const agent = await makeAgent(a, "Old name")
    const entry = await link(a, b, true)
    await turnOn(a, b, entry.id, "merge")
    expect(await agentNames(b)).toEqual(["Old name"])

    await run(
      a,
      Agents.use((x) => x.update(agent.id, { name: "New name" })),
    )
    expect(
      await waitFor(
        () => agentNames(b),
        (n) => n[0] === "New name",
        5000,
      ),
    ).toEqual(["New name"])
    const changes = await run(
      b,
      Sync.use((s) => Effect.sync(() => s.changes())),
    )
    expect(changes.some((c) => c.kind === "agent" && c.name === "New name")).toBe(true)

    const idB = await localId(b)
    const copy = (
      await run(
        b,
        Agents.use((x) => x.list(idB, false)),
      )
    )[0]
    await run(
      a,
      Agents.use((x) => x.archive(agent.id)),
    )
    await run(
      a,
      Agents.use((x) => x.remove(agent.id)),
    )
    expect(
      await waitFor(
        () => agentNames(b),
        (n) => n.length === 0,
        5000,
      ),
    ).toEqual([])
    expect(existsSync(copy?.workspace ?? "")).toBe(true)
  })

  test("take: this computer gets the data of the other and loses its own", async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    await makeAgent(a, "From A")
    await makeAgent(b, "From B")
    const entry = await link(a, b, false)
    await turnOn(a, b, entry.id, "take")
    expect(await agentNames(b)).toEqual(["From A"])
    expect(await agentNames(a)).toEqual(["From A"])
  })

  test("stop: both keep their data and a change no longer crosses", async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    await makeAgent(a, "Shared")
    const entry = await link(a, b, false)
    await turnOn(a, b, entry.id, "merge")
    await run(
      b,
      Sync.use((s) => s.stop(entry.id)),
    )
    expect((await status(b))?.state).toBe("off")
    expect(
      (
        await waitFor(
          () => status(a),
          (s) => s?.state === "off",
        )
      )?.stoppedBy,
    ).toBe(true)
    await makeAgent(a, "After stop")
    await new Promise((r) => setTimeout(r, 800))
    expect(await agentNames(b)).toEqual(["Shared"])
    expect(await agentNames(a)).toEqual(["After stop", "Shared"])
  })

  test("deleting 8 agents at once asks first, and Keep sends them back", async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    const ids: string[] = []
    for (let i = 0; i < 8; i++) ids.push((await makeAgent(a, `Agent ${i}`)).id)
    const entry = await link(a, b, true)
    await turnOn(a, b, entry.id, "merge")
    expect(await agentNames(b)).toHaveLength(8)
    for (const id of ids) {
      await run(
        a,
        Agents.use((x) => x.archive(id)),
      )
      await run(
        a,
        Agents.use((x) => x.remove(id)),
      )
    }
    const guard = await waitFor(
      () =>
        run(
          b,
          Sync.use((s) => Effect.sync(() => s.guard())),
        ),
      (g) => g !== null,
    )
    expect(guard?.count).toBe(8)
    expect(await agentNames(b)).toHaveLength(8)
    await run(
      b,
      Sync.use((s) => s.decideGuard(false)),
    )
    expect(await agentNames(b)).toHaveLength(8)
    expect(
      await waitFor(
        () => agentNames(a),
        (n) => n.length === 8,
      ),
    ).toHaveLength(8)
  })

  test("a message made on one computer arrives on the other and starts no task", async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    const agent = await makeAgent(a, "Ada")
    const entry = await link(a, b, true)
    await turnOn(a, b, entry.id, "merge")
    await run(
      a,
      Database.use((db) =>
        Effect.sync(() =>
          db.run(
            `INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('m1', ?, 'user', ?, 'done', ?)`,
            agent.id,
            JSON.stringify([{ kind: "text", text: "Hello from A" }]),
            Date.now(),
          ),
        ),
      ),
    )
    const history = await waitFor(
      () =>
        run(
          b,
          Chat.use((c) => c.history(agent.id)),
        ),
      (h) => h.messages.length === 1,
    )
    expect(history.messages).toHaveLength(1)
    void Channels
  })
})

/** The link id that a computer uses for the other one. */
const linkOf = async (rt: Rt) => (await status(rt))?.linkId ?? ""

/** Both computers stop sending, as if they were apart. */
const apart = async (a: Rt, b: Rt) => {
  const id = await linkOf(b)
  await run(
    b,
    Sync.use((s) => s.setPaused(id, true)),
  )
  await waitFor(
    () => status(a),
    (x) => x?.state === "paused",
  )
}
const together = async (a: Rt, b: Rt) => {
  const id = await linkOf(b)
  await run(
    b,
    Sync.use((s) => s.setPaused(id, false)),
  )
  for (const rt of [a, b]) {
    await waitFor(
      () => status(rt),
      (x) => x?.state === "live",
    )
  }
}
const settle = () => new Promise((r) => setTimeout(r, 25))

const agentRows = async (rt: Rt) => {
  const id = await localId(rt)
  const list = await run(
    rt,
    Agents.use((a) => a.list(id, false)),
  )
  return list.map((a) => `${a.id}|${a.name}|${a.role}|${a.instructions}`).sort()
}
const memoryTexts = async (rt: Rt, agentId: string) =>
  (
    await run(
      rt,
      Memory.use((m) => m.list(agentId)),
    )
  )
    .map((m) => m.text)
    .sort()

describe("two computers that were apart", () => {
  const pair = async (names = ["Ada"]) => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    const agents = []
    for (const name of names) agents.push(await makeAgent(a, name))
    const entry = await link(a, b, true)
    await turnOn(a, b, entry.id, "merge")
    return { a, b, agents }
  }

  test("changes of different fields both stay; the newest change of one field wins on both", async () => {
    const { a, b, agents } = await pair()
    const ada = agents[0]
    await apart(a, b)
    await run(
      a,
      Agents.use((x) => x.update(ada?.id ?? "", { role: "Writer", instructions: "From A." })),
    )
    await settle()
    await run(
      b,
      Agents.use((x) => x.update(ada?.id ?? "", { instructions: "From B, later." })),
    )
    await together(a, b)
    // Each computer needs the change of the other: the role comes from A, the instructions from B.
    const both = (r: string[]) => r[0]?.includes("|Writer|From B, later.") === true
    const rowsA = await waitFor(() => agentRows(a), both)
    const rowsB = await waitFor(() => agentRows(b), both)
    expect(rowsA).toEqual(rowsB)
    expect(rowsA[0]).toContain("|Writer|From B, later.")
  })

  test("the same memory item edited on both: the newest text stays and the other text is saved as a new item", async () => {
    const { a, b, agents } = await pair()
    const ada = agents[0]
    const item = await run(
      a,
      Memory.use((m) => m.add(ada?.id ?? "", "Likes tea", "user")),
    )
    await waitFor(
      () => memoryTexts(b, ada?.id ?? ""),
      (t) => t.length === 1,
    )
    await apart(a, b)
    await run(
      a,
      Memory.use((m) => m.update(item.id, "Likes coffee")),
    )
    await settle()
    await run(
      b,
      Memory.use((m) => m.update(item.id, "Likes juice")),
    )
    await together(a, b)
    const want = ["Likes coffee", "Likes juice"]
    expect(
      await waitFor(
        () => memoryTexts(a, ada?.id ?? ""),
        (t) => t.length === 2,
      ),
    ).toEqual(want)
    expect(
      await waitFor(
        () => memoryTexts(b, ada?.id ?? ""),
        (t) => t.length === 2,
      ),
    ).toEqual(want)
    // The newest text keeps the item. Both computers made the same second item, so there are two.
    const kept = await run(
      a,
      Memory.use((m) => m.list(ada?.id ?? "")),
    )
    expect(kept.find((m) => m.id === item.id)?.text).toBe("Likes juice")
  })

  test("a name stays unique when both computers give one name to different agents", async () => {
    const { a, b, agents } = await pair(["P", "Q"])
    const [p, q] = agents
    await apart(a, b)
    await run(
      a,
      Agents.use((x) => x.update(p?.id ?? "", { name: "Same" })),
    )
    await run(
      b,
      Agents.use((x) => x.update(q?.id ?? "", { name: "Same" })),
    )
    await together(a, b)
    const namesA = await waitFor(
      () => agentNames(a),
      (n) => n.some((x) => x.startsWith("Same (")),
    )
    const namesB = await waitFor(
      () => agentNames(b),
      (n) => n.some((x) => x.startsWith("Same (")),
    )
    expect(namesA).toEqual(namesB)
    expect(namesA).toHaveLength(2)
    expect(namesA.filter((n) => n === "Same")).toHaveLength(1)
    expect(await agentRows(a)).toEqual(await agentRows(b))
  })

  test("a deletion that was made while apart reaches the other computer", async () => {
    const { a, b, agents } = await pair()
    const ada = agents[0]
    await run(
      a,
      Agents.use((x) => x.archive(ada?.id ?? "")),
    )
    await waitFor(
      () => agentNames(b),
      (n) => n.length === 0,
    )
    await apart(a, b)
    await run(
      a,
      Agents.use((x) => x.remove(ada?.id ?? "")),
    )
    await together(a, b)
    expect(
      await waitFor(
        async () =>
          (
            await run(
              b,
              Agents.use((x) => x.list("*", true)),
            )
          ).length,
        (n) => n === 0,
      ),
    ).toBe(0)
  })

  test("reading a place on one computer clears its count on the other", async () => {
    const { a, b, agents } = await pair()
    const ada = agents[0]
    await run(
      a,
      Database.use((db) =>
        Effect.sync(() =>
          db.run(
            `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at) VALUES ('r1', ?, 'agent', ?, 'done', ?, ?)`,
            ada?.id ?? "",
            JSON.stringify([{ kind: "text", text: "A reply" }]),
            Date.now(),
            Date.now(),
          ),
        ),
      ),
    )
    const unread = async (rt: Rt) => {
      const id = await localId(rt)
      const sections = await run(
        rt,
        Places.use((p) => p.list(id)),
      )
      return sections.flatMap((s) => s.places).find((p) => p.id === ada?.id)?.unread ?? -1
    }
    expect(
      await waitFor(
        () => unread(b),
        (n) => n === 1,
      ),
    ).toBe(1)
    expect(await unread(a)).toBe(1)
    await new Promise((r) => setTimeout(r, 20))
    await run(
      a,
      Chat.use((c) => c.markRead(ada?.id ?? "")),
    )
    expect(
      await waitFor(
        () => unread(b),
        (n) => n === 0,
      ),
    ).toBe(0)
    expect(await unread(a)).toBe(0)
  })
})
