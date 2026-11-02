import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  AGENT_FILE_MAX_AGENTS,
  AGENT_FILE_MAX_BYTES,
  AGENT_NAME_MAX,
  type AgentFileFailure,
  type AgentFilePreview,
  type AgentModel,
  type AgentPick,
  charLength,
} from "@robot/shared"
import { Effect, Exit, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { AgentFiles } from "./AgentFiles.ts"
import { Agents } from "./Agents.ts"
import { Checklists } from "./Checklists.ts"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { secretKey } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
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
    expect(result).toEqual({ path, count: 1 })

    const text = readFileSync(path, "utf8")
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({
      format: "robot-agents",
      version: 1,
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
    expect(cancelled).toEqual({ path: null, count: 0 })
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
    expect(result).toEqual({ agents: 2, routines: 2 })

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
        (await refuse(app, app.write("b.json", { ...file([{ name: "Ada" }]), version: 2 })))?.code,
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
