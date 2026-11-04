import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import type { Agent, DevicesState, PlaceSection, RpcResult, UserSection } from "@robot/shared"
import { Effect } from "effect"
import { runRequest } from "../rpc.ts"
import { Activity } from "../services/Activity.ts"
import { Connections } from "../services/Connections.ts"
import { Database } from "../services/Database.ts"
import { Devices } from "../services/Devices.ts"
import { Handbook } from "../services/Handbook.ts"
import { Memory } from "../services/Memory.ts"
import { Providers } from "../services/Providers.ts"
import { Remote } from "../services/Remote.ts"
import { Servers } from "../services/Servers.ts"
import { testRuntime } from "../services/testing.ts"
import { pairRuntimes, waitFor } from "./pairing.testing.ts"

type Rt = ReturnType<typeof testRuntime>

// A model account with two models; one takes an effort level.
const model = Bun.serve({
  port: 0,
  // On 127.0.0.1 only, where the test connects. On all addresses, the system can give this server
  // a port that another program holds on 127.0.0.1, and then the test would reach that program.
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") {
      return Response.json({ data: [{ id: "model-b" }, { id: "o3", display_name: "O3" }] })
    }
    return new Response("not found", { status: 404 })
  },
})

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
  model.stop()
  for (const s of sides) await s.runtime.dispose()
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
  delete process.env.ROBOT_LINK_NEARBY_WAIT_MS
})

/** A server and a client that is paired with it. `canChange` is the switch of the Allow dialog. */
const pair = async (canChange: boolean | undefined) => {
  const server = side("MacBook 2")
  const client = side("MacBook 1")
  const { entry } = await pairRuntimes(server, client, { canChange })
  const serverId = entry.serverId
  const clientName = (
    await client.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.self())))
  ).name
  const clientLink = server.runtime.runPromise(
    Devices.use((d) => Effect.sync(() => d.state().clients[0]?.id ?? "")),
  )
  /** A request of the client over the link, as the window of the client makes it. */
  const ask = (method: string, input: unknown): Promise<RpcResult<unknown>> =>
    client.runtime.runPromise(
      Remote.use((r) => Effect.promise(() => r.invoke(serverId, method, input))),
    )
  /** A request that goes to the server as it is, also for a method that the client refuses. */
  const raw = async (method: string, input: unknown): Promise<string> => {
    try {
      await client.runtime.runPromise(
        Remote.use((r) => Effect.promise(() => r.request(entry.id, method, input, 5000))),
      )
      return "ok"
    } catch (error) {
      return (error as { code?: string }).code ?? "error"
    }
  }
  /** A request of the window of the server. */
  const onServer = (method: string, input: unknown) => runRequest(server.runtime, method, input)
  const account = await server.runtime.runPromise(
    Providers.use((p) =>
      p.connect({
        kind: "openai",
        name: "Work",
        baseUrl: `http://127.0.0.1:${model.port}/v1`,
        apiKey: "SECRET-KEY-OF-SERVER",
      }),
    ),
  )
  return { server, client, entry, serverId, clientName, clientLink, ask, raw, onServer, account }
}

const value = <T>(result: RpcResult<unknown>) => {
  if (!result.ok) throw new Error(`request failed: ${result.error.code}`)
  return result.value as T
}
const codeOf = (result: RpcResult<unknown>) => (result.ok ? "ok" : result.error.code)

const make = (serverId: string, name: string, extra: object = {}) => ({
  serverId,
  name,
  role: "",
  instructions: "Be brief.",
  ...extra,
})

describe("a linked device that may create and change agents (spec 012)", () => {
  test("it makes an agent: a new empty folder, the default level, the record, no path for it", async () => {
    const p = await pair(true)
    const created = value<Agent>(
      await p.ask(
        "agents.create",
        make(p.serverId, "Writer", {
          model: { accountId: p.account.id, model: "o3", effort: "low" },
        }),
      ),
    )
    expect(created.name).toBe("Writer")
    expect(created.permission).toBe("ask_risky")
    expect(created.model?.model).toBe("o3")
    expect(created.workspace).toBe("")
    expect(created.changedBy?.by).toBe(p.clientName)
    expect(JSON.stringify(created)).not.toContain("SECRET-KEY-OF-SERVER")

    // On the server: the folder exists, is empty, and sits in the default workspace folder.
    const here = value<Agent>(await p.onServer("agents.get", { id: created.id }))
    expect(here.workspace).toContain("workspaces")
    expect(existsSync(here.workspace)).toBe(true)
    expect(readdirSync(here.workspace)).toEqual([])
    expect(here.changedBy?.by).toBe(p.clientName)
    expect(typeof here.changedBy?.at).toBe("number")
    expect(p.server.events.some((e) => e.event === "agents.changed")).toBe(true)

    // The client reads the agent without the path, also in a list.
    const list = value<Agent[]>(
      await p.ask("agents.list", { serverId: p.serverId, archived: false }),
    )
    expect(list.map((a) => a.workspace)).toEqual([""])
    const one = value<Agent>(await p.ask("agents.get", { id: created.id }))
    expect(one.workspace).toBe("")
  })

  test("the user of the server who changes the agent clears the record", async () => {
    const p = await pair(true)
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    expect(created.changedBy).not.toBeNull()
    const after = value<Agent>(
      await p.onServer("agents.update", { id: created.id, patch: { role: "Editor" } }),
    )
    expect(after.changedBy).toBeNull()
    const again = value<Agent>(
      await p.ask("agents.update", { id: created.id, patch: { role: "Writer" } }),
    )
    expect(again.changedBy?.by).toBe(p.clientName)
  })

  test("it edits instructions, face, role and model, duplicates and archives", async () => {
    const p = await pair(true)
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    const edited = value<Agent>(
      await p.ask("agents.update", {
        id: created.id,
        patch: {
          instructions: "Write short.",
          role: "Writes",
          face: { shape: 2, hue: 3 },
          model: { accountId: p.account.id, model: "model-b", effort: null },
        },
      }),
    )
    expect(edited.instructions).toBe("Write short.")
    expect(edited.face).toEqual({ shape: 2, hue: 3 })
    expect(edited.model?.model).toBe("model-b")
    const copy = value<Agent>(await p.ask("agents.duplicate", { id: created.id, suffix: " copy" }))
    expect(copy.name).toBe("Writer copy")
    expect(copy.workspace).toBe("")
    const there = value<Agent>(await p.onServer("agents.get", { id: copy.id }))
    expect(there.workspace).not.toBe(
      value<Agent>(await p.onServer("agents.get", { id: created.id })).workspace,
    )
    expect(readdirSync(there.workspace)).toEqual([])
    const archived = value<Agent>(await p.ask("agents.archive", { id: created.id }))
    expect(archived.archived).toBe(true)
  })

  test("a request cannot name a folder or a path: the field is refused and nothing is made", async () => {
    const p = await pair(true)
    for (const field of ["workspace", "path", "folder", "dir", "workspacePath"]) {
      const result = await p.ask("agents.create", make(p.serverId, "Sneaky", { [field]: "/tmp/x" }))
      expect(codeOf(result)).toBe("invalid_input")
    }
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    const update = await p.ask("agents.update", {
      id: created.id,
      patch: { workspace: "/tmp/x" },
    })
    expect(codeOf(update)).toBe("invalid_input")
    // A field next to the patch is refused too, and a field of a nested object.
    expect(
      codeOf(await p.ask("agents.update", { id: created.id, patch: {}, workspace: "/tmp/x" })),
    ).toBe("invalid_input")
    expect(
      codeOf(
        await p.ask("agents.update", {
          id: created.id,
          patch: { face: { shape: 1, hue: 1, path: "/tmp/x" } },
        }),
      ),
    ).toBe("invalid_input")
    const names = value<Agent[]>(
      await p.onServer("agents.list", { serverId: p.serverId, archived: false }),
    )
    expect(names.map((a) => a.name)).toEqual(["Writer"])
    expect(
      value<Agent>(await p.onServer("agents.get", { id: created.id })).workspace,
    ).not.toContain("tmp/x")
  })

  test("the level starts at the default; stricter works, looser is refused against the level now", async () => {
    const p = await pair(true)
    // A level in the create request is refused: the server decides it.
    expect(
      codeOf(await p.ask("agents.create", make(p.serverId, "Loose", { permission: "full" }))),
    ).toBe("invalid_input")
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    expect(created.permission).toBe("ask_risky")

    const stricter = value<Agent>(
      await p.ask("agents.update", { id: created.id, patch: { permission: "ask_all" } }),
    )
    expect(stricter.permission).toBe("ask_all")
    for (const level of ["ask_risky", "full"]) {
      const result = await p.ask("agents.update", { id: created.id, patch: { permission: level } })
      expect(codeOf(result)).toBe("not_allowed")
    }
    // The same level is not looser.
    expect(
      codeOf(await p.ask("agents.update", { id: created.id, patch: { permission: "ask_all" } })),
    ).toBe("ok")

    // The user of the server makes the agent less careful; then a stricter level from the client
    // works, and the level that counts is the one on the server now.
    await p.onServer("agents.update", { id: created.id, patch: { permission: "full" } })
    expect(
      codeOf(await p.ask("agents.update", { id: created.id, patch: { permission: "ask_risky" } })),
    ).toBe("ok")
    expect(
      codeOf(await p.ask("agents.update", { id: created.id, patch: { permission: "full" } })),
    ).toBe("not_allowed")
    const now = value<Agent>(await p.onServer("agents.get", { id: created.id }))
    expect(now.permission).toBe("ask_risky")
  })

  test("a copy starts at the default level, also when the original is at Full access", async () => {
    const p = await pair(true)
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    await p.onServer("agents.update", { id: created.id, patch: { permission: "full" } })
    const copy = value<Agent>(await p.ask("agents.duplicate", { id: created.id, suffix: " copy" }))
    expect(copy.permission).toBe("ask_risky")
  })

  test("no request can add an Always allow rule or switch the memory of an agent", async () => {
    const p = await pair(true)
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    for (const patch of [
      { allow: ["shell"] },
      { rules: [{ kind: "shell" }] },
      { alwaysAllow: true },
      { memoryEnabled: false },
    ]) {
      expect(codeOf(await p.ask("agents.update", { id: created.id, patch }))).toBe("invalid_input")
    }
    const db = await p.server.runtime.runPromise(Database.use((d) => Effect.succeed(d)))
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permission_rule")?.n).toBe(0)
  })

  test("a model that the server does not offer is refused; an offered one works", async () => {
    const p = await pair(true)
    const unknown = [
      { accountId: "no-such-account", model: "o3", effort: null },
      { accountId: p.account.id, model: "no-such-model", effort: null },
      { accountId: p.account.id, model: "model-b", effort: "high" },
      { accountId: p.account.id, model: "o3", effort: "extreme" },
    ]
    for (const wanted of unknown) {
      const result = await p.ask("agents.create", make(p.serverId, "Writer", { model: wanted }))
      expect(codeOf(result)).toBe("model_not_found")
    }
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    expect(
      codeOf(
        await p.ask("agents.update", {
          id: created.id,
          patch: { model: { accountId: "no-such-account", model: "x", effort: null } },
        }),
      ),
    ).toBe("model_not_found")
    // An account that the user disconnected on the server is not offered.
    await p.server.runtime.runPromise(Providers.use((x) => x.disconnect(p.account.id)))
    expect(
      codeOf(
        await p.ask("agents.update", {
          id: created.id,
          patch: { model: { accountId: p.account.id, model: "o3", effort: "low" } },
        }),
      ),
    ).toBe("model_not_found")
    expect(value<unknown[]>(await p.ask("models.available", undefined))).toEqual([])
  })

  test("the models that a client may pick hold no key", async () => {
    const p = await pair(true)
    const choices = value<{ accountId: string; accountName: string; models: { id: string }[] }[]>(
      await p.ask("models.available", undefined),
    )
    expect(choices.map((c) => c.accountName)).toEqual(["Work"])
    expect(choices[0]?.models.map((m) => m.id)).toEqual(["model-b", "o3"])
    expect(JSON.stringify(choices)).not.toContain("SECRET-KEY-OF-SERVER")
    expect(JSON.stringify(choices)).not.toContain("127.0.0.1")
  })

  test("a name that is taken gives a plain error, also ignoring case and for a copy", async () => {
    const p = await pair(true)
    await p.onServer("agents.create", make(p.serverId, "Planner"))
    const first = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    expect(codeOf(await p.ask("agents.create", make(p.serverId, "writer")))).toBe(
      "agent_name_taken",
    )
    expect(codeOf(await p.ask("agents.create", make(p.serverId, "PLANNER")))).toBe(
      "agent_name_taken",
    )
    expect(codeOf(await p.ask("agents.update", { id: first.id, patch: { name: "planner" } }))).toBe(
      "agent_name_taken",
    )
    // Its own name, with another case, is not taken by itself.
    expect(codeOf(await p.ask("agents.update", { id: first.id, patch: { name: "WRITER" } }))).toBe(
      "ok",
    )
    const copy = value<Agent>(await p.ask("agents.duplicate", { id: first.id, suffix: " copy" }))
    const second = value<Agent>(await p.ask("agents.duplicate", { id: first.id, suffix: " copy" }))
    expect(copy.name).not.toBe(second.name)
  })

  test("a working agent cannot be archived by a client; after a stop it can", async () => {
    const p = await pair(true)
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    await p.server.runtime.runPromise(
      Activity.use((a) => Effect.sync(() => a.setWorking(created.id, p.serverId, true))),
    )
    expect(codeOf(await p.ask("agents.archive", { id: created.id }))).toBe("agent_working_archive")
    const still = value<Agent>(await p.onServer("agents.get", { id: created.id }))
    expect(still.archived).toBe(false)
    await p.server.runtime.runPromise(
      Activity.use((a) => Effect.sync(() => a.setWorking(created.id, p.serverId, false))),
    )
    expect(codeOf(await p.ask("agents.archive", { id: created.id }))).toBe("ok")
  })

  test("it cannot delete or restore, change an account or a setting, or reach the rest", async () => {
    const p = await pair(true)
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    value<Agent>(await p.ask("agents.archive", { id: created.id }))
    for (const [method, input] of [
      ["agents.delete", { id: created.id }],
      ["agents.restore", { id: created.id }],
      ["agents.setFaceImage", { id: created.id, dataUrl: null }],
      ["channels.delete", { id: "x" }],
      ["providers.connect", { kind: "custom", name: "X", baseUrl: "http://x", apiKey: "k" }],
      ["providers.remove", { accountId: p.account.id }],
      ["providers.disconnect", { accountId: p.account.id }],
      ["providers.list", undefined],
      ["settings.update", { patch: { workspaceRoot: "/tmp/x" } }],
      ["routines.list", undefined],
      // A linked device cannot make a routine, so the limit of 50 is never its business (009, 012).
      [
        "routines.create",
        {
          serverId: p.serverId,
          agentId: created.id,
          name: "X",
          prompt: "Y",
          schedule: { kind: "daily", times: ["09:00"] },
          place: { kind: "agent" },
        },
      ],
      ["routines.update", { id: "x", patch: { enabled: true } }],
      ["workflows.runHere", { id: "x" }],
      ["usage.get", undefined],
      ["data.export", undefined],
      ["data.import", undefined],
      ["browser.takeControl", { agentId: created.id }],
      ["devices.client.setChange", { id: "x", canChange: true }],
    ] as const) {
      expect(await p.raw(method, input)).toBe("not_allowed")
    }
    // Nothing changed: the agent is still there, archived, with its folder.
    const here = value<Agent>(await p.onServer("agents.get", { id: created.id }))
    expect(here.archived).toBe(true)
    expect(existsSync(here.workspace)).toBe(true)
    const accounts = await p.server.runtime.runPromise(Providers.use((x) => x.list))
    expect(accounts).toHaveLength(1)
  })

  test("it makes and changes channels, and edits memory", async () => {
    const p = await pair(true)
    const a = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    const b = value<Agent>(await p.ask("agents.create", make(p.serverId, "Planner")))
    const channel = value<{ id: string; name: string; leadId: string | null; memberIds: string[] }>(
      await p.ask("channels.create", {
        serverId: p.serverId,
        name: "Docs",
        topic: "Write the docs",
        memberIds: [a.id, b.id],
        leadId: a.id,
      }),
    )
    expect(channel.name).toBe("Docs")
    expect(channel.memberIds).toEqual([a.id, b.id])
    const changed = value<{ topic: string; leadId: string | null }>(
      await p.ask("channels.update", { id: channel.id, patch: { topic: "New", leadId: b.id } }),
    )
    expect(changed.topic).toBe("New")
    expect(changed.leadId).toBe(b.id)
    // A name that is taken, a member that is not on the server, and a field that is not known.
    expect(
      codeOf(
        await p.ask("channels.create", {
          serverId: p.serverId,
          name: "docs",
          topic: "",
          memberIds: [a.id],
          leadId: null,
        }),
      ),
    ).toBe("channel_name_taken")
    expect(
      codeOf(await p.ask("channels.update", { id: channel.id, patch: { memberIds: ["nope"] } })),
    ).toBe("agent_not_found")
    expect(
      codeOf(await p.ask("channels.update", { id: channel.id, patch: { archived: true } })),
    ).toBe("invalid_input")

    // The parent channel (spec 030, 012): set at the start and changed, with the rules of the tree.
    const site = value<{ id: string; parentId: string | null }>(
      await p.ask("channels.create", {
        serverId: p.serverId,
        name: "Site",
        topic: "",
        memberIds: [a.id],
        leadId: null,
        parentId: channel.id,
      }),
    )
    expect(site.parentId).toBe(channel.id)
    expect(
      codeOf(await p.ask("channels.update", { id: channel.id, patch: { parentId: site.id } })),
    ).toBe("parent_loop")
    expect(
      value<{ parentId: string | null }>(
        await p.ask("channels.update", { id: site.id, patch: { parentId: null } }),
      ).parentId,
    ).toBeNull()

    const item = value<{ id: string; text: string }>(
      await p.ask("memory.add", { agentId: a.id, text: "Likes tea" }),
    )
    expect(
      value<{ text: string }>(await p.ask("memory.update", { id: item.id, text: "Likes coffee" }))
        .text,
    ).toBe("Likes coffee")
    expect(
      value<{ text: string }[]>(await p.ask("memory.list", { agentId: a.id })).map((m) => m.text),
    ).toEqual(["Likes coffee"])
    expect(codeOf(await p.ask("memory.add", { agentId: a.id, text: "x".repeat(2000) }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("memory.add", { agentId: a.id, text: "ok", extra: 1 }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("memory.delete", { id: item.id }))).toBe("ok")
    expect(value<unknown[]>(await p.ask("memory.list", { agentId: a.id }))).toEqual([])
    // What the client changed is in the history of the server, as a change by the user.
    const rows = await p.server.runtime.runPromise(Memory.use((m) => m.history(a.id)))
    expect(rows.map((r) => [r.actor, r.kind])).toEqual([
      ["user", "deleted"],
      ["user", "edited"],
      ["user", "added"],
    ])
  })

  test("it sets the switch Read the handbook and the instructions of a channel, with the same limits as the server (spec 002, 004, 012)", async () => {
    const p = await pair(true)
    const off = value<Agent>(
      await p.ask("agents.create", make(p.serverId, "Writer", { readHandbook: false })),
    )
    expect(off.readHandbook).toBe(false)
    const on = value<Agent>(await p.ask("agents.create", make(p.serverId, "Planner")))
    expect(on.readHandbook).toBe(true)
    const flipped = value<Agent>(
      await p.ask("agents.update", { id: off.id, patch: { readHandbook: true } }),
    )
    expect(flipped.readHandbook).toBe(true)
    // A copy keeps the switch of the original.
    await p.ask("agents.update", { id: on.id, patch: { readHandbook: false } })
    const copy = value<Agent>(await p.ask("agents.duplicate", { id: on.id, suffix: " copy" }))
    expect(copy.readHandbook).toBe(false)
    expect(codeOf(await p.ask("agents.update", { id: on.id, patch: { readHandbook: "no" } }))).toBe(
      "invalid_input",
    )

    const channel = value<{ id: string; instructions: string }>(
      await p.ask("channels.create", {
        serverId: p.serverId,
        name: "Docs",
        topic: "",
        instructions: "Write a list.",
        memberIds: [off.id],
        leadId: null,
      }),
    )
    expect(channel.instructions).toBe("Write a list.")
    expect(
      value<{ instructions: string }>(
        await p.ask("channels.update", { id: channel.id, patch: { instructions: "Be kind." } }),
      ).instructions,
    ).toBe("Be kind.")
    // The server checks the limit and the secrets, so a client cannot go round them.
    expect(
      codeOf(
        await p.ask("channels.update", {
          id: channel.id,
          patch: { instructions: "x".repeat(4001) },
        }),
      ),
    ).toBe("channel_instructions_too_long")
    expect(
      codeOf(
        await p.ask("channels.update", {
          id: channel.id,
          patch: { instructions: "Use sk-abcdefghijklmnopqrstuvwxyz0123" },
        }),
      ),
    ).toBe("channel_instructions_secret")
    const listed = value<{ id: string; instructions: string }[]>(
      await p.onServer("channels.list", { serverId: p.serverId }),
    )
    expect(listed.find((c) => c.id === channel.id)?.instructions).toBe("Be kind.")
  })

  test("a request that is too large or has the wrong type is refused", async () => {
    const p = await pair(true)
    expect(codeOf(await p.ask("agents.create", make(p.serverId, "A".repeat(41))))).toBe(
      "invalid_input",
    )
    expect(
      codeOf(
        await p.ask(
          "agents.create",
          make(p.serverId, "Big", { instructions: "x".repeat(200_001) }),
        ),
      ),
    ).toBe("invalid_input")
    expect(
      codeOf(
        await p.ask("agents.create", make(p.serverId, "Face", { face: { shape: 99, hue: 0 } })),
      ),
    ).toBe("invalid_input")
    expect(codeOf(await p.ask("agents.create", { name: 5 }))).toBe("invalid_input")
    expect(codeOf(await p.ask("agents.create", "not an object"))).toBe("invalid_input")
    expect(codeOf(await p.ask("agents.update", { id: 5, patch: {} }))).toBe("invalid_input")
    // The id of another server is not this server.
    expect(codeOf(await p.ask("agents.create", make("another-server", "Writer")))).toBe(
      "invalid_input",
    )
  })

  test("with the switch off every change gets the error that names the server", async () => {
    const p = await pair(false)
    const attempts: [string, unknown][] = [
      ["agents.create", make(p.serverId, "Writer")],
      ["agents.update", { id: "x", patch: { role: "r" } }],
      ["agents.duplicate", { id: "x", suffix: " copy" }],
      ["agents.archive", { id: "x" }],
      [
        "channels.create",
        { serverId: p.serverId, name: "Docs", topic: "", memberIds: [], leadId: null },
      ],
      ["channels.update", { id: "x", patch: { topic: "t" } }],
      ["memory.list", { agentId: "x" }],
      ["memory.add", { agentId: "x", text: "t" }],
      ["memory.update", { id: "x", text: "t" }],
      ["memory.delete", { id: "x" }],
      ["handbook.save", { serverId: p.serverId, text: "Answer in Korean." }],
      ["handbook.restore", { serverId: p.serverId, versionId: "x" }],
      ["models.available", undefined],
    ]
    for (const [method, input] of attempts) {
      const result = await p.ask(method, input)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe("change_off")
        // The client names the server by the name that it shows for it.
        expect(result.error.message).toBe(p.entry.name)
      }
    }
    expect(
      value<Agent[]>(await p.onServer("agents.list", { serverId: p.serverId, archived: false })),
    ).toEqual([])
    // It can still read, as before.
    expect(codeOf(await p.ask("agents.list", { serverId: p.serverId, archived: false }))).toBe("ok")
    // It reads the handbook and its history too (spec 002, 012), and the handbook did not change.
    expect(codeOf(await p.ask("handbook.get", { serverId: p.serverId }))).toBe("ok")
    expect(codeOf(await p.ask("handbook.history", { serverId: p.serverId }))).toBe("ok")
    expect(
      value<{ text: string }>(await p.onServer("handbook.get", { serverId: p.serverId })).text,
    ).toBe("")
  })

  test("it reads the handbook with no switch, and saves and restores it only with the switch (spec 002, 012)", async () => {
    const p = await pair(true)
    const onServer = <T>(method: string, input: unknown) =>
      p.onServer(method, input).then((r) => value<T>(r))
    type Version = { id: string; text: string; source: string }
    expect(
      value<{ text: string }>(await p.ask("handbook.get", { serverId: p.serverId })).text,
    ).toBe("")

    // The client saves: the server holds the text and the history says that a device made it.
    const saved = value<{ text: string }>(
      await p.ask("handbook.save", { serverId: p.serverId, text: "Answer in Korean." }),
    )
    expect(saved.text).toBe("Answer in Korean.")
    expect((await onServer<{ text: string }>("handbook.get", { serverId: p.serverId })).text).toBe(
      "Answer in Korean.",
    )
    await p.ask("handbook.save", { serverId: p.serverId, text: "Answer in English." })
    const history = value<Version[]>(await p.ask("handbook.history", { serverId: p.serverId }))
    expect(history.map((v) => [v.text, v.source])).toEqual([
      ["Answer in English.", "device"],
      ["Answer in Korean.", "device"],
    ])

    // A restore from the client is a new version of the server, and the client reads it.
    const first = history.at(-1)
    const restored = value<{ text: string }>(
      await p.ask("handbook.restore", { serverId: p.serverId, versionId: first?.id ?? "" }),
    )
    expect(restored.text).toBe("Answer in Korean.")
    expect(
      value<Version[]>(await p.ask("handbook.history", { serverId: p.serverId })).map((v) => [
        v.text,
        v.source,
      ]),
    ).toEqual([
      ["Answer in Korean.", "restore"],
      ["Answer in English.", "device"],
      ["Answer in Korean.", "device"],
    ])

    // The server refuses what it refuses for the window of the server, with the reason.
    expect(
      codeOf(await p.ask("handbook.save", { serverId: p.serverId, text: "x".repeat(20_001) })),
    ).toBe("handbook_too_long")
    expect(
      codeOf(
        await p.ask("handbook.save", {
          serverId: p.serverId,
          text: "Use sk-abcdefghijklmnopqrstuvwxyz0123",
        }),
      ),
    ).toBe("handbook_secret")
    expect(
      codeOf(await p.ask("handbook.restore", { serverId: p.serverId, versionId: "nothing" })),
    ).toBe("version_not_found")
    // A request that is too large, has the wrong type, an extra field or the id of another server.
    expect(
      codeOf(await p.ask("handbook.save", { serverId: p.serverId, text: "x".repeat(200_001) })),
    ).toBe("invalid_input")
    expect(codeOf(await p.ask("handbook.save", { serverId: p.serverId, text: 5 }))).toBe(
      "invalid_input",
    )
    expect(
      codeOf(await p.ask("handbook.save", { serverId: p.serverId, text: "ok", source: "page" })),
    ).toBe("invalid_input")
    expect(codeOf(await p.ask("handbook.save", { serverId: "another-server", text: "ok" }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("handbook.get", { serverId: "another-server" }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("handbook.get", { serverId: p.serverId, extra: 1 }))).toBe(
      "invalid_input",
    )
    expect((await onServer<{ text: string }>("handbook.get", { serverId: p.serverId })).text).toBe(
      "Answer in Korean.",
    )

    // The client hears a change of the handbook, from the window of the server too.
    const heard = () => p.client.events.filter((e) => e.event === "handbook.changed").length
    const before = heard()
    await p.server.runtime.runPromise(
      Handbook.use((h) => h.save(p.serverId, "From the server.", "page")),
    )
    await waitFor(
      "the client did not hear the change",
      async () => heard(),
      (n) => n > before,
    )
    expect(
      value<{ text: string }>(await p.ask("handbook.get", { serverId: p.serverId })).text,
    ).toBe("From the server.")
  })

  test("a link that was paired with no answer to the switch has it off", async () => {
    const p = await pair(undefined)
    expect(codeOf(await p.ask("agents.create", make(p.serverId, "Writer")))).toBe("change_off")
    const state = await p.server.runtime.runPromise(
      Devices.use((d) => Effect.sync(() => d.state())),
    )
    expect(state.clients[0]?.canChange).toBe(false)
    // The column of the table starts at off for a link that exists before the switch does.
    const db = await p.server.runtime.runPromise(Database.use((d) => Effect.succeed(d)))
    const column = db
      .all<{ name: string; dflt_value: string | null; notnull: number }>(
        "PRAGMA table_info(device_link)",
      )
      .find((c) => c.name === "can_change")
    expect(column?.dflt_value).toBe("0")
    expect(column?.notnull).toBe(1)
  })

  test("the switch takes effect at once on a connection that is open", async () => {
    const p = await pair(true)
    const created = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    const id = await p.clientLink
    const state = (): Promise<DevicesState> =>
      p.server.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.state())))
    expect((await state()).clients[0]?.canChange).toBe(true)

    await p.server.runtime.runPromise(Devices.use((d) => d.setCanChange(id, false)))
    // The client is still online; its next change fails, and it still reads.
    expect(
      await p.client.runtime.runPromise(
        Remote.use((r) => Effect.sync(() => r.stateOf(p.entry.id))),
      ),
    ).toBe("online")
    const refused = await p.ask("agents.update", { id: created.id, patch: { role: "Late" } })
    expect(codeOf(refused)).toBe("change_off")
    expect(value<Agent>(await p.onServer("agents.get", { id: created.id })).role).toBe("")
    expect(codeOf(await p.ask("agents.get", { id: created.id }))).toBe("ok")

    await p.server.runtime.runPromise(Devices.use((d) => d.setCanChange(id, true)))
    expect(codeOf(await p.ask("agents.update", { id: created.id, patch: { role: "Back" } }))).toBe(
      "ok",
    )
  })

  test("the summary holds the value; a device hears a change of its switch, and only a change", async () => {
    const p = await pair(true)
    const id = await p.clientLink
    const summary = async () =>
      (await p.client.runtime.runPromise(
        Remote.use((r) =>
          Effect.promise(() => r.request(p.entry.id, "server.summary", undefined, 5000)),
        ),
      )) as { canChange: boolean }
    const tile = async () =>
      (await p.client.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.servers()))))[0]
    const changes = () => p.client.events.filter((e) => e.event === "servers.changed").length
    const set = (on: boolean) =>
      p.server.runtime.runPromise(Devices.use((d) => d.setCanChange(id, on)))

    expect((await summary()).canChange).toBe(true)
    await waitFor(
      "the tile did not show that the client may change",
      tile,
      (t) => t?.canChange === true,
    )
    await set(false)
    await waitFor(
      "the tile did not show that the client may not change",
      tile,
      (t) => t?.canChange === false,
    )
    expect((await summary()).canChange).toBe(false)
    // The same value again is not a change: the device hears nothing.
    const before = changes()
    await set(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(changes()).toBe(before)
    await set(true)
    await waitFor(
      "the tile did not show that the client may change again",
      tile,
      (t) => t?.canChange === true,
    )
    expect((await summary()).canChange).toBe(true)
  })

  test("the server tile of the client says whether it may change agents, and follows the server", async () => {
    const p = await pair(true)
    const id = await p.clientLink
    const tile = async () =>
      (await p.client.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.servers()))))[0]
    expect(
      (
        await waitFor(
          "the tile did not show that the client may change",
          tile,
          (t) => t?.canChange === true,
        )
      )?.canChange,
    ).toBe(true)

    // The server turns the switch off: the tile follows at once, without a request of the client.
    await p.server.runtime.runPromise(Devices.use((d) => d.setCanChange(id, false)))
    expect(
      (await waitFor("the tile did not follow the switch off", tile, (t) => t?.canChange === false))
        ?.canChange,
    ).toBe(false)
    await p.server.runtime.runPromise(Devices.use((d) => d.setCanChange(id, true)))
    expect(
      (await waitFor("the tile did not follow the switch on", tile, (t) => t?.canChange === true))
        ?.canChange,
    ).toBe(true)
    // The window of the client is told about each change of the tile.
    expect(p.client.events.filter((e) => e.event === "servers.changed").length).toBeGreaterThan(1)
  })

  test("the user cannot change the switch of a device that does not exist or is not a client", async () => {
    const p = await pair(true)
    const result = await p.server.runtime.runPromiseExit(
      Devices.use((d) => d.setCanChange("no-such-device", true)),
    )
    expect(result._tag).toBe("Failure")
    expect(JSON.stringify(result)).toContain("device_not_found")
  })

  test("while the computers sync, the switch counts as on and cannot be turned off", async () => {
    const p = await pair(false)
    const id = await p.clientLink
    let locked = false
    await p.server.runtime.runPromise(
      Devices.use((d) => Effect.sync(() => d.bindSyncLock(() => locked))),
    )
    const entry = () =>
      p.server.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.state().clients[0])))
    expect(await entry()).toMatchObject({ canChange: false, canChangeLocked: false })

    locked = true
    expect(await entry()).toMatchObject({ canChange: true, canChangeLocked: true })
    // The client may change agents now, and the user of the server cannot turn the switch off.
    expect(codeOf(await p.ask("agents.create", make(p.serverId, "Writer")))).toBe("ok")
    const exit = await p.server.runtime.runPromiseExit(
      Devices.use((d) => d.setCanChange(id, false)),
    )
    expect(JSON.stringify(exit)).toContain("sync_locks_switch")

    // After "Stop syncing" the value from before comes back.
    locked = false
    expect(await entry()).toMatchObject({ canChange: false, canChangeLocked: false })
    expect(codeOf(await p.ask("agents.create", make(p.serverId, "Planner")))).toBe("change_off")
    // A value that the user set before the sync stays, too.
    await p.server.runtime.runPromise(Devices.use((d) => d.setCanChange(id, true)))
    locked = true
    expect(await entry()).toMatchObject({ canChange: true, canChangeLocked: true })
    locked = false
    expect(await entry()).toMatchObject({ canChange: true, canChangeLocked: false })
  })

  test("the server of this test knows its own id", async () => {
    const p = await pair(true)
    const local = await p.server.runtime.runPromise(Servers.use((s) => s.local))
    expect(local.id).toBe(p.serverId)
  })
})

describe("sections and knowledge on a linked server (spec 001, 012, 016)", () => {
  /** The requests of the window that make or change a section, or that open knowledge or files. */
  const own: readonly (readonly [string, unknown])[] = [
    ["sections.create", { serverId: "x", kind: "agent", name: "Team" }],
    ["sections.rename", { id: "x", name: "Team" }],
    ["sections.move", { id: "x", direction: "up" }],
    ["sections.delete", { id: "x" }],
    ["places.move", { kind: "agent", id: "x", sectionId: null }],
    // Skills are made and changed, and "Make a skill" from a task, an article or an item, on the
    // computer only (spec 012, 017). A client reads the list of one agent for its command list.
    ["skills.list", { serverId: "x" }],
    // The delete of an agent is on the computer only (spec 012). So is the count of the skills
    // that it takes along (spec 002, 017): a client never sees that confirm text.
    ["agents.delete", { id: "x" }],
    ["skills.onlyFor", { agentId: "x" }],
    [
      "skills.create",
      { serverId: "x", name: "N", description: "", instructions: "i", agentIds: null },
    ],
    ["skills.update", { id: "x", name: "N", description: "", instructions: "i", agentIds: null }],
    ["skills.duplicate", { id: "x", suffix: " copy" }],
    ["skills.setEnabled", { id: "x", enabled: false }],
    ["skills.delete", { id: "x" }],
    ["skills.draft", { requestId: "r", source: { kind: "task", id: "x" } }],
    ["skills.draft", { requestId: "r", source: { kind: "memory", id: "x" } }],
    ["skills.draftCancel", { requestId: "r" }],
    // Connections are added and changed on the computer only, and they never sync (spec 012, 018).
    ["connections.list", undefined],
    [
      "connections.save",
      {
        connection: {
          name: "Notes",
          kind: "program",
          command: "notes-server",
          args: [],
          folder: "",
          env: [],
          address: "",
          headers: [],
          agents: "all",
        },
        confirmed: true,
      },
    ],
    ["connections.test", { id: "x" }],
    ["connections.setEnabled", { id: "x", enabled: true }],
    ["connections.setTool", { id: "x", tool: "echo", enabled: false }],
    ["connections.setTrust", { id: "x", trust: true }],
    ["connections.held", { id: "x" }],
    ["connections.accept", { id: "x", tools: [{ name: "echo", key: "k" }] }],
    ["connections.delete", { id: "x" }],
    ["knowledge.list", { agentId: "x" }],
    ["knowledge.get", { agentId: "x", file: "a.md" }],
    ["knowledge.save", { agentId: "x", file: "a.md", text: "t" }],
    ["knowledge.delete", { agentId: "x", file: "a.md" }],
    ["knowledge.deleteSource", { agentId: "x", name: "s" }],
    ["knowledge.openSource", { agentId: "x", name: "s" }],
    ["knowledge.openFolder", { agentId: "x" }],
    ["knowledge.changes", { agentId: "x" }],
    ["knowledge.change", { agentId: "x", changeId: "c" }],
    ["knowledge.undo", { agentId: "x", changeId: "c" }],
    ["knowledge.findings", { agentId: "x" }],
    ["agentFile.export", { serverId: "x", agentIds: [] }],
    ["agentFile.open", { serverId: "x" }],
    ["agentFile.apply", { serverId: "x", model: null, pick: [] }],
    ["checklists.forAgent", { agentId: "x" }],
    ["checklists.forWorkflow", { workflowId: "x" }],
    ["workflowFile.export", { serverId: "x", workflowIds: [] }],
    ["workflowFile.open", { serverId: "x" }],
    ["workflowFile.apply", { serverId: "x", pick: [] }],
  ]

  const sectionsOf = async (p: Awaited<ReturnType<typeof pair>>) =>
    value<PlaceSection[]>(await p.onServer("places.list", { serverId: p.serverId }))

  test("a client cannot reach them, with the switch on or off, and nothing changes", async () => {
    for (const switchOn of [true, false]) {
      const p = await pair(switchOn)
      const server = value<Agent>(await p.onServer("agents.create", make(p.serverId, "Ada")))
      for (const [method, input] of own) {
        // The method is in the value, so a failure names the method (and the switch).
        expect({ switchOn, method, code: await p.raw(method, input) }).toEqual({
          switchOn,
          method,
          code: "not_allowed",
        })
        // The handler of the window is not reached through the dispatcher of a linked device.
        const viaDispatch = await p.client.runtime.runPromise(
          Remote.use((r) => Effect.promise(() => r.invoke(p.serverId, method, input))),
        )
        expect({ switchOn, method, ok: codeOf(viaDispatch) === "ok" }).toEqual({
          switchOn,
          method,
          ok: false,
        })
      }
      // No section was made, no knowledge of the agent was opened, no file was written.
      const lists = await sectionsOf(p)
      expect(lists.flatMap((s) => s.sections)).toEqual([])
      // No connection was made on the server by a request of a client.
      expect(await p.server.runtime.runPromise(Connections.use((c) => c.list))).toEqual([])
      expect(value<Agent>(await p.onServer("agents.get", { id: server.id })).knowledgeEnabled).toBe(
        true,
      )
    }
  }, 40_000)

  test("a client cannot name a section or the knowledge switch when it makes or changes", async () => {
    const p = await pair(true)
    const section = value<UserSection>(
      await p.onServer("sections.create", { serverId: p.serverId, kind: "agent", name: "Team" }),
    )
    const channelSection = value<UserSection>(
      await p.onServer("sections.create", { serverId: p.serverId, kind: "channel", name: "Docs" }),
    )
    const made = value<Agent>(await p.ask("agents.create", make(p.serverId, "Writer")))
    // A field that is not on the list of a client refuses the whole request.
    expect(
      codeOf(await p.ask("agents.create", make(p.serverId, "Other", { sectionId: section.id }))),
    ).toBe("invalid_input")
    expect(
      codeOf(await p.ask("agents.update", { id: made.id, patch: { sectionId: section.id } })),
    ).toBe("invalid_input")
    expect(
      codeOf(await p.ask("agents.update", { id: made.id, patch: { knowledgeEnabled: false } })),
    ).toBe("invalid_input")
    expect(
      codeOf(
        await p.ask("channels.create", {
          serverId: p.serverId,
          name: "Docs",
          topic: "",
          memberIds: [made.id],
          leadId: null,
          sectionId: channelSection.id,
        }),
      ),
    ).toBe("invalid_input")
    const channel = value<{ id: string }>(
      await p.ask("channels.create", {
        serverId: p.serverId,
        name: "Docs",
        topic: "",
        memberIds: [made.id],
        leadId: null,
      }),
    )
    expect(
      codeOf(await p.ask("channels.update", { id: channel.id, patch: { sectionId: null } })),
    ).toBe("invalid_input")
    // What the client made starts in no section, and the knowledge of the agent stays on.
    const there = value<Agent>(await p.onServer("agents.get", { id: made.id }))
    expect(there.sectionId).toBeNull()
    expect(there.knowledgeEnabled).toBe(true)
    const places = await sectionsOf(p)
    expect(places.flatMap((s) => s.sections.flatMap((u) => u.places))).toEqual([])
  }, 30_000)

  test("the list of places carries the sections and the section of each place; a change is pushed", async () => {
    const p = await pair(false)
    const ada = value<Agent>(await p.onServer("agents.create", make(p.serverId, "Ada")))
    const bob = value<Agent>(await p.onServer("agents.create", make(p.serverId, "Bob")))
    const team = value<UserSection>(
      await p.onServer("sections.create", { serverId: p.serverId, kind: "agent", name: "Team" }),
    )
    await p.onServer("places.move", { kind: "agent", id: ada.id, sectionId: team.id })

    const list = value<PlaceSection[]>(await p.ask("places.list", { serverId: p.serverId }))
    const agents = list.find((s) => s.id === "agents")
    expect(agents?.sections.map((s) => s.name)).toEqual(["Team"])
    expect(agents?.sections[0]?.places.map((x) => x.id)).toEqual([ada.id])
    expect(agents?.sections[0]?.places[0]?.sectionId).toBe(team.id)
    expect(agents?.places.map((x) => x.id)).toEqual([bob.id])
    expect(agents?.places[0]?.sectionId).toBeNull()

    const pushes = () => p.client.events.filter((e) => e.event === "places.changed").length
    const before = pushes()
    await p.onServer("sections.rename", { id: team.id, name: "Crew" })
    await waitFor("no push after the rename of a section", pushes, (n) => n > before)
    expect(pushes()).toBeGreaterThan(before)
    const next = pushes()
    await p.onServer("places.move", { kind: "agent", id: bob.id, sectionId: team.id })
    await waitFor("no push after the move of a place", pushes, (n) => n > next)
    expect(pushes()).toBeGreaterThan(next)
    const after = value<PlaceSection[]>(await p.ask("places.list", { serverId: p.serverId }))
    const crew = after.find((s) => s.id === "agents")?.sections[0]
    expect(crew?.name).toBe("Crew")
    expect(crew?.places.map((x) => x.id).sort()).toEqual([ada.id, bob.id].sort())
  }, 30_000)

  test("the list of places carries the role line of each agent; a change of it is pushed (spec 012)", async () => {
    const p = await pair(false)
    const ada = value<Agent>(
      await p.onServer("agents.create", make(p.serverId, "Ada", { role: "Designer" })),
    )
    const bob = value<Agent>(await p.onServer("agents.create", make(p.serverId, "Bob")))
    const channel = value<{ id: string }>(
      await p.onServer("channels.create", {
        serverId: p.serverId,
        name: "launch",
        topic: "",
        memberIds: [ada.id, bob.id],
        leadId: null,
      }),
    )
    const roleOf = async (id: string) => {
      const list = value<PlaceSection[]>(await p.ask("places.list", { serverId: p.serverId }))
      const place = list.flatMap((s) => [...s.places, ...s.sections.flatMap((u) => u.places)])
      return place.find((x) => x.id === id)
    }

    // The answer holds the role line of an agent. An agent with none, and a channel, send none.
    expect((await roleOf(ada.id))?.role).toBe("Designer")
    expect(await roleOf(bob.id)).not.toHaveProperty("role")
    expect(await roleOf(channel.id)).not.toHaveProperty("role")

    // A change of the role line is pushed, and the next answer holds it.
    const pushes = () => p.client.events.filter((e) => e.event === "places.changed").length
    const before = pushes()
    await p.onServer("agents.update", { id: ada.id, patch: { role: "Writer" } })
    await waitFor("no push after the change of the role line", pushes, (n) => n > before)
    expect(pushes()).toBeGreaterThan(before)
    expect((await roleOf(ada.id))?.role).toBe("Writer")

    // A change of the name is pushed too.
    const next = pushes()
    await p.onServer("agents.update", { id: ada.id, patch: { name: "Ada L" } })
    await waitFor("no push after the change of the name", pushes, (n) => n > next)
    expect((await roleOf(ada.id))?.name).toBe("Ada L")

    // Removing the role line removes the field, so the badge leaves.
    const last = pushes()
    await p.onServer("agents.update", { id: ada.id, patch: { role: "" } })
    await waitFor("no push after the removal of the role line", pushes, (n) => n > last)
    expect(await roleOf(ada.id)).not.toHaveProperty("role")
  }, 30_000)
})
