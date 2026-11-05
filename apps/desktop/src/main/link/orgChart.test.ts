import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  CHANGE_METHODS,
  type ChartModel,
  CLIENT_BLOCKED_PAGES,
  CLIENT_METHODS,
  isChangeMethod,
  isClientMethod,
  isRoutedMethod,
  PUSHED_EVENTS,
  type RpcResult,
} from "@robot/shared"
import { Effect } from "effect"
import { runRequest } from "../rpc.ts"
import { Activity } from "../services/Activity.ts"
import { Agents } from "../services/Agents.ts"
import { Database } from "../services/Database.ts"
import { Devices } from "../services/Devices.ts"
import { Organizations } from "../services/Organizations.ts"
import { Remote } from "../services/Remote.ts"
import { Servers } from "../services/Servers.ts"
import { testRuntime } from "../services/testing.ts"
import { pairRuntimes } from "./pairing.testing.ts"

// The org chart of a linked server (spec 029, 012). A client asks the server for a ready model and
// the server pushes it when it changes. Both computers run the real link, the real Devices
// service and the real request handlers.

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
  for (const s of sides) await s.runtime.dispose().catch(() => {})
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
  delete process.env.ROBOT_LINK_NEARBY_WAIT_MS
})

/** A server and a client that is paired with it. `canChange` is the switch of the Allow dialog. */
const pair = async (canChange: boolean) => {
  const server = side("MacBook 2")
  const client = side("MacBook 1")
  const { entry } = await pairRuntimes(server, client, { canChange })
  const serverId = entry.serverId
  const clientDevice = await client.runtime.runPromise(
    Devices.use((d) => Effect.sync(() => d.self())),
  )
  /** A request of the window of the client, which goes over the link. */
  const ask = (method: string, input: unknown): Promise<RpcResult<unknown>> =>
    client.runtime.runPromise(
      Remote.use((r) => Effect.promise(() => r.invoke(serverId, method, input))),
    )
  const model = async () => value<ChartModel>(await ask("orgChart.model", { serverId }))
  const makeAgent = (rt: Rt, serverIdOf: string, name: string, role: string) =>
    rt.runtime.runPromise(
      Agents.use((a) => a.create({ serverId: serverIdOf, name, role, instructions: "Work." })),
    )
  const onClient = async () => (await client.runtime.runPromise(Servers.use((s) => s.local))).id
  return {
    server,
    client,
    serverId,
    clientDevice,
    ask,
    model,
    entry,
    onServerAgent: (name: string, role: string) => makeAgent(server, serverId, name, role),
    onClientAgent: async (name: string, role: string) =>
      makeAgent(client, await onClient(), name, role),
  }
}

const value = <T>(result: RpcResult<unknown>) => {
  if (!result.ok) throw new Error(`request failed: ${result.error.code}`)
  return result.value as T
}
const codeOf = (result: RpcResult<unknown>) => (result.ok ? "ok" : result.error.code)

const names = (model: ChartModel) => model.orgs.flatMap((c) => c.nodes.map((n) => n.name))

/** The pushes of the org chart that the window of the client got from a linked server. */
const pushesOf = (client: Rt, serverId: string) =>
  client.events.filter((e) => e.event === "orgChart.model" && e.server === serverId)

describe("a client and the org chart of a server (spec 029, 012)", () => {
  test("the request is on the list of a client, needs no switch, and the window routes it", () => {
    expect(isClientMethod("orgChart.model")).toBe(true)
    expect(isChangeMethod("orgChart.model")).toBe(false)
    expect((CHANGE_METHODS as readonly string[]).includes("orgChart.model")).toBe(false)
    expect(isRoutedMethod("orgChart.model")).toBe(true)
    // The snapshot of the window of this computer is not a request of a client.
    expect(isClientMethod("orgChart.get")).toBe(false)
    expect(isRoutedMethod("orgChart.get")).toBe(false)
    // The server pushes the model, and the page is no longer blocked on a client.
    expect(PUSHED_EVENTS).toContain("orgChart.model")
    expect((PUSHED_EVENTS as readonly string[]).includes("orgChart.changed")).toBe(false)
    expect((CLIENT_BLOCKED_PAGES as readonly string[]).includes("orgchart")).toBe(false)
    // The other pages of the window that a client cannot use stay blocked.
    expect([...CLIENT_BLOCKED_PAGES]).toEqual(["today", "usage"])
    expect(CLIENT_METHODS.filter((m) => m.startsWith("orgChart."))).toEqual(["orgChart.model"])
  })

  test("a client with only the link gets the chart of the server, never of its own agents", async () => {
    const p = await pair(false)
    const ada = await p.onServerAgent("Ada", "Writes docs")
    const bo = await p.onServerAgent("Bo", "Checks facts")
    // The client has agents too. They must not show in the chart of the server.
    await p.onClientAgent("Zed", "Lives on the client")
    await p.server.runtime.runPromise(
      Organizations.use((o) =>
        o.create({
          serverId: p.serverId,
          name: "Docs",
          memberIds: [ada.id, bo.id],
          leadId: ada.id,
        }),
      ),
    )
    const model = await p.model()
    expect(model.empty).toBe(false)
    expect(names(model)).toEqual(["Ada", "Bo"])
    expect(model.orgs.map((c) => [c.name, c.memberCount, c.leadKey !== null])).toEqual([
      ["Docs", 2, true],
    ])
    const [lead, other] = model.orgs[0]?.nodes ?? []
    expect(lead).toMatchObject({ name: "Ada", role: "Writes docs", isLead: true })
    expect(other).toMatchObject({ name: "Bo", role: "Checks facts", isLead: false })
    expect(JSON.stringify(model)).not.toContain("Zed")
    // The model is the chart that the server itself would draw.
    const there = value<ChartModel>(
      await runRequest(p.server.runtime, "orgChart.model", { serverId: p.serverId }),
    )
    expect(model).toEqual(there)
  })

  test("the switch 'Can create and change agents' makes no difference: both get the same chart", async () => {
    const off = await pair(false)
    const on = await pair(true)
    for (const p of [off, on]) {
      await p.onServerAgent("Ada", "Writes docs")
    }
    // The ids and the times differ between two servers; the shape of the chart does not.
    const shape = (m: ChartModel) =>
      JSON.stringify({
        root: m.root,
        empty: m.empty,
        capped: m.handoffsCapped,
        nodes: m.orgs.map((c) => [c.name, c.memberCount, c.nodes.map((n) => n.name)]),
      })
    expect(shape(await off.model())).toBe(shape(await on.model()))
    expect(names(await off.model())).toEqual(["Ada"])
    expect(names(await on.model())).toEqual(["Ada"])
    // The switch is off on one of them, and the request is still answered.
    expect(
      await off.client.runtime.runPromise(
        Remote.use((r) => Effect.promise(() => r.invoke(off.serverId, "agents.create", {}))),
      ),
    ).toMatchObject({ ok: false, error: { code: "change_off" } })
  })

  test("a server with no agent gives the empty chart", async () => {
    const p = await pair(false)
    expect(await p.model()).toMatchObject({ empty: true, root: null, orgs: [], lines: [] })
  })

  test("the request names this server; any other id or any other field is refused", async () => {
    const p = await pair(false)
    await p.onServerAgent("Ada", "Writes docs")
    expect(codeOf(await p.ask("orgChart.model", { serverId: "another-server" }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("orgChart.model", { serverId: p.serverId, extra: 1 }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("orgChart.model", {}))).toBe("invalid_input")
    expect(codeOf(await p.ask("orgChart.model", undefined))).toBe("invalid_input")
    expect(codeOf(await p.ask("orgChart.model", { serverId: "" }))).toBe("invalid_input")
  })

  test("a client cannot ask for the snapshot of the window, and a device that sends it gets 'Not allowed'", async () => {
    const p = await pair(false)
    expect(codeOf(await p.ask("orgChart.get", undefined))).toBe("not_allowed")
    const direct = await runRequest(p.server.runtime, "orgChart.get", undefined, {
      id: "device",
      name: "Pixel",
    })
    expect(direct).toEqual({ ok: false, error: { code: "not_allowed", message: "Not allowed" } })
  })

  test("the model holds names, roles, states, counts and the cut label, and nothing else about a task", async () => {
    const p = await pair(false)
    const ada = await p.onServerAgent("Ada", "Writes docs")
    const db = await p.server.runtime.runPromise(Database.use((d) => Effect.succeed(d)))
    const label = `Draft the release notes ${"x".repeat(120)}`
    db.run(
      `INSERT INTO task (id, agent_id, prompt, label, source, source_id, state, created_at, started_at)
       VALUES ('t1', ?, 'PROMPT-TEXT-THAT-MUST-NOT-LEAVE', ?, 'chat', NULL, 'running', ?, ?)`,
      ada.id,
      label,
      Date.now(),
      Date.now(),
    )
    await p.server.runtime.runPromise(
      Activity.use((a) => Effect.sync(() => a.setWorking(ada.id, p.serverId, true))),
    )
    const model = await p.model()
    const node = model.orgs[0]?.nodes[0]
    expect(node?.state).toBe("working")
    // The label is the label of the task, cut at 90 characters with "…".
    expect([...(node?.label ?? "")]).toHaveLength(90)
    expect(node?.label?.endsWith("…")).toBe(true)
    expect(node?.label?.startsWith("Draft the release notes")).toBe(true)
    expect(model.orgs[0]?.counts).toEqual({ working: 1, waiting: 0, idle: 0, offline: 0 })
    // Nothing else about the task is in the model.
    const text = JSON.stringify(model)
    expect(text).not.toContain("PROMPT-TEXT-THAT-MUST-NOT-LEAVE")
    expect(text).not.toContain("prompt")
    expect(Object.keys(node ?? {}).sort()).toEqual(
      [
        "agentId",
        "alsoIn",
        "face",
        "gotFrom",
        "handedTo",
        "isLead",
        "key",
        "label",
        "name",
        "parent",
        "role",
        "state",
      ].sort(),
    )
  })

  test("a hand-off reaches the client as a line with its count and the two names, not as tasks", async () => {
    const p = await pair(false)
    const ada = await p.onServerAgent("Ada", "Writes docs")
    const bo = await p.onServerAgent("Bo", "Checks facts")
    const db = await p.server.runtime.runPromise(Database.use((d) => Effect.succeed(d)))
    for (const id of ["h1", "h2"]) {
      db.run(
        `INSERT INTO task (id, agent_id, prompt, label, source, source_id, state, created_at,
           started_at, agent_message)
         VALUES (?, ?, 'secret words', 'Please check', 'agent', ?, 'done', ?, ?, 'send')`,
        id,
        bo.id,
        ada.id,
        Date.now() - 1000,
        Date.now() - 1000,
      )
    }
    const model = await p.model()
    expect(model.lines.filter((l) => l.kind === "handoff")).toEqual([
      expect.objectContaining({ count: 2, fromName: "Ada", toName: "Bo" }),
    ])
    expect(JSON.stringify(model)).not.toContain("secret words")
    expect(JSON.stringify(model)).not.toContain("Please check")
  })
})

describe("the server pushes the chart (spec 012, 'Messages')", () => {
  test("a task that starts reaches the client as a push with the label, within a moment, tagged with the server", async () => {
    const p = await pair(false)
    const ada = await p.onServerAgent("Ada", "Writes docs")
    // Read once, as the page does when it opens.
    expect(names(await p.model())).toEqual(["Ada"])
    const before = pushesOf(p.client, p.serverId).length

    const db = await p.server.runtime.runPromise(Database.use((d) => Effect.succeed(d)))
    db.run(
      `INSERT INTO task (id, agent_id, prompt, label, source, state, created_at, started_at)
       VALUES ('t1', ?, 'p', 'Draft the release notes', 'chat', 'running', ?, ?)`,
      ada.id,
      Date.now(),
      Date.now(),
    )
    const started = Date.now()
    await p.server.runtime.runPromise(
      Activity.use((a) => Effect.sync(() => a.setWorking(ada.id, p.serverId, true))),
    )
    // The push of the new agent may come first. Wait for the one that shows the task.
    const push = await waitFor(
      () =>
        pushesOf(p.client, p.serverId)
          .slice(before)
          .findLast((e) => (e.payload as ChartModel).orgs[0]?.nodes[0]?.state === "working"),
      (e) => e !== undefined,
    )
    expect(push).toBeDefined()
    const model = push?.payload as ChartModel
    expect(model.orgs[0]?.nodes[0]).toMatchObject({
      name: "Ada",
      state: "working",
      label: "Draft the release notes",
    })
    // The push is for the window of the client: it names the linked server, so a view of this
    // computer does not take it.
    expect(push?.server).toBe(p.serverId)
    // The whole model is in the push: the page reads nothing again.
    expect(model.empty).toBe(false)
    // The time is shown, not asserted: a busy computer pauses a run (the end-to-end test checks
    // the one second of the spec).
    console.log(`org chart push after ${Date.now() - started} ms`)
  })

  test("a change of a name and of a member is pushed; a look with no change pushes nothing", async () => {
    const p = await pair(false)
    const ada = await p.onServerAgent("Ada", "Writes docs")
    await p.model()
    const before = pushesOf(p.client, p.serverId).length
    await p.server.runtime.runPromise(Agents.use((a) => a.update(ada.id, { name: "Ada L" })))
    await waitFor(
      () => pushesOf(p.client, p.serverId).at(-1),
      (e) => e !== undefined && names(e.payload as ChartModel).join() === "Ada L",
    )
    const after = pushesOf(p.client, p.serverId)
    expect(after.length).toBeGreaterThan(before)
    expect(names(after.at(-1)?.payload as ChartModel)).toEqual(["Ada L"])
    // Quiet: no more pushes while nothing changes.
    const count = after.length
    await new Promise((r) => setTimeout(r, 400))
    expect(pushesOf(p.client, p.serverId)).toHaveLength(count)
  })
})

describe("a server that is not online, and a device that was removed (spec 012, 029)", () => {
  test("the chart is never cached: after the server went away the same read gives 'offline', while a cached read still answers", async () => {
    const p = await pair(false)
    await p.onServerAgent("Ada", "Writes docs")
    // Both reads work while the server is online. Only the second one is kept on the client.
    expect(names(await p.model())).toEqual(["Ada"])
    expect(codeOf(await p.ask("agents.list", { serverId: p.serverId, archived: false }))).toBe("ok")

    // The computer stops to answer, as when the app quits: it accepts no connection and closes
    // the open ones.
    await p.server.runtime.runPromise(Devices.use((d) => Effect.promise(() => d.setAccept(false))))
    const gone = await waitFor(
      () => p.ask("orgChart.model", { serverId: p.serverId }),
      (r) => !r.ok,
    )
    expect(codeOf(gone)).toBe("offline")
    // The state is not online, so the page shows "<server name> is offline." and no chart.
    const state = await p.client.runtime.runPromise(
      Remote.use((r) =>
        Effect.sync(() => r.entries().find((e) => e.serverId === p.serverId)?.state),
      ),
    )
    expect(state).not.toBe("online")
    // A cached read still answers from the cache: the contrast shows that the chart is not in it.
    expect(codeOf(await p.ask("agents.list", { serverId: p.serverId, archived: false }))).toBe("ok")
    // Nothing of the chart is on the disk of the client either.
    await new Promise((r) => setTimeout(r, 700)) // the cache writes its files after 400 ms
    const folder = join(p.client.dataDir, "link-cache")
    const files = existsSync(folder) ? walk(folder) : []
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      expect(text).not.toContain("orgChart")
      expect(text).not.toContain('"handoffsCapped"')
      expect(text).not.toContain('"alsoIn"')
    }
  })

  test("after Remove access the request is refused and the push stops", async () => {
    const p = await pair(false)
    const ada = await p.onServerAgent("Ada", "Writes docs")
    expect(names(await p.model())).toEqual(["Ada"])
    const before = pushesOf(p.client, p.serverId).length

    await p.server.runtime.runPromise(Devices.use((d) => d.removeClient(p.clientDevice.id)))
    await waitFor(
      () =>
        p.client.runtime.runPromise(
          Remote.use((r) => Effect.sync(() => r.entries().find((e) => e.serverId === p.serverId))),
        ),
      (e) => e?.state === "not_allowed",
    )
    // The next request fails. Nothing of the chart is left to read.
    const refused = await p.ask("orgChart.model", { serverId: p.serverId })
    expect(codeOf(refused)).toBe("not_allowed")

    // The server changes after the removal. The removed device is told nothing.
    await p.server.runtime.runPromise(Agents.use((a) => a.update(ada.id, { name: "Ada Secret" })))
    await new Promise((r) => setTimeout(r, 500))
    const late = pushesOf(p.client, p.serverId).slice(before)
    expect(JSON.stringify(late)).not.toContain("Ada Secret")
  })

  test("a window of the server that reads its snapshot does not keep a client from its push, and no window gets the model", async () => {
    const p = await pair(false)
    const ada = await p.onServerAgent("Ada", "Writes docs")
    expect(names(await p.model())).toEqual(["Ada"])
    const before = pushesOf(p.client, p.serverId).length
    // The window of the server reads its own snapshot right after a change, as a reload would.
    await p.server.runtime.runPromise(Agents.use((a) => a.update(ada.id, { name: "Ada L" })))
    await runRequest(p.server.runtime, "orgChart.get", undefined)
    await waitFor(
      () => pushesOf(p.client, p.serverId).at(-1),
      (e) => e !== undefined && names(e.payload as ChartModel).join() === "Ada L",
    )
    expect(pushesOf(p.client, p.serverId).length).toBeGreaterThan(before)
    // The model is for linked devices only: no window of the server got it.
    expect(p.server.events.some((e) => e.event === "orgChart.model")).toBe(false)
  })
})

function walk(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
