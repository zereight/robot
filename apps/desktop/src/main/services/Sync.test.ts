import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { AppServices } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Devices } from "./Devices.ts"
import { Knowledge } from "./Knowledge.ts"
import { Memory } from "./Memory.ts"
import { Notifier } from "./Notifier.ts"
import { Places } from "./Places.ts"
import { Providers } from "./Providers.ts"
import { Remote } from "./Remote.ts"
import { Routines } from "./Routines.ts"
import { Servers } from "./Servers.ts"
import { Sync } from "./Sync.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

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

describe("tasks, routines, workflows and files of two computers", () => {
  const pair = async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    const ada = await makeAgent(a, "Ada")
    const entry = await link(a, b, true)
    await turnOn(a, b, entry.id, "merge")
    await waitFor(
      () => agentNames(b),
      (n) => n.length === 1,
    )
    return { a, b, ada }
  }
  const tasksOf = async (rt: Rt) => {
    const id = await localId(rt)
    return run(
      rt,
      Tasks.use((t) => t.list(id)),
    )
  }
  const SQL = (rt: Rt, sql: string, ...args: (string | number | null)[]) =>
    run(
      rt,
      Database.use((db) => Effect.sync(() => db.run(sql, ...args))),
    )
  /** A task that goes on until it is stopped. Its promise ends when it stops. */
  const longTask = async (rt: Rt, agentId: string) => {
    const task = await run(
      rt,
      Tasks.use((t) =>
        t.create({ agentId, prompt: "A long job", source: "chat", sourceId: agentId }),
      ),
    )
    void run(
      rt,
      Tasks.use((t) => t.run(task.id, agentId, Effect.never)),
    ).catch(() => {})
    return task
  }

  test("a task of the other computer shows its origin, is stopped there, and is never changed here", async () => {
    const { a, b, ada } = await pair()
    const task = await longTask(b, ada.id)
    const seen = await waitFor(
      async () => (await tasksOf(a)).find((t) => t.id === task.id),
      (t) => t?.state === "running",
    )
    expect(seen?.originName).toBe("MacBook 2")
    expect((await tasksOf(b)).find((t) => t.id === task.id)?.originName).toBeNull()

    // A stop on the first computer goes to the second one, where the task runs.
    await run(
      a,
      Tasks.use((t) => t.stopAny(task.id)),
    )
    const onB = await waitFor(
      async () => (await tasksOf(b)).find((t) => t.id === task.id),
      (t) => t?.state === "cancelled",
    )
    expect(onB?.state).toBe("cancelled")
    const onA = await waitFor(
      async () => (await tasksOf(a)).find((t) => t.id === task.id),
      (t) => t?.state === "cancelled",
    )
    expect(onA?.state).toBe("cancelled")
  })

  test("Stop for an agent stops its tasks on the other computer and leaves the tasks here", async () => {
    const { a, b, ada } = await pair()
    const there = await longTask(b, ada.id)
    await waitFor(
      async () => (await tasksOf(a)).find((t) => t.id === there.id),
      (t) => t?.state === "running",
    )
    await run(
      a,
      Tasks.use((t) => t.stopRemoteFor(ada.id)),
    )
    const stopped = await waitFor(
      async () => (await tasksOf(b)).find((t) => t.id === there.id),
      (t) => t?.state === "cancelled",
    )
    expect(stopped?.state).toBe("cancelled")
  })

  test("one task per agent across both computers: the second one waits and then runs", async () => {
    const { a, b, ada } = await pair()
    const first = await longTask(b, ada.id)
    await waitFor(
      async () => (await tasksOf(a)).find((t) => t.id === first.id),
      (t) => t?.state === "running",
    )
    const second = await run(
      a,
      Tasks.use((t) =>
        t.create({ agentId: ada.id, prompt: "Next job", source: "chat", sourceId: ada.id }),
      ),
    )
    const finished = run(
      a,
      Tasks.use((t) => t.run(second.id, ada.id, Effect.succeed("ok"))),
    )
    const waiting = await waitFor(
      async () => (await tasksOf(a)).find((t) => t.id === second.id),
      (t) => t?.waitsFor === "MacBook 2",
    )
    expect(waiting?.state).toBe("queued")
    expect(waiting?.waitsFor).toBe("MacBook 2")
    await new Promise((r) => setTimeout(r, 700))
    expect((await tasksOf(a)).find((t) => t.id === second.id)?.state).toBe("queued")
    await run(
      b,
      Tasks.use((t) => t.stop(first.id)),
    )
    await finished
    const done = (await tasksOf(a)).find((t) => t.id === second.id)
    expect(done?.state).toBe("done")
    expect(done?.waitsFor).toBeNull()
  })

  test("a routine from the other computer does not run here; Run on this computer moves it", async () => {
    const { a, b, ada } = await pair()
    const idA = await localId(a)
    const idB = await localId(b)
    const routine = await run(
      a,
      Routines.use((r) =>
        r.create({
          serverId: idA,
          agentId: ada.id,
          name: "Check",
          prompt: "hello",
          schedule: { kind: "every", minutes: 2, from: Date.now() },
          place: { kind: "agent" },
        }),
      ),
    )
    expect(routine.runsOn).toBeNull()
    const onB = await waitFor(
      async () =>
        (
          await run(
            b,
            Routines.use((r) => r.list(idB)),
          )
        ).find((x) => x.id === routine.id),
      (x) => x !== undefined,
    )
    expect(onB?.runsOn).toBe("MacBook 1")
    expect(onB?.nextRuns).toEqual([])
    const entries = (rt: Rt, id: string) =>
      run(
        rt,
        Routines.use((r) => r.calendar(id, Date.now() - 86_400_000, Date.now() + 86_400_000)),
      ).then((list) => list.filter((e) => e.state !== "planned"))

    // At its time it does not run on the second computer, and nothing counts as missed there.
    const later = Date.now() + 10 * 60_000
    await run(
      b,
      Routines.use((r) => r.tick(later)),
    )
    expect(await entries(b, idB)).toEqual([])
    const refused = await run(b, Routines.use((r) => r.runNow(routine.id)).pipe(Effect.flip))
    expect(refused.code).toBe("routine_elsewhere")

    // Moved: the first computer shows where it runs, and no longer runs it.
    await run(
      b,
      Routines.use((r) => r.runHere(routine.id)),
    )
    const moved = await waitFor(
      async () =>
        (
          await run(
            a,
            Routines.use((r) => r.list(idA)),
          )
        ).find((x) => x.id === routine.id),
      (x) => x?.runsOn === "MacBook 2",
    )
    expect(moved?.runsOn).toBe("MacBook 2")
    await run(
      a,
      Routines.use((r) => r.tick(later + 10 * 60_000)),
    )
    expect(await entries(a, idA)).toEqual([])
    await run(
      b,
      Routines.use((r) => r.tick(later + 10 * 60_000)),
    )
    expect((await entries(b, idB)).length).toBeGreaterThan(0)
  })

  test("a change from the other computer cannot make a routine or a workflow run here; the user here decides", async () => {
    const { a, b, ada } = await pair()
    const idA = await localId(a)
    const idB = await localId(b)
    const deviceB = await run(
      b,
      Devices.use((d) => Effect.sync(() => d.selfId)),
    )
    const routine = await run(
      a,
      Routines.use((r) =>
        r.create({
          serverId: idA,
          agentId: ada.id,
          name: "Check",
          prompt: "hello",
          schedule: { kind: "every", minutes: 2, from: Date.now() },
          place: { kind: "agent" },
        }),
      ),
    )
    const wf = await run(
      a,
      Workflows.use((w) =>
        w.create({
          serverId: idA,
          name: "Flow",
          trigger: { kind: "manual" },
          steps: [],
          edges: [],
        }),
      ),
    )
    const routineOnB = () =>
      run(
        b,
        Routines.use((r) => r.list(idB)),
      ).then((list) => list.find((x) => x.id === routine.id))
    const workflowOnB = () =>
      run(
        b,
        Workflows.use((w) => w.list(idB)),
      ).then((list) => list.find((x) => x.id === wf.id))
    expect((await waitFor(routineOnB, (x) => x !== undefined))?.runsOn).toBe("MacBook 1")
    expect((await waitFor(workflowOnB, (x) => x !== undefined))?.runsOn).toBe("MacBook 1")

    // The first computer writes "runs on the second computer" into both. It also renames them, in
    // the same change, so the test knows when the change has crossed.
    await SQL(
      a,
      "UPDATE routine SET runs_on = ?, name = 'Check 2' WHERE id = ?",
      deviceB,
      routine.id,
    )
    await SQL(a, "UPDATE workflow SET runs_on = ?, name = 'Flow 2' WHERE id = ?", deviceB, wf.id)
    expect((await waitFor(routineOnB, (x) => x?.name === "Check 2"))?.name).toBe("Check 2")
    expect((await waitFor(workflowOnB, (x) => x?.name === "Flow 2"))?.name).toBe("Flow 2")
    // The second computer keeps the old place, and does not run them at their time.
    expect((await routineOnB())?.runsOn).toBe("MacBook 1")
    expect((await workflowOnB())?.runsOn).toBe("MacBook 1")
    await run(
      b,
      Routines.use((r) => r.tick(Date.now() + 10 * 60_000)),
    )
    expect(
      await run(
        b,
        Routines.use((r) => r.calendar(idB, Date.now() - 86_400_000, Date.now() + 86_400_000)),
      ).then((list) => list.filter((e) => e.state !== "planned")),
    ).toEqual([])

    // An item that arrives for the first time and names the second computer is stored as running
    // on the first one.
    const now = Date.now()
    await SQL(
      a,
      `INSERT INTO routine (id, server_id, agent_id, name, prompt, schedule, channel_id, enabled,
         last_checked_at, created_at, updated_at, runs_on)
       VALUES ('crafted-routine', ?, ?, 'Crafted', 'hi', ?, NULL, 1, ?, ?, ?, ?)`,
      idA,
      ada.id,
      JSON.stringify({ kind: "every", minutes: 5, from: now }),
      now,
      now,
      now,
      deviceB,
    )
    await SQL(
      a,
      `INSERT INTO workflow (id, server_id, name, trigger, steps, edges, enabled, last_checked_at,
         created_at, updated_at, runs_on)
       VALUES ('crafted-workflow', ?, 'Crafted flow', ?, '[]', '[]', 1, ?, ?, ?, ?)`,
      idA,
      JSON.stringify({ kind: "manual" }),
      now,
      now,
      now,
      deviceB,
    )
    const craftedRoutine = await waitFor(
      async () =>
        (
          await run(
            b,
            Routines.use((r) => r.list(idB)),
          )
        ).find((x) => x.id === "crafted-routine"),
      (x) => x !== undefined,
    )
    const craftedWorkflow = await waitFor(
      async () =>
        (
          await run(
            b,
            Workflows.use((w) => w.list(idB)),
          )
        ).find((x) => x.id === "crafted-workflow"),
      (x) => x !== undefined,
    )
    expect(craftedRoutine?.runsOn).toBe("MacBook 1")
    expect(craftedRoutine?.nextRuns).toEqual([])
    expect(craftedWorkflow?.runsOn).toBe("MacBook 1")

    // The user of the second computer can still take it, with "Run on this computer".
    await run(
      b,
      Routines.use((r) => r.runHere(routine.id)),
    )
    expect((await routineOnB())?.runsOn).toBeNull()
  })

  /** A workflow on the first computer fires when a message that holds "deploy" is posted in a channel. */
  const watchedFlow = async () => {
    const { a, b, ada } = await pair()
    const idA = await localId(a)
    const make = (name: string) =>
      run(
        a,
        Channels.use((c) =>
          c.create({ serverId: idA, name, topic: "", memberIds: [ada.id], leadId: null }),
        ),
      )
    const watched = await make("Watched")
    const quiet = await make("Quiet")
    const wf = await run(
      a,
      Workflows.use((w) =>
        w.create({
          serverId: idA,
          name: "Flow",
          trigger: { kind: "channel", channelId: watched.id, contains: "deploy" },
          steps: [
            { id: "p", kind: "post", name: "p", x: 0, y: 0, channelId: quiet.id, text: "Ran" },
          ],
          edges: [],
        }),
      ),
    )
    const idB = await localId(b)
    const onB = await waitFor(
      async () =>
        (
          await run(
            b,
            Workflows.use((w) => w.list(idB)),
          )
        ).find((x) => x.id === wf.id),
      (x) => x !== undefined,
    )
    expect(onB?.runsOn).toBe("MacBook 1")
    await waitFor(
      async () =>
        (
          await run(
            b,
            Channels.use((c) => c.list(idB)),
          )
        ).length,
      (n) => n === 2,
    )
    const runsOnA = async () =>
      (
        await run(
          a,
          Workflows.use((w) => w.runs(wf.id)),
        )
      ).length
    /** A message that the second computer wrote `ageMs` ago by its own clock, which is `skewMs` off. */
    const postOld = async (id: string, text: string, ageMs: number, skewMs: number) => {
      const madeAt = Date.now() + skewMs - ageMs
      await SQL(
        b,
        `INSERT INTO channel_message (id, channel_id, author, parts, status, awaiting, created_at, finished_at)
         VALUES (?, ?, 'user', ?, 'done', 0, ?, ?)`,
        id,
        watched.id,
        JSON.stringify([{ kind: "text", text }]),
        madeAt,
        madeAt,
      )
      await waitFor(
        async () =>
          (
            await run(
              a,
              Channels.use((c) => c.history(watched.id)),
            )
          ).some((m) => JSON.stringify(m.parts).includes(text)),
        Boolean,
      )
      await new Promise((r) => setTimeout(r, 300))
    }
    return { a, b, watched, runsOnA, postOld }
  }

  test("a workflow with a channel trigger fires on its computer for a message of the other, unless the message is old", async () => {
    const { b, watched, runsOnA, postOld } = await watchedFlow()

    // A message that was sent now on the second computer fires it on the first one.
    await run(
      b,
      Channels.use((c) => c.post(watched.id, "please deploy now")),
    )
    expect(await waitFor(runsOnA, (n) => n === 1)).toBe(1)

    // A message that is 6 minutes old when it arrives fires nothing.
    await postOld("old-message", "old deploy", 6 * 60_000, 0)
    expect(await runsOnA()).toBe(1)
  })

  test("the age of a message uses the clock difference that the computers measured, so a wrong clock changes nothing", async () => {
    const { a, runsOnA, postOld } = await watchedFlow()
    const HOUR = 60 * 60_000
    const measure = (skew: number) =>
      SQL(a, "UPDATE sync_pair SET clock_offset = ? WHERE id = 1", skew)

    // The clock of the second computer is 2 hours behind. A message that is 1 minute old shows a
    // time that looks 2 hours old, but it fires the workflow.
    await measure(-2 * HOUR)
    await postOld("behind-new", "deploy behind new", 60_000, -2 * HOUR)
    expect(await waitFor(runsOnA, (n) => n === 1)).toBe(1)

    // The same clock, and a message that is 10 minutes old: too old, though its time looks new.
    await postOld("behind-old", "deploy behind old", 10 * 60_000, -2 * HOUR)
    expect(await runsOnA()).toBe(1)

    // The clock is 2 hours ahead. A young message fires, and an old one does not.
    await measure(2 * HOUR)
    await postOld("ahead-new", "deploy ahead new", 30_000, 2 * HOUR)
    expect(await waitFor(runsOnA, (n) => n === 2)).toBe(2)
    await postOld("ahead-old", "deploy ahead old", 10 * 60_000, 2 * HOUR)
    expect(await runsOnA()).toBe(2)
  })

  test("a card that waits on the other computer notices here, and the notice drops when it is answered there", async () => {
    const { a, b, ada } = await pair()
    const parts = (state: "waiting" | "done") =>
      JSON.stringify([
        {
          kind: "tool",
          id: "call-1",
          name: "run_command",
          label: "ls",
          state,
          input: "",
          output: "",
          ...(state === "waiting" ? { ask: { kind: "approval", summary: "Run ls" } } : {}),
        },
      ])
    await SQL(
      b,
      `INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('card-1', ?, 'agent', ?, 'streaming', ?)`,
      ada.id,
      parts("waiting"),
      Date.now(),
    )
    const attention = (rt: Rt) =>
      run(
        rt,
        Notifier.use((n) => Effect.sync(() => n.island().attention)),
      )
    const notice = await waitFor(
      () => attention(a),
      (x) => x !== null,
    )
    expect(notice?.callId).toBe("call-1")
    expect(notice?.agentId).toBe(ada.id)
    await SQL(b, `UPDATE message SET parts = ?, status = 'done' WHERE id = 'card-1'`, parts("done"))
    expect(
      await waitFor(
        () => attention(a),
        (x) => x === null,
      ),
    ).toBeNull()
  })

  test("a file of a message is copied from the computer where it was made, and an offline origin gives a plain error", async () => {
    const { a, b, ada } = await pair()
    mkdirSync(join(ada.workspace, "attachments"), { recursive: true })
    writeFileSync(join(ada.workspace, "attachments", "note.txt"), "hello")
    await SQL(
      a,
      `INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('file-1', ?, 'user', ?, 'done', ?)`,
      ada.id,
      JSON.stringify([
        { kind: "text", text: "See" },
        { kind: "file", name: "note.txt", path: "attachments/note.txt", size: 5 },
      ]),
      Date.now(),
    )
    await waitFor(
      async () =>
        (
          await run(
            b,
            Chat.use((c) => c.history(ada.id)),
          )
        ).messages.length,
      (n) => n === 1,
    )
    const here = (rt: Rt) =>
      run(
        rt,
        Sync.use((s) => Effect.sync(() => s.fileHere(ada.id, "attachments/note.txt", 5, "file-1"))),
      )
    expect(await here(a)).toBe(true)
    expect(await here(b)).toBe(false)
    await run(
      b,
      Sync.use((s) =>
        s.openFile({ agentId: ada.id, path: "attachments/note.txt", size: 5, messageId: "file-1" }),
      ),
    )
    expect(await here(b)).toBe(true)
    const copy = await run(
      b,
      Database.use((db) =>
        Effect.sync(() =>
          db.get<{ workspace: string }>("SELECT workspace FROM agent WHERE id = ?", ada.id),
        ),
      ),
    )
    expect(readFileSync(join(copy?.workspace ?? "", "attachments", "note.txt"), "utf8")).toBe(
      "hello",
    )
    expect(copy?.workspace).not.toBe(ada.workspace)

    // A path that leaves the attachments folder is refused.
    const refused = await run(
      b,
      Sync.use((s) =>
        s.openFile({ agentId: ada.id, path: "../secret.txt", size: 1, messageId: "file-1" }),
      ).pipe(Effect.flip),
    )
    expect(refused.code).toBe("invalid_input")

    // The origin is off: the file that is not here cannot be copied, and the error names it.
    writeFileSync(join(ada.workspace, "attachments", "later.txt"), "later")
    await SQL(
      a,
      `INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('file-2', ?, 'user', ?, 'done', ?)`,
      ada.id,
      JSON.stringify([{ kind: "file", name: "later.txt", path: "attachments/later.txt", size: 5 }]),
      Date.now(),
    )
    await waitFor(
      async () =>
        (
          await run(
            b,
            Chat.use((c) => c.history(ada.id)),
          )
        ).messages.length,
      (n) => n === 2,
    )
    await a.runtime.dispose()
    const offline = await waitFor(
      () =>
        run(
          b,
          Sync.use((s) =>
            s
              .openFile({
                agentId: ada.id,
                path: "attachments/later.txt",
                size: 5,
                messageId: "file-2",
              })
              .pipe(Effect.flip),
          ),
        ),
      (e) => e.code === "sync_file_offline",
    )
    expect(offline.code).toBe("sync_file_offline")
    expect(offline.detail).toBe("MacBook 1")
  })
  test("knowledge does not sync: a synced agent has no article, and sync reads and writes no knowledge row", async () => {
    const { a, b, ada } = await pair()
    const idA = await localId(a)
    const idB = await localId(b)
    const save = (rt: Rt, title: string) =>
      run(
        rt,
        Knowledge.use((k) => k.save(ada.id, { file: null, title, summary: "s", body: "Body." })),
      )
    const articles = async (rt: Rt) =>
      (
        await run(
          rt,
          Knowledge.use((k) => k.list(ada.id)),
        )
      ).articles.map((x) => x.title)
    const rows = (rt: Rt) =>
      run(
        rt,
        Database.use((db) =>
          Effect.sync(() => ({
            files: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_file")?.n,
            changes: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_change")?.n,
          })),
        ),
      )
    await save(a, "Alpha")
    expect(await articles(a)).toEqual(["Alpha"])
    // A change of the agent crosses; the article of the first computer does not.
    await run(
      a,
      Agents.use((x) => x.update(ada.id, { role: "Writer" })),
    )
    const roleOn = (rt: Rt, serverId: string) =>
      run(
        rt,
        Agents.use((x) => x.list(serverId, false)),
      ).then((l) => l.find((x) => x.id === ada.id)?.role)
    expect(
      await waitFor(
        () => roleOn(b, idB),
        (role) => role === "Writer",
      ),
    ).toBe("Writer")
    expect(await articles(b)).toEqual([])
    expect(await rows(b)).toEqual({ files: 0, changes: 0 })
    // The other way round: an article made on the second computer stays there.
    await save(b, "Beta")
    await run(
      b,
      Agents.use((x) => x.update(ada.id, { role: "Editor" })),
    )
    expect(
      await waitFor(
        () => roleOn(a, idA),
        (role) => role === "Editor",
      ),
    ).toBe("Editor")
    expect(await articles(a)).toEqual(["Alpha"])
    expect(await articles(b)).toEqual(["Beta"])
    expect(await rows(a)).toEqual({ files: 1, changes: 1 })
    expect(await rows(b)).toEqual({ files: 1, changes: 1 })
    // Deleting the agent here takes it away there. The article of each side goes with its own
    // agent record only.
    const agentRows = (rt: Rt) =>
      run(
        rt,
        Database.use((db) =>
          Effect.sync(() => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent")?.n ?? -1),
        ),
      )
    await run(
      a,
      Agents.use((x) => x.archive(ada.id)),
    )
    await run(
      a,
      Agents.use((x) => x.remove(ada.id)),
    )
    expect(
      await waitFor(
        () => agentRows(b),
        (n) => n === 0,
      ),
    ).toBe(0)
    expect(await rows(b)).toEqual({ files: 0, changes: 0 })
    // The article of the first computer went with its record there, and the second one is
    // untouched by a record that is gone: no row of knowledge is left on either side.
    expect(await rows(a)).toEqual({ files: 0, changes: 0 })
  })

  test("a workflow crosses with its canvas notes, a notify step, a condition that asks a model and the effort of a step; a note that changes crosses too", async () => {
    const { a, b, ada } = await pair()
    const idA = await localId(a)
    const idB = await localId(b)
    const wf = await run(
      a,
      Workflows.use((w) =>
        w.create({
          serverId: idA,
          name: "Notes flow",
          trigger: { kind: "manual" },
          steps: [
            {
              id: "s1",
              kind: "agent",
              name: "Write",
              x: 0,
              y: 0,
              agentId: ada.id,
              prompt: "Say hi",
              continueOnFailure: false,
              effort: "max",
            },
            {
              id: "s2",
              kind: "condition",
              name: "Friendly?",
              x: 1,
              y: 0,
              contains: "Is it friendly?",
              mode: "ask",
              provider: { accountId: "acc", model: "m" },
            },
            { id: "s3", kind: "notify", name: "Tell me", x: 2, y: 0, title: "Friendly" },
          ],
          edges: [
            { id: "e1", from: "s1", to: "s2" },
            { id: "e2", from: "s2", to: "s3", branch: "yes" },
          ],
          notes: [{ id: "n1", text: "Check the tone", tone: "green", x: 5, y: 6 }],
        }),
      ),
    )
    const onB = () =>
      run(
        b,
        Workflows.use((w) => w.list(idB)),
      ).then((list) => list.find((x) => x.id === wf.id))
    const arrived = await waitFor(onB, (x) => x !== undefined)
    expect(arrived?.notes).toEqual([
      { id: "n1", text: "Check the tone", tone: "green", x: 5, y: 6 },
    ])
    expect(arrived?.steps.map((s) => s.kind)).toEqual(["agent", "condition", "notify"])
    expect(arrived?.steps[0]).toMatchObject({ effort: "max" })
    expect(arrived?.steps[1]).toMatchObject({ mode: "ask", provider: { accountId: "acc" } })

    // A note that is moved and one that is added cross; the notes of both are the same.
    await run(
      a,
      Workflows.use((w) =>
        w.update(wf.id, {
          notes: [
            { id: "n1", text: "Check the tone", tone: "green", x: 50, y: 60 },
            { id: "n2", text: "Second", tone: "pink", x: 0, y: 0 },
          ],
        }),
      ),
    )
    const changed = await waitFor(onB, (x) => (x?.notes.length ?? 0) === 2)
    expect(changed?.notes.map((n) => [n.id, n.x])).toEqual([
      ["n1", 50],
      ["n2", 0],
    ])
    // And back: a note that is removed on the second computer goes from the first.
    await run(
      b,
      Workflows.use((w) => w.update(wf.id, { notes: [] })),
    )
    const gone = await waitFor(
      () =>
        run(
          a,
          Workflows.use((w) => w.list(idA)),
        ).then((list) => list.find((x) => x.id === wf.id)),
      (x) => (x?.notes.length ?? 1) === 0,
    )
    expect(gone?.notes).toEqual([])
  })

  test("while the computers sync, the switch to create and change agents counts as on and is locked; Stop syncing gives the earlier value back", async () => {
    const a = side("MacBook 1")
    const b = side("MacBook 2")
    // B opens A. A allowed B without the switch, as a link that was made before the switch.
    const entry = await link(a, b, false)
    const clientOn = (rt: Rt) =>
      run(
        rt,
        Devices.use((d) => Effect.sync(() => d.state().clients[0])),
      )
    expect(await clientOn(a)).toMatchObject({ canChange: false, canChangeLocked: false })

    await turnOn(a, b, entry.id, "merge")
    // A holds B as a client: the switch shows on and the user cannot turn it off.
    expect(
      await waitFor(
        () => clientOn(a),
        (c) => c?.canChangeLocked === true,
      ),
    ).toMatchObject({
      canChange: true,
      canChangeLocked: true,
    })
    // B holds A as a client too, because sync needs both ways. The same holds there.
    expect(
      await waitFor(
        () => clientOn(b),
        (c) => c?.canChangeLocked === true,
      ),
    ).toMatchObject({
      canChange: true,
      canChangeLocked: true,
    })
    const idOnA = (await clientOn(a))?.id ?? ""
    const off = await run(
      a,
      Devices.use((d) => d.setCanChange(idOnA, false).pipe(Effect.flip)),
    )
    expect(off.code).toBe("sync_locks_switch")
    // B really can make an agent on A now: the lock is what the server checks.
    const idA = await localId(a)
    const made = await run(
      b,
      Remote.use((r) =>
        Effect.promise(() =>
          r.invoke(idA, "agents.create", {
            serverId: idA,
            name: "FromB",
            role: "",
            instructions: "",
          }),
        ),
      ),
    )
    expect(made.ok).toBe(true)
    // The change goes to the other computer like any change of the server.
    expect(
      await waitFor(
        () => agentNames(b),
        (n) => n.includes("FromB"),
      ),
    ).toContain("FromB")

    await run(
      b,
      Sync.use((s) => s.stop(entry.id)),
    )
    expect(
      await waitFor(
        () => clientOn(a),
        (c) => c?.canChangeLocked === false,
      ),
    ).toMatchObject({
      canChange: false,
      canChangeLocked: false,
    })
    const refused = await run(
      b,
      Remote.use((r) =>
        Effect.promise(() =>
          r.invoke(idA, "agents.create", {
            serverId: idA,
            name: "AfterStop",
            role: "",
            instructions: "",
          }),
        ),
      ),
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok ? "" : refused.error.code).toBe("change_off")
  })
})
