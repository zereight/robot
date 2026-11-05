import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  AGENT_FILE_MAX_AGENTS,
  AGENT_FILE_MAX_BYTES,
  AGENT_FILE_MAX_CHANNELS,
  AGENT_NAME_MAX,
  type AgentFileFailure,
  type AgentFilePreview,
  type AgentModel,
  type AgentPick,
  charLength,
  ROUTINES_MAX,
  SKILLS_MAX,
} from "@robot/shared"
import { Effect, Exit, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { AgentFiles } from "./AgentFiles.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Checklists } from "./Checklists.ts"
import { Database } from "./Database.ts"
import { Handbook } from "./Handbook.ts"
import { Memory } from "./Memory.ts"
import { secretKey } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Skills } from "./Skills.ts"
import { testPlatform } from "./testing.ts"

const KEY = "stored-key-0123456789abcdef"

/** The ticks of a review where the user ticks every part. */
const everything = (preview: AgentFilePreview | null): AgentPick[] =>
  (preview?.agents ?? []).map((a, index) => ({
    index,
    instructions: true,
    routines: a.routines.map((_, j) => j),
  }))
const SECRET_LOOKALIKE = "sk-looks-like-a-key-0123456789abcdef"

/** One app with an in-memory database. `pick` sets what the file dialogs answer. */
const setup = async () => {
  const { platform, dataDir } = testPlatform()
  const pick = { save: undefined as string | undefined, open: undefined as string | undefined }
  const runtime = ManagedRuntime.make(
    appLayer({
      platform: {
        ...platform,
        pickAgentFileSave: async () => pick.save,
        pickAgentFile: async () => pick.open,
      },
      databaseFile: ":memory:",
      localServerName: "Test computer",
      emit: () => {},
      secrets: Secrets.memory,
    }),
  )
  const run = runtime.runPromise
  const exit = runtime.runPromiseExit
  const server = await run(Servers.use((s) => s.local))
  // An account that agents can use as their model.
  const db = await run(Database.use((d) => Effect.succeed(d)))
  db.run(
    "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('acc1', 'custom', 'Mine', 'http://127.0.0.1:9/v1', 1)",
  )
  await run(Secrets.use((s) => Effect.sync(() => s.set(secretKey("acc1"), KEY))))
  const model: AgentModel = { accountId: "acc1", model: "picked-model", effort: null }

  const make = (name: string, over: { role?: string; instructions?: string } = {}) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: server.id,
          name,
          role: over.role ?? "",
          instructions: over.instructions ?? "",
        }),
      ),
    )
  const list = () => run(Agents.use((a) => a.list(server.id, false)))
  const exportTo = (path: string, agentIds: readonly string[]) => {
    pick.save = path
    return run(AgentFiles.use((f) => f.export({ serverId: server.id, agentIds })))
  }
  const openFile = (path: string) => {
    pick.open = path
    return run(AgentFiles.use((f) => f.open(server.id)))
  }
  /** Opens the file and imports every part of it: each agent, its instructions and routines. */
  const importFile = (path: string, picked: AgentModel | null = model) =>
    openFile(path).then((preview) =>
      run(
        AgentFiles.use((f) =>
          f.import({ serverId: server.id, model: picked, pick: everything(preview) }),
        ),
      ),
    )
  const importExit = (path: string, picked: AgentModel | null = model) =>
    openFile(path).then((preview) =>
      exit(
        AgentFiles.use((f) =>
          f.import({ serverId: server.id, model: picked, pick: everything(preview) }),
        ),
      ),
    )
  const write = (name: string, value: unknown) => {
    const path = join(dataDir, name)
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
    return path
  }
  return {
    run,
    exit,
    pick,
    server,
    db,
    dataDir,
    model,
    make,
    list,
    exportTo,
    openFile,
    importFile,
    importExit,
    write,
  }
}

type App = Awaited<ReturnType<typeof setup>>

const file = (agents: unknown) => ({ format: "robot-agents", version: 1, agents })

/** The code of the first failure of an exit. */
const failure = (result: Exit.Exit<unknown, { code: string; detail?: string }>) => {
  if (!Exit.isFailure(result)) return undefined
  const reason = result.cause.reasons.find((r) => "error" in r)
  return reason && "error" in reason
    ? (reason.error as { code: string; detail?: string })
    : undefined
}

const routineOf = (app: App, agentId: string) =>
  app
    .run(Routines.use((r) => r.list(app.server.id)))
    .then((all) => all.filter((x) => x.agentId === agentId))

describe("export", () => {
  test("the file holds name, role line, instructions, face and routines, and nothing else", async () => {
    const app = await setup()
    const ada = await app.make("Ada", { role: "Researcher", instructions: "Be brief." })
    await app.run(
      Agents.use((a) =>
        a.update(ada.id, { model: app.model, permission: "full", face: { shape: 3, hue: 4 } }),
      ),
    )
    await app.run(Memory.use((m) => m.add(ada.id, "Ada likes tea", "user")))
    app.db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at)
       VALUES ('m1', ?, 'user', ?, 'done', 1, 1)`,
      ada.id,
      JSON.stringify([{ kind: "text", text: "a private chat line" }]),
    )
    await app.run(
      Routines.use((r) =>
        r.create({
          serverId: app.server.id,
          agentId: ada.id,
          name: "Digest",
          prompt: "Summarise.",
          schedule: { kind: "daily", times: ["08:30"] },
          place: { kind: "agent" },
        }),
      ),
    )
    await app.make("Bob")

    const path = join(app.dataDir, "agents.json")
    const result = await app.exportTo(path, [ada.id])
    expect(result).toEqual({ path, count: 1, channels: 0, skills: 0, handbook: false })

    const text = readFileSync(path, "utf8")
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({
      format: "robot-agents",
      version: 2,
      agents: [
        {
          name: "Ada",
          role: "Researcher",
          instructions: "Be brief.",
          face: { shape: 3, hue: 4 },
          routines: [
            { name: "Digest", prompt: "Summarise.", schedule: { kind: "daily", times: ["08:30"] } },
          ],
        },
      ],
    })
    for (const absent of [
      ada.workspace,
      "acc1",
      "picked-model",
      "full",
      "Ada likes tea",
      "a private chat line",
      KEY,
      "Bob",
    ])
      expect(text).not.toContain(absent)
  })

  test("text that looks like a secret, and a stored key, are hidden", async () => {
    const app = await setup()
    const ada = await app.make("Ada", {
      role: `Uses ${KEY}`,
      instructions: `Call the API with ${SECRET_LOOKALIKE}.`,
    })
    await app.run(
      Routines.use((r) =>
        r.create({
          serverId: app.server.id,
          agentId: ada.id,
          name: "Check",
          prompt: `Use ${SECRET_LOOKALIKE} and ${KEY}`,
          schedule: { kind: "cron", expr: "0 * * * *" },
          place: { kind: "agent" },
        }),
      ),
    )
    const path = join(app.dataDir, "agents.json")
    await app.exportTo(path, [ada.id])
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(SECRET_LOOKALIKE)
    expect(text).toContain("[redacted]")
  })

  test("a routine that posts in a channel is written without its place", async () => {
    const app = await setup()
    const ada = await app.make("Ada")
    app.db.run(
      `INSERT INTO routine (id, server_id, agent_id, name, prompt, schedule, channel_id, enabled, last_checked_at, created_at, updated_at)
       VALUES ('r1', ?, ?, 'Post', 'Hi', ?, 'some-channel', 0, 1, 1, 1)`,
      app.server.id,
      ada.id,
      JSON.stringify({ kind: "cron", expr: "0 9 * * *" }),
    )
    const path = join(app.dataDir, "agents.json")
    await app.exportTo(path, [ada.id])
    const routine = JSON.parse(readFileSync(path, "utf8")).agents[0].routines[0]
    expect(Object.keys(routine).sort()).toEqual(["name", "prompt", "schedule"])
  })

  test("refuses no agents, more than 40, and an agent of no server; a cancelled dialog writes nothing", async () => {
    const app = await setup()
    const ada = await app.make("Ada")
    const path = join(app.dataDir, "agents.json")
    const refuse = async (ids: string[]) => {
      app.pick.save = path
      return failure(
        await app.exit(AgentFiles.use((f) => f.export({ serverId: app.server.id, agentIds: ids }))),
      )?.code
    }
    expect(await refuse([])).toBe("agent_file_empty")
    expect(
      await refuse(Array.from({ length: AGENT_FILE_MAX_AGENTS + 1 }, (_, i) => `id-${i}`)),
    ).toBe("agent_file_too_many")
    expect(await refuse(["missing"])).toBe("agent_not_found")
    expect(existsSync(path)).toBe(false)

    const cancelled = await app.exportTo(undefined as unknown as string, [ada.id])
    expect(cancelled).toEqual({ path: null, count: 0, channels: 0, skills: 0, handbook: false })
  })
})

describe("import", () => {
  /** Two agents with a routine each, exported from one app. */
  const twoAgents = async () => {
    const source = await setup()
    const ada = await source.make("Ada", { role: "Researcher", instructions: "Be brief." })
    const bob = await source.make("Bob", { instructions: "Be kind." })
    for (const [agent, name] of [
      [ada, "Digest"],
      [bob, "Weekly"],
    ] as const)
      await source.run(
        Routines.use((r) =>
          r.create({
            serverId: source.server.id,
            agentId: agent.id,
            name,
            prompt: `Run ${name}`,
            schedule: { kind: "daily", times: ["09:00"] },
            place: { kind: "agent" },
          }),
        ),
      )
    const path = join(source.dataDir, "agents.json")
    await source.exportTo(path, [ada.id, bob.id])
    return path
  }

  test("two agents exported, imported in an empty app: two agents with the picked model and paused routines", async () => {
    const path = await twoAgents()
    const app = await setup()
    const preview = await app.openFile(path)
    expect(preview?.agents.map((a) => [a.name, a.fileName, a.routines.length])).toEqual([
      ["Ada", null, 1],
      ["Bob", null, 1],
    ])

    const result = await app.importFile(path)
    expect(result).toEqual({ agents: 2, routines: 2, channels: 0, skills: 0, handbook: false })

    const agents = await app.list()
    expect(agents.map((a) => a.name)).toEqual(["Ada", "Bob"])
    for (const agent of agents) {
      expect(agent.model).toEqual(app.model)
      expect(agent.permission).toBe("ask_risky")
      expect(agent.workspace.startsWith(app.dataDir)).toBe(true)
      expect(existsSync(agent.workspace)).toBe(true)
    }
    const ada = agents.find((a) => a.name === "Ada")
    expect(ada).toMatchObject({ role: "Researcher", instructions: "Be brief." })

    const routines = await app.run(Routines.use((r) => r.list(app.server.id)))
    expect(routines.map((r) => r.name).sort()).toEqual(["Digest", "Weekly"])
    for (const routine of routines) {
      expect(routine.enabled).toBe(false)
      expect(routine.nextRuns).toEqual([])
      expect(routine.place).toEqual({ kind: "agent" })
    }
    expect(await routineOf(app, ada?.id ?? "")).toHaveLength(1)
  })

  test("an import without a model makes agents without a model", async () => {
    const path = await twoAgents()
    const app = await setup()
    await app.importFile(path, null)
    expect((await app.list()).map((a) => a.model)).toEqual([null, null])
  })

  test("a model of an account that does not exist is refused, and nothing is made", async () => {
    const path = await twoAgents()
    const app = await setup()
    const result = await app.importExit(path, { accountId: "gone", model: "m", effort: null })
    expect(failure(result)?.code).toBe("provider_not_found")
    expect(await app.list()).toEqual([])
  })

  test("the file holds no switch 'Main agent', and an import never takes the flag from the main agent or gives it (spec 002, 'Agent file')", async () => {
    const app = await setup()
    const ada = await app.make("Ada")
    await app.run(Agents.use((a) => a.update(ada.id, { isMain: true })))
    const path = join(app.dataDir, "main.json")
    await app.exportTo(path, [ada.id])
    const text = readFileSync(path, "utf8")
    expect(text.toLowerCase()).not.toContain("main")
    expect(JSON.parse(text).agents[0]).not.toHaveProperty("isMain")

    // A file that names the flag anyway is read as any other unknown field: it reaches no agent.
    const forged = app.write(
      "forged.json",
      file([{ name: "Zed", role: "", instructions: "", isMain: true, main: true }]),
    )
    await app.importFile(path)
    await app.importFile(forged)
    const agents = await app.list()
    expect(agents.map((a) => [a.name, a.isMain])).toEqual([
      ["Ada", true],
      ["Ada 2", false],
      ["Zed", false],
    ])
  })

  test("import makes new agents only: an agent that exists is not changed", async () => {
    const path = await twoAgents()
    const app = await setup()
    const ada = await app.make("Ada", { role: "Mine", instructions: "Keep me." })
    await app.importFile(path)
    const agents = await app.list()
    expect(agents.map((a) => a.name)).toEqual(["Ada", "Ada 2", "Bob"])
    const kept = agents.find((a) => a.id === ada.id)
    expect(kept).toMatchObject({ name: "Ada", role: "Mine", instructions: "Keep me." })
    expect(kept?.model).toBeNull()
    expect(await routineOf(app, ada.id)).toEqual([])
  })

  test("a taken name gets a number, ignoring case, and the preview says so", async () => {
    const path = await twoAgents()
    const app = await setup()
    await app.make("ADA")
    await app.make("bob 2")
    await app.make("BOB")
    const preview = await app.openFile(path)
    expect(preview?.agents.map((a) => [a.name, a.fileName])).toEqual([
      ["Ada 2", "Ada"],
      ["Bob 3", "Bob"],
    ])
    await app.importFile(path)
    expect((await app.list()).map((a) => a.name).sort()).toEqual(
      ["ADA", "Ada 2", "BOB", "Bob 3", "bob 2"].sort(),
    )
  })

  test("a taken name that archived agents hold counts too", async () => {
    const path = await twoAgents()
    const app = await setup()
    const ada = await app.make("Ada")
    await app.run(Agents.use((a) => a.archive(ada.id)))
    await app.importFile(path)
    expect((await app.list()).map((a) => a.name)).toEqual(["Ada 2", "Bob"])
  })

  test("the number stays inside the name limit", async () => {
    const long = "x".repeat(AGENT_NAME_MAX)
    const shortened = "x".repeat(AGENT_NAME_MAX - 2)
    const app = await setup()
    await app.make(long)
    // The second name is the one that the first gets, so it is numbered too.
    const path = app.write("long.json", file([{ name: long }, { name: `${shortened} 2` }]))
    await app.importFile(path)
    const names = (await app.list()).map((a) => a.name)
    expect(names.every((n) => charLength(n) <= AGENT_NAME_MAX)).toBe(true)
    expect(names.sort()).toEqual([long, `${shortened} 2`, `${shortened} 3`].sort())
  })

  test("every routine starts paused, whatever its schedule", async () => {
    const app = await setup()
    const path = app.write(
      "kinds.json",
      file([
        {
          name: "Ada",
          routines: [
            { name: "A", prompt: "p", schedule: { kind: "every", minutes: 1, from: 0 } },
            { name: "B", prompt: "p", schedule: { kind: "once", at: Date.now() + 60_000 } },
            { name: "C", prompt: "p", schedule: { kind: "weekly", days: [0, 6], time: "07:00" } },
          ],
        },
      ]),
    )
    await app.importFile(path)
    const routines = await app.run(Routines.use((r) => r.list(app.server.id)))
    expect(routines).toHaveLength(3)
    expect(routines.every((r) => !r.enabled && r.nextRuns.length === 0)).toBe(true)
    // A paused routine does not run: a check at any time starts no task.
    await app.run(Routines.use((r) => r.tick(Date.now() + 3 * 60_000)))
    expect(app.db.all("SELECT 1 FROM task")).toEqual([])
  })

  test("text that looks like a secret is hidden, and a stored key too", async () => {
    const app = await setup()
    const path = app.write(
      "secret.json",
      file([
        {
          name: "Ada",
          role: `Key ${KEY}`,
          instructions: `Use ${SECRET_LOOKALIKE} here.`,
          routines: [
            {
              name: "R",
              prompt: `with ${SECRET_LOOKALIKE}`,
              schedule: { kind: "cron", expr: "0 * * * *" },
            },
          ],
        },
      ]),
    )
    await app.importFile(path)
    const [ada] = await app.list()
    expect(ada?.role).toBe("Key [redacted]")
    expect(ada?.instructions).toBe("Use [redacted] here.")
    const [routine] = await app.run(Routines.use((r) => r.list(app.server.id)))
    expect(routine?.prompt).toBe("with [redacted]")
  })

  test("fields that the format does not define never reach the agent", async () => {
    const app = await setup()
    const path = app.write(
      "extra.json",
      file([
        {
          name: "Ada",
          model: { accountId: "other", model: "other-model", effort: "high" },
          workspace: join(app.dataDir, "elsewhere"),
          permission: "full",
          memoryEnabled: false,
          apiKey: KEY,
        },
      ]),
    )
    await app.importFile(path)
    const [ada] = await app.list()
    expect(ada?.model).toEqual(app.model)
    expect(ada?.permission).toBe("ask_risky")
    expect(ada?.memoryEnabled).toBe(true)
    expect(ada?.workspace.startsWith(join(app.dataDir, "workspaces"))).toBe(true)
    expect(existsSync(join(app.dataDir, "elsewhere"))).toBe(false)
  })

  test("an imported agent has the same fields as an agent made by hand, including memory and knowledge", async () => {
    const app = await setup()
    const fields = { role: "Researcher", instructions: "Be brief.", face: { shape: 3, hue: 4 } }
    await app.importFile(app.write("one.json", file([{ name: "Ada", ...fields }])))
    const byHand = await app.run(
      Agents.use((a) =>
        a.create({ serverId: app.server.id, name: "Bob", model: app.model, ...fields }),
      ),
    )
    const imported = (await app.list()).find((a) => a.name === "Ada")
    expect(imported).toMatchObject({
      permission: "ask_risky",
      memoryEnabled: true,
      knowledgeEnabled: true,
    })
    // Every field must match, except the ones that belong to one agent. A field that a later
    // slice adds to the agent is compared too, so an import cannot miss it.
    const own = new Set(["id", "name", "workspace", "createdAt"])
    const shared = (agent: object) =>
      Object.fromEntries(Object.entries(agent).filter(([key]) => !own.has(key)))
    expect(shared(imported ?? {})).toEqual(shared(byHand))
    expect(Object.keys(imported ?? {}).sort()).toEqual(Object.keys(byHand).sort())
  })

  describe("refused files", () => {
    const refuse = async (app: App, path: string) => {
      app.pick.open = path
      const result = await app.exit(AgentFiles.use((f) => f.open(app.server.id)))
      expect(await app.list()).toEqual([])
      return failure(result)
    }

    test("two agents with one name", async () => {
      const app = await setup()
      const path = app.write("dup.json", file([{ name: "Ada" }, { name: "ada" }]))
      expect((await refuse(app, path))?.code).toBe("agent_file_duplicate")
    })

    test("more than 40 agents; exactly 40 is fine", async () => {
      const app = await setup()
      const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Agent ${i}` }))
      expect((await refuse(app, app.write("41.json", file(many(41)))))?.code).toBe(
        "agent_file_too_many",
      )
      await app.importFile(app.write("40.json", file(many(40))))
      expect(await app.list()).toHaveLength(40)
    })

    test("a file larger than 10 MB, before it is read", async () => {
      const app = await setup()
      const path = app.write("big.json", " ".repeat(AGENT_FILE_MAX_BYTES + 1))
      expect((await refuse(app, path))?.code).toBe("agent_file_too_large")
    })

    test("a file that is not an agent file, a newer version, and a file that is missing", async () => {
      const app = await setup()
      expect((await refuse(app, app.write("a.json", "not json")))?.code).toBe("agent_file_format")
      expect(
        (await refuse(app, app.write("b.json", { ...file([{ name: "Ada" }]), version: 3 })))?.code,
      ).toBe("agent_file_version")
      expect((await refuse(app, join(app.dataDir, "missing.json")))?.code).toBe("file_unreadable")
    })

    test("a value that is not valid names its place", async () => {
      const app = await setup()
      const path = app.write("name.json", file([{ name: "Ada" }, { name: "x".repeat(41) }]))
      const error = await refuse(app, path)
      expect(error?.code).toBe("agent_file_name_length")
      expect(error?.detail).toBe("agents[1].name")
    })
  })

  test("an import needs a file that open read", async () => {
    const app = await setup()
    const result = await app.exit(
      AgentFiles.use((f) => f.import({ serverId: app.server.id, model: null, pick: [] })),
    )
    expect(failure(result)?.code).toBe("invalid_input")
    app.pick.open = undefined
    expect(await app.run(AgentFiles.use((f) => f.open(app.server.id)))).toBeNull()
  })

  test("if an import fails, the agents made so far stay and the error says why", async () => {
    const app = await setup()
    // The database refuses the third agent, so the first two are made.
    app.db.run(
      `CREATE TRIGGER refuse_third BEFORE INSERT ON agent WHEN NEW.name = 'Cy'
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    )
    const path = app.write(
      "partial.json",
      file([{ name: "Ada" }, { name: "Bob" }, { name: "Cy" }, { name: "Dee" }]),
    )
    const result = await app.importExit(path)
    const error = failure(result)
    expect(error?.code).toBe("agent_file_failed")
    const info = JSON.parse(error?.detail ?? "{}") as AgentFileFailure
    expect(info).toMatchObject({ name: "Cy", made: 2, code: "internal" })
    // The agents made before it stay; the ones after it are not made.
    expect((await app.list()).map((a) => a.name)).toEqual(["Ada", "Bob"])
  })

  test("a failure that has a code from the app keeps the code", async () => {
    const app = await setup()
    // A file where the workspace folder should go: the folder of the next agent cannot be made.
    const root = join(app.dataDir, "workspaces")
    writeFileSync(root, "not a folder")
    const result = await app.importExit(app.write("one.json", file([{ name: "Ada" }])))
    const info = JSON.parse(failure(result)?.detail ?? "{}") as AgentFileFailure
    expect(info).toMatchObject({ name: "Ada", made: 0, code: "workspace_failed" })
    expect(await app.list()).toEqual([])
  })
})

describe("import and the limit of 50 routines (spec 009, 002)", () => {
  const routine = (name: string) => ({
    name,
    prompt: "Say hi",
    schedule: { kind: "daily", times: ["09:00"] },
  })
  /** Fills the server with routines of one agent, so that `room` places are left. */
  const fillRoutines = async (app: App, room: number) => {
    const owner = await app.make("Owner")
    for (let i = 0; i < ROUTINES_MAX - room; i++)
      await app.run(
        Routines.use((r) =>
          r.create({
            serverId: app.server.id,
            agentId: owner.id,
            name: `Old ${i}`,
            prompt: "Look.",
            schedule: { kind: "daily", times: ["09:00"] },
            place: { kind: "agent" },
          }),
        ),
      )
    return owner
  }

  test("a routine of a file that does not fit stops the import with the limit as the reason; the agent stays", async () => {
    const app = await setup()
    await fillRoutines(app, 0)
    const result = await app.importExit(
      app.write("full.json", file([{ name: "Ada", routines: [routine("One")] }])),
    )
    const error = failure(result)
    expect(error?.code).toBe("agent_file_failed")
    const info = JSON.parse(error?.detail ?? "{}") as AgentFileFailure
    expect(info).toMatchObject({ name: "Ada", made: 1, code: "routines_full", detail: "50" })
    // The agent that was made stays. No routine was made, and the count is still 50.
    expect((await app.list()).map((a) => a.name).sort()).toEqual(["Ada", "Owner"])
    expect(await app.run(Routines.use((r) => r.list(app.server.id)))).toHaveLength(ROUTINES_MAX)
  })

  test("the routines that fit are made, and the first one that does not stops the import", async () => {
    const app = await setup()
    await fillRoutines(app, 2)
    const result = await app.importExit(
      app.write(
        "three.json",
        file([{ name: "Ada", routines: [routine("A"), routine("B"), routine("C")] }]),
      ),
    )
    expect(failure(result)?.code).toBe("agent_file_failed")
    const routines = await app.run(Routines.use((r) => r.list(app.server.id)))
    expect(routines).toHaveLength(ROUTINES_MAX)
    expect(routines.filter((r) => ["A", "B", "C"].includes(r.name)).map((r) => r.name)).toEqual([
      "A",
      "B",
    ])
    // Every routine of the file starts paused, and it counts.
    expect(routines.filter((r) => ["A", "B"].includes(r.name)).every((r) => !r.enabled)).toBe(true)
  })

  test("a file with no routines imports at 50 routines", async () => {
    const app = await setup()
    await fillRoutines(app, 0)
    const result = await app.importExit(app.write("calm.json", file([{ name: "Ada" }])))
    expect(Exit.isSuccess(result)).toBe(true)
  })
})

describe("review before an import (spec 014)", () => {
  const routine = (name: string, prompt = "Say hi") => ({
    name,
    prompt,
    schedule: { kind: "daily", times: ["08:30"] },
  })
  const pickIt = (app: App, pick: readonly AgentPick[]) =>
    app.exit(AgentFiles.use((f) => f.import({ serverId: app.server.id, model: app.model, pick })))
  const checklistOf = (app: App, agentId: string) =>
    app.run(Checklists.use((c) => c.forAgent(agentId)))

  test("the preview lists each part, marks hidden secrets, and names what is not imported", async () => {
    const app = await setup()
    const path = app.write(
      "review.json",
      file([
        {
          name: "Ada",
          instructions: `Use ${SECRET_LOOKALIKE} here.`,
          model: { accountId: "x", model: "y" },
          routines: [routine("One"), { ...routine("Two", `with ${KEY}`), place: "general" }],
        },
        { name: "Bob", role: `Key ${KEY}`, instructions: "" },
      ]),
    )
    const preview = await app.openFile(path)
    expect(preview?.agents.map((a) => [a.name, a.secretRemoved, a.instructions])).toEqual([
      ["Ada", false, { length: [..."Use [redacted] here."].length, secretRemoved: true }],
      ["Bob", true, { length: 0, secretRemoved: false }],
    ])
    expect(preview?.agents[0]?.routines.map((r) => [r.name, r.secretRemoved])).toEqual([
      ["One", false],
      ["Two", true],
    ])
    expect(preview?.notImported).toEqual([
      { reason: "unknown_field", owner: "Ada", field: "model" },
      { reason: "unknown_field", owner: "Ada", field: "routines[1].place" },
    ])
    // Opening makes nothing.
    expect(await app.list()).toEqual([])
  })

  test("one routine ticked and one agent not ticked: one agent with one paused routine and a checklist", async () => {
    const app = await setup()
    const path = app.write(
      "two.json",
      file([
        { name: "Ada", instructions: "Be brief.", routines: [routine("One"), routine("Two")] },
        { name: "Bob", routines: [routine("Three")] },
      ]),
    )
    await app.openFile(path)
    expect(
      Exit.isSuccess(await pickIt(app, [{ index: 0, instructions: true, routines: [1] }])),
    ).toBe(true)
    const agents = await app.list()
    expect(agents.map((a) => a.name)).toEqual(["Ada"])
    const ada = agents[0]
    if (!ada) throw new Error("no agent")
    expect(ada.instructions).toBe("Be brief.")
    const routines = await routineOf(app, ada.id)
    expect(routines.map((r) => [r.name, r.enabled])).toEqual([["Two", false]])
    const checklist = await checklistOf(app, ada.id)
    expect(checklist?.items).toEqual([
      { kind: "routine", routineId: routines[0]?.id ?? "", name: "Two" },
    ])
  })

  test("instructions that are not ticked leave the agent empty; an agent without routines has no checklist", async () => {
    const app = await setup()
    const path = app.write("one.json", file([{ name: "Ada", instructions: "Secret plan" }]))
    await app.openFile(path)
    await pickIt(app, [{ index: 0, instructions: false, routines: [] }])
    const [ada] = await app.list()
    expect(ada?.instructions).toBe("")
    expect(await checklistOf(app, ada?.id ?? "")).toBeNull()
  })

  test("an agent that is not ticked takes no name: the next agent keeps its own", async () => {
    const app = await setup()
    await app.make("Ada")
    const path = app.write("names.json", file([{ name: "Ada" }, { name: "Ada 2" }]))
    const preview = await app.openFile(path)
    expect(preview?.agents.map((a) => a.name)).toEqual(["Ada 2", "Ada 2 2"])
    await pickIt(app, [{ index: 1, instructions: true, routines: [] }])
    expect((await app.list()).map((a) => a.name).sort()).toEqual(["Ada", "Ada 2"])
  })

  test("nothing ticked, or a place that the file does not have, is refused and makes nothing", async () => {
    const app = await setup()
    const path = app.write("one.json", file([{ name: "Ada", routines: [routine("One")] }]))
    await app.openFile(path)
    expect(failure(await pickIt(app, []))?.code).toBe("import_nothing_picked")
    expect(failure(await pickIt(app, [{ index: 3, instructions: true, routines: [] }]))?.code).toBe(
      "invalid_input",
    )
    expect(
      failure(await pickIt(app, [{ index: 0, instructions: true, routines: [5] }]))?.code,
    ).toBe("invalid_input")
    expect(await app.list()).toEqual([])
  })

  test("a refused file is still refused before the review", async () => {
    const app = await setup()
    const path = app.write("bad.json", file([{ name: "Ada" }, { name: "ada" }]))
    app.pick.open = path
    const result = await app.exit(AgentFiles.use((f) => f.open(app.server.id)))
    expect(failure(result)?.code).toBe("agent_file_duplicate")
  })

  test("deleting the agent deletes its checklist", async () => {
    const app = await setup()
    const path = app.write("one.json", file([{ name: "Ada", routines: [routine("One")] }]))
    await app.openFile(path)
    await pickIt(app, [{ index: 0, instructions: true, routines: [0] }])
    const [ada] = await app.list()
    expect(await checklistOf(app, ada?.id ?? "")).not.toBeNull()
    app.db.run("DELETE FROM agent WHERE id = ?", ada?.id ?? "")
    expect(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_checklist")?.n).toBe(0)
  })
})

describe("team file: channels, skills and the handbook", () => {
  /** Three agents; two channels; three skills; a handbook. */
  const team = async (app: App) => {
    const ada = await app.make("Ada")
    const bob = await app.make("Bob")
    const cy = await app.make("Cy")
    const duo = await app.run(
      Channels.use((c) =>
        c.create({
          serverId: app.server.id,
          name: "Duo",
          topic: "Two of us",
          instructions: "Be brief.",
          memberIds: [ada.id, bob.id],
          leadId: ada.id,
        }),
      ),
    )
    await app.run(Channels.use((c) => c.update(duo.id, { reviewParts: true })))
    await app.run(
      Channels.use((c) =>
        c.create({
          serverId: app.server.id,
          name: "Trio",
          topic: "",
          memberIds: [ada.id, bob.id, cy.id],
          leadId: null,
        }),
      ),
    )
    const skill = (name: string, agentIds: string[] | null) =>
      app.run(
        Skills.use((k) =>
          k.create(
            app.server.id,
            { name, description: `${name} help`, instructions: `Do ${name}.` },
            agentIds,
          ),
        ),
      )
    await skill("Everyone", null)
    await skill("AdaOnly", [ada.id])
    await skill("CyOnly", [cy.id])
    await app.run(Handbook.use((h) => h.save(app.server.id, "Answer in Korean.", "page")))
    return { ada, bob, cy }
  }

  const exportTeam = (
    app: App,
    path: string,
    agentIds: string[],
    parts: { channels?: boolean; skills?: boolean; handbook?: boolean },
  ) => {
    app.pick.save = path
    return app.run(AgentFiles.use((f) => f.export({ serverId: app.server.id, agentIds, ...parts })))
  }

  const channelsOf = (app: App) => app.run(Channels.use((c) => c.list(app.server.id)))
  const skillsOf = (app: App) => app.run(Skills.use((k) => k.list(app.server.id)))
  const handbookOf = (app: App) => app.run(Handbook.use((h) => h.get(app.server.id)))

  /** Imports with these ticks. Agents are all ticked unless `agents` says which. */
  const importTeam = async (
    app: App,
    path: string,
    ticks: {
      agents?: number[]
      channels?: number[]
      skills?: number[]
      handbook?: boolean
    } = {},
  ) => {
    const preview = await app.openFile(path)
    const agents = ticks.agents ?? (preview?.agents ?? []).map((_, i) => i)
    return app.exit(
      AgentFiles.use((f) =>
        f.import({
          serverId: app.server.id,
          model: app.model,
          pick: agents.map((index) => ({ index, instructions: true, routines: [] })),
          channels: ticks.channels ?? (preview?.channels ?? []).map((_, i) => i),
          skills: ticks.skills ?? (preview?.skills ?? []).map((_, i) => i),
          handbook: ticks.handbook ?? false,
        }),
      ),
    )
  }

  test("with no tick box the file holds no channel, skill or handbook", async () => {
    const app = await setup()
    const { ada, bob } = await team(app)
    const path = join(app.dataDir, "plain.json")
    const result = await exportTeam(app, path, [ada.id, bob.id], {})
    expect(result).toEqual({ path, count: 2, channels: 0, skills: 0, handbook: false })
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual([
      "agents",
      "format",
      "version",
    ])
  })

  test("the tick boxes add the channels whose members are all picked, the skills they may use and the handbook", async () => {
    const app = await setup()
    const { ada, bob } = await team(app)
    const path = join(app.dataDir, "team.json")
    const result = await exportTeam(app, path, [ada.id, bob.id], {
      channels: true,
      skills: true,
      handbook: true,
    })
    expect(result).toEqual({ path, count: 2, channels: 1, skills: 2, handbook: true })
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.version).toBe(2)
    // The channel with the third agent is not in the file. The file holds no message or section.
    expect(parsed.channels).toEqual([
      {
        name: "Duo",
        topic: "Two of us",
        instructions: "Be brief.",
        reviewParts: true,
        members: ["Ada", "Bob"],
        lead: "Ada",
      },
    ])
    // A skill for all agents is written for the agents in the file only. The skill of the third
    // agent is not in the file.
    expect(parsed.skills).toEqual([
      {
        name: "AdaOnly",
        description: "AdaOnly help",
        instructions: "Do AdaOnly.",
        agents: ["Ada"],
      },
      {
        name: "Everyone",
        description: "Everyone help",
        instructions: "Do Everyone.",
        agents: ["Ada", "Bob"],
      },
    ])
    expect(parsed.handbook).toBe("Answer in Korean.")
  })

  test("each tick box works alone; an empty handbook is not written", async () => {
    const app = await setup()
    const { ada, bob } = await team(app)
    const only = async (parts: { channels?: boolean; skills?: boolean; handbook?: boolean }) => {
      const path = join(app.dataDir, `only-${JSON.stringify(parts).length}.json`)
      await exportTeam(app, path, [ada.id, bob.id], parts)
      return Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()
    }
    expect(await only({ channels: true })).toEqual(["agents", "channels", "format", "version"])
    expect(await only({ skills: true })).toEqual(["agents", "format", "skills", "version"])
    expect(await only({ handbook: true })).toEqual(["agents", "format", "handbook", "version"])
    await app.run(Handbook.use((h) => h.save(app.server.id, "", "page")))
    const path = join(app.dataDir, "no-handbook.json")
    const result = await exportTeam(app, path, [ada.id, bob.id], { handbook: true })
    expect(result.handbook).toBe(false)
    expect(JSON.parse(readFileSync(path, "utf8")).handbook).toBeUndefined()
  })

  test("a key in a channel, a skill or the handbook is hidden in the file", async () => {
    const app = await setup()
    const { ada, bob } = await team(app)
    const duo = (await channelsOf(app)).find((c) => c.name === "Duo")
    // A text that was saved before the key was stored can still hold it.
    app.db.run("UPDATE channel SET instructions = ? WHERE id = ?", `Use ${KEY}.`, duo?.id ?? "")
    app.db.run("UPDATE skill SET instructions = ? WHERE name = 'AdaOnly'", `Send ${KEY}.`)
    app.db.run(
      "INSERT INTO handbook_version (id, server_id, text, source, created_at) VALUES ('h9', ?, ?, 'page', ?)",
      app.server.id,
      `Key ${KEY} is secret.`,
      Date.now() + 1000,
    )
    const path = join(app.dataDir, "hidden.json")
    await exportTeam(app, path, [ada.id, bob.id], { channels: true, skills: true, handbook: true })
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain(KEY)
    expect(text).toContain("[redacted]")
  })

  test("a file over the limit of 40 channels is not written", async () => {
    const app = await setup()
    const ada = await app.make("Ada")
    for (let i = 0; i < AGENT_FILE_MAX_CHANNELS + 1; i++)
      await app.run(
        Channels.use((c) =>
          c.create({
            serverId: app.server.id,
            name: `Channel ${i}`,
            topic: "",
            memberIds: [ada.id],
            leadId: null,
          }),
        ),
      )
    const path = join(app.dataDir, "many.json")
    app.pick.save = path
    const result = await app.exit(
      AgentFiles.use((f) =>
        f.export({ serverId: app.server.id, agentIds: [ada.id], channels: true }),
      ),
    )
    expect(failure(result)?.code).toBe("agent_file_too_many_channels")
    expect(existsSync(path)).toBe(false)
  })

  test("the review lists the channels, skills and handbook of the file", async () => {
    const source = await setup()
    const { ada, bob, cy } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id, cy.id], {
      channels: true,
      skills: true,
      handbook: true,
    })

    const app = await setup()
    const preview = await app.openFile(path)
    expect(preview?.version).toBe(2)
    expect(preview?.channels.map((c) => [c.name, c.members, c.lead, c.reviewParts])).toEqual([
      ["Duo", [0, 1], 0, true],
      ["Trio", [0, 1, 2], null, false],
    ])
    expect(preview?.skills.map((k) => [k.name, k.agents])).toEqual([
      ["AdaOnly", [0]],
      ["CyOnly", [2]],
      ["Everyone", [0, 1, 2]],
    ])
    expect(preview?.handbook).toEqual({
      text: "Answer in Korean.",
      length: 17,
      secretRemoved: false,
    })
    expect(preview?.skillRoom).toBe(100)
    expect(preview?.notImported).toEqual([])
  })

  test("import makes the ticked channels with their members and lead, and skills that are off", async () => {
    const source = await setup()
    const { ada, bob, cy } = await team(source)
    const path = join(source.dataDir, "team.json")
    // Ada and Bob only: the channel "Duo" and two skills come, the channel "Trio" does not.
    await exportTeam(source, path, [ada.id, bob.id], { channels: true, skills: true })
    void cy

    const app = await setup()
    const result = await importTeam(app, path)
    expect(Exit.isSuccess(result)).toBe(true)
    const agents = await app.list()
    const id = (name: string) => agents.find((a) => a.name === name)?.id ?? ""

    const channels = await channelsOf(app)
    expect(channels.map((c) => c.name)).toEqual(["Duo"])
    expect(channels[0]).toMatchObject({
      topic: "Two of us",
      instructions: "Be brief.",
      reviewParts: true,
      memberIds: [id("Ada"), id("Bob")],
      leadId: id("Ada"),
      sectionId: null,
    })
    // The file holds no message.
    expect(await app.run(Channels.use((c) => c.history(channels[0]?.id ?? "")))).toEqual([])

    const skills = await skillsOf(app)
    expect(skills.map((k) => [k.name, k.enabled, k.agentIds])).toEqual([
      ["AdaOnly", false, [id("Ada")]],
      ["Everyone", false, [id("Ada"), id("Bob")]],
    ])
    // Nothing else came: the handbook is not in this file.
    expect((await handbookOf(app)).text).toBe("")
  })

  test("the result counts what was made", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { channels: true, skills: true })
    const app = await setup()
    const preview = await app.openFile(path)
    const result = await app.run(
      AgentFiles.use((f) =>
        f.import({
          serverId: app.server.id,
          model: app.model,
          pick: (preview?.agents ?? []).map((_, index) => ({
            index,
            instructions: true,
            routines: [],
          })),
          channels: [0],
          skills: [0, 1],
        }),
      ),
    )
    expect(result).toEqual({ agents: 2, routines: 0, channels: 1, skills: 2, handbook: false })
  })

  test("a part that is not ticked is not made", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], {
      channels: true,
      skills: true,
      handbook: true,
    })
    const app = await setup()
    const result = await importTeam(app, path, { channels: [], skills: [1] })
    expect(Exit.isSuccess(result)).toBe(true)
    expect(await channelsOf(app)).toEqual([])
    expect((await skillsOf(app)).map((k) => k.name)).toEqual(["Everyone"])
    expect((await handbookOf(app)).text).toBe("")
  })

  test("a channel is made without a member that is not ticked; a lead that is not made leaves none", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { channels: true, skills: true })

    const app = await setup()
    // Only Bob is ticked (place 1). Ada, the lead, is not made.
    const result = await importTeam(app, path, { agents: [1] })
    expect(Exit.isSuccess(result)).toBe(true)
    const [bobNow] = await app.list()
    const [channel] = await channelsOf(app)
    expect(channel).toMatchObject({ name: "Duo", memberIds: [bobNow?.id], leadId: null })
    // A skill is made for the agents that are made.
    const skills = await skillsOf(app)
    expect(skills.map((k) => [k.name, k.agentIds])).toEqual([["Everyone", [bobNow?.id ?? ""]]])
  })

  test("a channel with no member left and a skill with no agent left are not made", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    // A channel of Ada alone: when Ada is not ticked, it has no member left.
    await source.run(
      Channels.use((c) =>
        c.create({
          serverId: source.server.id,
          name: "Solo",
          topic: "",
          memberIds: [ada.id],
          leadId: ada.id,
        }),
      ),
    )
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { channels: true, skills: true })

    const app = await setup()
    // Only Bob is ticked (place 1). "Duo" keeps Bob. "Solo" has no member left. The skill
    // "AdaOnly" needs Ada, so it has no agent left.
    const preview = await app.openFile(path)
    expect(preview?.channels.map((c) => c.name)).toEqual(["Duo", "Solo"])
    const result = await importTeam(app, path, { agents: [1] })
    expect(Exit.isSuccess(result)).toBe(true)
    expect((await channelsOf(app)).map((c) => c.name)).toEqual(["Duo"])
    expect((await skillsOf(app)).map((k) => k.name)).toEqual(["Everyone"])

    // With no agent ticked, no channel or skill can be made. Nothing at all is refused.
    const bare = await setup()
    await bare.openFile(path)
    const nothing = await bare.exit(
      AgentFiles.use((f) =>
        f.import({
          serverId: bare.server.id,
          model: null,
          pick: [],
          channels: [0],
          skills: [0],
        }),
      ),
    )
    expect(failure(nothing)?.code).toBe("import_nothing_picked")
    expect(await channelsOf(bare)).toEqual([])
    expect(await skillsOf(bare)).toEqual([])
  })

  test("a name that is taken gets a number, for a channel and for a skill", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { channels: true, skills: true })

    // The same file twice in one app: the second import numbers the names.
    const app = await setup()
    await importTeam(app, path)
    const again = await app.openFile(path)
    expect(again?.channels.map((c) => [c.name, c.fileName])).toEqual([["Duo 2", "Duo"]])
    expect(again?.skills.map((k) => k.name)).toEqual(["AdaOnly 2", "Everyone 2"])
    await importTeam(app, path)
    expect((await channelsOf(app)).map((c) => c.name)).toEqual(["Duo", "Duo 2"])
    expect((await skillsOf(app)).map((k) => k.name)).toEqual([
      "AdaOnly",
      "AdaOnly 2",
      "Everyone",
      "Everyone 2",
    ])
    // The new agents are numbered too, and the second channel uses them.
    const second = (await channelsOf(app)).find((c) => c.name === "Duo 2")
    const agents = await app.list()
    expect(second?.memberIds).toEqual([
      agents.find((a) => a.name === "Ada 2")?.id ?? "",
      agents.find((a) => a.name === "Bob 2")?.id ?? "",
    ])
  })

  test("a skill past the limit of 100 is not made; the ones before it are", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { skills: true })

    const app = await setup()
    const other = await app.make("Zed")
    for (let i = 0; i < SKILLS_MAX - 1; i++)
      await app.run(
        Skills.use((k) =>
          k.create(app.server.id, { name: `Filler ${i}`, description: "", instructions: "x" }, [
            other.id,
          ]),
        ),
      )
    const preview = await app.openFile(path)
    expect(preview?.skillRoom).toBe(1)
    const result = await importTeam(app, path)
    expect(Exit.isSuccess(result)).toBe(true)
    const names = (await skillsOf(app)).map((k) => k.name)
    expect(names).toHaveLength(SKILLS_MAX)
    expect(names).toContain("AdaOnly")
    expect(names).not.toContain("Everyone")
  })

  test("the handbook replaces the handbook only when it is ticked; the old text stays in the history", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { handbook: true })

    const app = await setup()
    await app.run(Handbook.use((h) => h.save(app.server.id, "Old text.", "page")))
    expect(Exit.isSuccess(await importTeam(app, path, { handbook: false }))).toBe(true)
    expect((await handbookOf(app)).text).toBe("Old text.")

    const result = await importTeam(app, path, { handbook: true })
    expect(Exit.isSuccess(result)).toBe(true)
    expect((await handbookOf(app)).text).toBe("Answer in Korean.")
    const history = await app.run(Handbook.use((h) => h.history(app.server.id)))
    expect(history.map((v) => [v.text, v.source])).toEqual([
      ["Answer in Korean.", "import"],
      ["Old text.", "page"],
    ])
  })

  test("the handbook alone can be imported without an agent", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { handbook: true })
    const app = await setup()
    await app.openFile(path)
    const result = await app.run(
      AgentFiles.use((f) =>
        f.import({ serverId: app.server.id, model: null, pick: [], handbook: true }),
      ),
    )
    expect(result).toEqual({ agents: 0, routines: 0, channels: 0, skills: 0, handbook: true })
    expect((await handbookOf(app)).text).toBe("Answer in Korean.")
    expect(await app.list()).toEqual([])
  })

  test("a key in the text of a part is hidden on import and marks the part", async () => {
    const app = await setup()
    const path = app.write(
      "secret.json",
      JSON.stringify({
        format: "robot-agents",
        version: 2,
        agents: [{ name: "Ada" }],
        channels: [{ name: "Ops", instructions: `Use ${SECRET_LOOKALIKE}.`, members: ["Ada"] }],
        skills: [{ name: "Send", instructions: `Key ${SECRET_LOOKALIKE}`, agents: ["Ada"] }],
        handbook: `The key is ${SECRET_LOOKALIKE}.`,
      }),
    )
    const preview = await app.openFile(path)
    expect(preview?.channels[0]?.secretRemoved).toBe(true)
    expect(preview?.skills[0]?.secretRemoved).toBe(true)
    expect(preview?.handbook?.secretRemoved).toBe(true)
    expect(preview?.handbook?.text).not.toContain(SECRET_LOOKALIKE)
    const result = await importTeam(app, path, { handbook: true })
    expect(Exit.isSuccess(result)).toBe(true)
    expect((await channelsOf(app))[0]?.instructions).toBe("Use [redacted].")
    expect((await skillsOf(app))[0]?.instructions).toBe("Key [redacted]")
    expect((await handbookOf(app)).text).toBe("The key is [redacted].")
  })

  test("a file of version 1 is still read: its team fields are not defined and are listed", async () => {
    const app = await setup()
    const path = app.write(
      "v1.json",
      JSON.stringify({
        format: "robot-agents",
        version: 1,
        agents: [{ name: "Ada" }],
        channels: [{ name: "Ops", members: ["Ada"] }],
        handbook: "Text",
      }),
    )
    const preview = await app.openFile(path)
    expect(preview?.version).toBe(1)
    expect(preview?.channels).toEqual([])
    expect(preview?.handbook).toBeNull()
    expect(preview?.notImported).toEqual([
      { reason: "unknown_field", owner: null, field: "channels" },
      { reason: "unknown_field", owner: null, field: "handbook" },
    ])
    const result = await importTeam(app, path)
    expect(Exit.isSuccess(result)).toBe(true)
    expect(await channelsOf(app)).toEqual([])
  })

  test("a part that the file does not hold is refused", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { channels: true })
    const app = await setup()
    const bad = await importTeam(app, path, { channels: [4] })
    expect(failure(bad)?.code).toBe("invalid_input")
    const noHandbook = await importTeam(app, path, { handbook: true })
    expect(failure(noHandbook)?.code).toBe("invalid_input")
    expect(await app.list()).toEqual([])
  })

  test("an import that stops at a channel keeps what was made and names the channel", async () => {
    const source = await setup()
    const { ada, bob } = await team(source)
    const path = join(source.dataDir, "team.json")
    await exportTeam(source, path, [ada.id, bob.id], { channels: true, skills: true })
    const app = await setup()
    await app.openFile(path)
    // A trigger makes every new channel fail, as a full disk would.
    app.db.run(
      "CREATE TRIGGER no_channels BEFORE INSERT ON channel BEGIN SELECT RAISE(ABORT, 'full'); END",
    )
    const result = await app.exit(
      AgentFiles.use((f) =>
        f.import({
          serverId: app.server.id,
          model: app.model,
          pick: [0, 1].map((index) => ({ index, instructions: true, routines: [] })),
          channels: [0],
          skills: [0],
        }),
      ),
    )
    const error = failure(result)
    expect(error?.code).toBe("agent_file_failed")
    const detail = JSON.parse(error?.detail ?? "{}") as AgentFileFailure
    expect(detail).toMatchObject({ kind: "channel", name: "Duo", made: 2, madeChannels: 0 })
    expect((await app.list()).map((a) => a.name)).toEqual(["Ada", "Bob"])
    expect(await skillsOf(app)).toEqual([])
  })
})
