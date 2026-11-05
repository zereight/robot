import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildTlaStarter,
  charLength,
  type Edge,
  type Step,
  starterWorkflowName,
  WORKFLOW_FILE_MAX_BYTES,
  WORKFLOW_NAME_MAX,
  type WorkflowFileFailure,
  type WorkflowInput,
  workflowStarterText,
} from "@robot/shared"
import { Effect, Exit, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Checklists } from "./Checklists.ts"
import { Database } from "./Database.ts"
import { secretKey } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testPlatform } from "./testing.ts"
import { WorkflowFiles } from "./WorkflowFiles.ts"
import { Workflows } from "./Workflows.ts"

const KEY = "stored-key-0123456789abcdef"
const LOOKALIKE = "sk-looks-like-a-key-0123456789abcdef"

/** One app with an in-memory database. `pick` sets what the file dialogs answer. */
const setup = async () => {
  const { platform, dataDir } = testPlatform()
  const pick = { save: undefined as string | undefined, open: undefined as string | undefined }
  const runtime = ManagedRuntime.make(
    appLayer({
      platform: {
        ...platform,
        pickWorkflowFileSave: async () => pick.save,
        pickWorkflowFile: async () => pick.open,
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
  const db = await run(Database.use((d) => Effect.succeed(d)))
  db.run(
    "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('acc1', 'custom', 'Mine', 'http://127.0.0.1:9/v1', 1)",
  )
  await run(Secrets.use((s) => Effect.sync(() => s.set(secretKey("acc1"), KEY))))

  const agent = (name: string) =>
    run(Agents.use((a) => a.create({ serverId: server.id, name, role: "", instructions: "" })))
  const channel = async (name: string) =>
    run(
      Channels.use((c) =>
        c.create({ serverId: server.id, name, topic: "", memberIds: [], leadId: null }),
      ),
    )
  const edge = (from: string, to: string, branch?: "yes" | "no"): Edge => ({
    id: `${from}-${to}${branch ?? ""}`,
    from,
    to,
    ...(branch ? { branch } : {}),
  })
  const create = (name: string, over: Partial<WorkflowInput> = {}) =>
    run(
      Workflows.use((w) =>
        w.create({
          serverId: server.id,
          name,
          trigger: { kind: "manual" },
          steps: [],
          edges: [],
          ...over,
        }),
      ),
    )
  const list = () => run(Workflows.use((w) => w.list(server.id)))
  const exportTo = (path: string, workflowIds: readonly string[]) => {
    pick.save = path
    return run(WorkflowFiles.use((f) => f.export({ serverId: server.id, workflowIds })))
  }
  const exportExit = (path: string, workflowIds: readonly string[]) => {
    pick.save = path
    return exit(WorkflowFiles.use((f) => f.export({ serverId: server.id, workflowIds })))
  }
  const openFile = (path: string) => {
    pick.open = path
    return run(WorkflowFiles.use((f) => f.open(server.id)))
  }
  /** Opens the file and imports every workflow of it. */
  const importFile = (path: string) =>
    openFile(path).then((preview) =>
      run(
        WorkflowFiles.use((f) =>
          f.import({
            serverId: server.id,
            pick: (preview?.workflows ?? []).map((_, i) => i),
          }),
        ),
      ),
    )
  const openExit = (path: string) => {
    pick.open = path
    return exit(WorkflowFiles.use((f) => f.open(server.id)))
  }
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
    agent,
    channel,
    edge,
    create,
    list,
    exportTo,
    exportExit,
    openFile,
    importFile,
    openExit,
    write,
  }
}
type App = Awaited<ReturnType<typeof setup>>

const failure = (result: Exit.Exit<unknown, { code: string; detail?: string }>) => {
  if (!Exit.isFailure(result)) return undefined
  const reason = result.cause.reasons.find((r) => "error" in r)
  return reason && "error" in reason
    ? (reason.error as { code: string; detail?: string })
    : undefined
}

const file = (workflows: unknown) => ({ format: "robot-workflows", version: 1, workflows })

/** A workflow with one step of every kind and a note, for an app that has the agent and a channel. */
const full = async (app: App, name = "Digest") => {
  const ada = await app.agent("Ada")
  const out = await app.channel("Out")
  const steps: Step[] = [
    {
      id: "a",
      kind: "agent",
      name: "Draft",
      x: 10,
      y: 20,
      agentId: ada.id,
      prompt: "Write a haiku",
      continueOnFailure: true,
      effort: "low",
    },
    {
      id: "c",
      kind: "condition",
      name: "Greeting?",
      x: 300,
      y: 20,
      contains: "Is it a haiku?",
      mode: "ask",
    },
    { id: "g", kind: "approval", name: "Gate", x: 600, y: 0, message: "Go on?" },
    {
      id: "p",
      kind: "post",
      name: "Post",
      x: 600,
      y: 120,
      channelId: out.id,
      text: "Out: {{input}}",
    },
    { id: "n", kind: "notify", name: "Tell", x: 900, y: 0, title: "Finished" },
  ]
  const workflow = await app.create(name, {
    trigger: { kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } },
    steps,
    edges: [
      app.edge("a", "c"),
      app.edge("c", "g", "yes"),
      app.edge("c", "p", "no"),
      app.edge("g", "n"),
    ],
    notes: [{ id: "x", text: "Check the tone", tone: "pink", x: 5, y: 400 }],
  })
  return { ada, out, workflow }
}

/** The file as JSON, with loose types: a test reads what is written, not what the types promise. */
const readFile = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as {
    format: string
    version: number
    workflows: {
      name: string
      trigger: unknown
      steps: Record<string, unknown>[]
      connections: unknown[]
      notes: unknown[]
    }[]
  }

describe("export", () => {
  test("the file holds name, trigger, steps, connections and notes, with the agent by name", async () => {
    const app = await setup()
    const { workflow } = await full(app)
    await app.create("Other")
    const path = join(app.dataDir, "workflows.json")
    expect(await app.exportTo(path, [workflow.id])).toEqual({ path, count: 1 })

    const written = readFile(path)
    expect(written).toMatchObject({ format: "robot-workflows", version: 1 })
    expect(written.workflows).toHaveLength(1)
    expect(written.workflows[0]).toEqual({
      name: "Digest",
      trigger: { kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } },
      steps: [
        {
          kind: "agent",
          name: "Draft",
          x: 10,
          y: 20,
          agent: "Ada",
          prompt: "Write a haiku",
          effort: "low",
          continueOnFailure: true,
        },
        {
          kind: "condition",
          name: "Greeting?",
          x: 300,
          y: 20,
          mode: "ask",
          text: "Is it a haiku?",
        },
        { kind: "approval", name: "Gate", x: 600, y: 0, message: "Go on?" },
        { kind: "post", name: "Post", x: 600, y: 120, text: "Out: {{input}}" },
        { kind: "notify", name: "Tell", x: 900, y: 0, title: "Finished" },
      ],
      connections: [
        { from: 1, to: 2 },
        { from: 2, to: 3, branch: "yes" },
        { from: 2, to: 4, branch: "no" },
        { from: 3, to: 5 },
      ],
      notes: [{ text: "Check the tone", tone: "pink", x: 5, y: 400 }],
    })
  })

  test("the file holds no run, no version, no id, no channel and no key", async () => {
    const app = await setup()
    const { workflow, out, ada } = await full(app)
    await app.run(Workflows.use((w) => w.update(workflow.id, { name: "Digest", enabled: true })))
    const path = join(app.dataDir, "workflows.json")
    await app.exportTo(path, [workflow.id])
    const text = readFileSync(path, "utf8")
    for (const absent of [
      out.id,
      ada.id,
      workflow.id,
      "channelId",
      "agentId",
      KEY,
      "enabled",
      "runs",
    ])
      expect(text).not.toContain(absent)
    expect(Object.keys(readFile(path).workflows[0] ?? {}).sort()).toEqual([
      "connections",
      "name",
      "notes",
      "steps",
      "trigger",
    ])
  })

  test("a message trigger is written as the manual trigger; a post step has no place", async () => {
    const app = await setup()
    const out = await app.channel("Out")
    const workflow = await app.create("Reacts", {
      trigger: { kind: "channel", channelId: out.id, contains: "deploy" },
      steps: [{ id: "p", kind: "post", name: "Post", x: 0, y: 0, channelId: out.id, text: "x" }],
    })
    const path = join(app.dataDir, "workflows.json")
    await app.exportTo(path, [workflow.id])
    const written = readFile(path).workflows[0]
    expect(written?.trigger).toEqual({ kind: "manual" })
    expect(written?.steps[0]).toEqual({ kind: "post", name: "Post", x: 0, y: 0, text: "x" })
    expect(readFileSync(path, "utf8")).not.toContain("deploy")
  })

  test("a step whose agent is gone is written with no agent", async () => {
    const app = await setup()
    const workflow = await app.create("Lost", {
      steps: [
        {
          id: "a",
          kind: "agent",
          name: "A",
          x: 0,
          y: 0,
          agentId: "",
          prompt: "p",
          continueOnFailure: false,
        },
      ],
    })
    const path = join(app.dataDir, "workflows.json")
    await app.exportTo(path, [workflow.id])
    expect(readFile(path).workflows[0]?.steps[0]).toMatchObject({ kind: "agent", agent: "" })
  })

  test("text that looks like a secret, and a stored key, are hidden", async () => {
    const app = await setup()
    const workflow = await app.create(`Keys ${LOOKALIKE}`, {
      steps: [
        {
          id: "a",
          kind: "agent",
          name: `Step ${LOOKALIKE}`,
          x: 0,
          y: 0,
          agentId: "",
          prompt: `Use ${LOOKALIKE} and ${KEY}`,
          continueOnFailure: false,
        },
        { id: "n", kind: "notify", name: "N", x: 0, y: 0, title: LOOKALIKE },
      ],
      notes: [{ id: "x", text: `Note ${LOOKALIKE}`, tone: "blue", x: 0, y: 0 }],
    })
    const path = join(app.dataDir, "workflows.json")
    await app.exportTo(path, [workflow.id])
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain(LOOKALIKE)
    expect(text).not.toContain(KEY)
    expect(text).toContain("[redacted]")
  })

  test("the file keeps the order of the list, and only the workflows that were picked", async () => {
    const app = await setup()
    const [one, two, three] = [
      await app.create("One"),
      await app.create("Two"),
      await app.create("Three"),
    ]
    const path = join(app.dataDir, "workflows.json")
    await app.exportTo(path, [three.id, one.id])
    expect(readFile(path).workflows.map((w) => w.name)).toEqual(["One", "Three"])
    expect(two.name).toBe("Two")
  })

  test("a cancelled dialog writes nothing", async () => {
    const app = await setup()
    const one = await app.create("One")
    app.pick.save = undefined
    expect(
      await app.run(
        WorkflowFiles.use((f) => f.export({ serverId: app.server.id, workflowIds: [one.id] })),
      ),
    ).toEqual({
      path: null,
      count: 0,
    })
  })

  test("it refuses no workflow, more than 20, and a workflow of no one", async () => {
    const app = await setup()
    const path = join(app.dataDir, "workflows.json")
    expect(failure(await app.exportExit(path, []))).toMatchObject({ code: "workflow_file_empty" })
    expect(
      failure(
        await app.exportExit(
          path,
          Array.from({ length: 21 }, (_, i) => `id-${i}`),
        ),
      ),
    ).toMatchObject({ code: "workflow_file_too_many", detail: "21" })
    expect(failure(await app.exportExit(path, ["nope"]))).toMatchObject({
      code: "workflow_not_found",
    })
    expect(existsSync(path)).toBe(false)
  })

  test("a workflow that the import would refuse is not exported, and the error names it", async () => {
    const app = await setup()
    const workflow = await app.create("Half", {
      steps: [
        { id: "c", kind: "condition", name: "Test", x: 0, y: 0, contains: "x" },
        { id: "n", kind: "notify", name: "N", x: 0, y: 0, title: "t" },
      ],
      edges: [app.edge("c", "n", "yes")],
    })
    const path = join(app.dataDir, "workflows.json")
    const error = failure(await app.exportExit(path, [workflow.id]))
    expect(error?.code).toBe("workflow_file_graph")
    expect(JSON.parse(error?.detail ?? "{}")).toEqual({
      workflow: "Half",
      fault: "branches",
      place: { kind: "step", n: 1 },
    })
    expect(existsSync(path)).toBe(false)
  })

  test("a file of more than 10 MB is not written", async () => {
    const app = await setup()
    const prompt = "x".repeat(20_000)
    const steps: Step[] = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      kind: "agent",
      name: `S${i}`,
      x: 0,
      y: 0,
      agentId: "",
      prompt,
      continueOnFailure: false,
    }))
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await app.create(`Big ${i}`, { steps })).id)
    const path = join(app.dataDir, "big.json")
    expect(failure(await app.exportExit(path, ids))).toMatchObject({
      code: "workflow_file_too_large",
    })
    expect(existsSync(path)).toBe(false)
  }, 20_000)
})

describe("import", () => {
  /** Exports the full workflow from one app and gives the path. */
  const exported = async () => {
    const source = await setup()
    const { workflow } = await full(source)
    const path = join(source.dataDir, "workflows.json")
    await source.exportTo(path, [workflow.id])
    return path
  }

  test("it makes the workflow off, with the same steps, numbers and note; the agent step is linked", async () => {
    const path = await exported()
    const app = await setup()
    const ada = await app.agent("Ada")
    const preview = await app.openFile(path)
    expect(preview).toEqual({
      form: "robot",
      workflows: [
        {
          name: "Digest",
          fileName: null,
          trigger: "schedule",
          steps: 5,
          notes: 1,
          missingAgents: [],
          secretRemoved: false,
          lostConnections: false,
          needAgent: 0,
        },
      ],
      notImported: [{ reason: "no_place", owner: "Digest", step: 4, name: "Post" }],
    })
    expect(await app.importFile(path)).toEqual({ workflows: 1 })

    const [made] = await app.list()
    expect(made).toMatchObject({ name: "Digest", enabled: false })
    expect(made?.trigger).toEqual({
      kind: "schedule",
      schedule: { kind: "daily", times: ["08:30"] },
    })
    expect(made?.steps.map((s) => [s.kind, s.name, s.x, s.y])).toEqual([
      ["agent", "Draft", 10, 20],
      ["condition", "Greeting?", 300, 20],
      ["approval", "Gate", 600, 0],
      ["post", "Post", 600, 120],
      ["notify", "Tell", 900, 0],
    ])
    expect(made?.steps[0]).toMatchObject({
      agentId: ada.id,
      prompt: "Write a haiku",
      effort: "low",
      continueOnFailure: true,
    })
    expect(made?.steps[1]).toMatchObject({ mode: "ask", contains: "Is it a haiku?" })
    expect(made?.steps[3]).toMatchObject({ channelId: "" })
    expect(made?.steps[4]).toMatchObject({ title: "Finished" })
    expect(made?.edges.map((e) => [e.from, e.to, e.branch])).toEqual([
      ["s1", "s2", undefined],
      ["s2", "s3", "yes"],
      ["s2", "s4", "no"],
      ["s3", "s5", undefined],
    ])
    expect(made?.notes).toEqual([{ id: "n1", text: "Check the tone", tone: "pink", x: 5, y: 400 }])
  })

  test("it makes no agent, no channel and no routine", async () => {
    const path = await exported()
    const app = await setup()
    await app.agent("Ada")
    await app.importFile(path)
    expect(await app.run(Agents.use((a) => a.list(app.server.id, false)))).toHaveLength(1)
    expect(await app.run(Channels.use((c) => c.list(app.server.id)))).toHaveLength(0)
    expect(await app.run(Routines.use((r) => r.list(app.server.id)))).toHaveLength(0)
  })

  test("without the agent the list names it once, and the step has no agent", async () => {
    const path = await exported()
    const app = await setup()
    const preview = await app.openFile(path)
    expect(preview?.workflows[0]?.missingAgents).toEqual(["Ada"])
    await app.importFile(path)
    const [made] = await app.list()
    expect(made?.steps[0]).toMatchObject({ kind: "agent", agentId: "" })
    // A run fails at that step with the reason "No agent"; the post step fails with "No place".
    const started = await app.run(Workflows.use((w) => w.run(made?.id ?? "")))
    await untilEnded(app, started.id)
    const detail = await app.run(Workflows.use((w) => w.runDetail(started.id)))
    expect(detail.run.state).toBe("failed")
    expect(detail.steps.find((s) => s.stepId === "s1")).toMatchObject({
      state: "failed",
      error: "no_agent",
    })
  })

  test("a post step fails at its step with No place", async () => {
    const app = await setup()
    const path = app.write(
      "post.json",
      file([{ name: "P", steps: [{ kind: "post", name: "Post", text: "hi" }] }]),
    )
    await app.importFile(path)
    const [made] = await app.list()
    const started = await app.run(Workflows.use((w) => w.run(made?.id ?? "")))
    await untilEnded(app, started.id)
    const detail = await app.run(Workflows.use((w) => w.runDetail(started.id)))
    expect(detail.steps[0]).toMatchObject({ state: "failed", error: "no_place" })
  })

  test("the agent is found by name ignoring case, and an archived agent is not linked", async () => {
    const app = await setup()
    const ada = await app.agent("ada")
    const bob = await app.agent("Bob")
    await app.run(Agents.use((a) => a.archive(bob.id)))
    const path = app.write(
      "agents.json",
      file([
        {
          name: "Two",
          steps: [
            { kind: "agent", name: "A", agent: "ADA" },
            { kind: "agent", name: "B", agent: "bob" },
          ],
        },
      ]),
    )
    const preview = await app.openFile(path)
    expect(preview?.workflows[0]?.missingAgents).toEqual(["bob"])
    await app.importFile(path)
    const [made] = await app.list()
    expect(made?.steps.map((s) => (s.kind === "agent" ? s.agentId : null))).toEqual([ada.id, ""])
  })

  test("a taken name gets a number, ignoring case, inside the length limit; nothing that exists changes", async () => {
    const path = await exported()
    const app = await setup()
    await app.agent("Ada")
    const mine = await app.create("DIGEST", {
      steps: [{ id: "n", kind: "notify", name: "Mine", x: 0, y: 0, title: "keep" }],
    })
    const preview = await app.openFile(path)
    expect(preview?.workflows[0]).toMatchObject({ name: "Digest 2", fileName: "Digest" })
    await app.importFile(path)
    await app.importFile(path)
    const all = await app.list()
    expect(all.map((w) => w.name)).toEqual(["DIGEST", "Digest 2", "Digest 3"])
    // The workflow that existed is as it was.
    expect(all[0]).toMatchObject({ id: mine.id, enabled: true })
    expect(all[0]?.steps).toHaveLength(1)

    const long = "x".repeat(WORKFLOW_NAME_MAX)
    await app.create(long)
    const again = app.write("long.json", file([{ name: long }]))
    await app.importFile(again)
    const numbered = (await app.list())
      .map((w) => w.name)
      .find((n) => n.endsWith(" 2") && n.startsWith("xxx"))
    expect(charLength(numbered ?? "")).toBe(WORKFLOW_NAME_MAX)
  })

  test("an imported schedule does not fire until the user turns the workflow on", async () => {
    const app = await setup()
    const path = app.write(
      "every.json",
      file([
        {
          name: "Tick",
          trigger: { kind: "schedule", schedule: { kind: "every", minutes: 5, from: Date.now() } },
          steps: [{ kind: "notify", name: "Tell", title: "Tick" }],
        },
      ]),
    )
    await app.importFile(path)
    const [made] = await app.list()
    expect(made?.enabled).toBe(false)
    const later = () => Date.now() + 5 * 60_000 + 1000
    await app.run(Workflows.use((w) => w.tick(later())))
    await Bun.sleep(100)
    expect(await app.run(Workflows.use((w) => w.runs(made?.id ?? "")))).toHaveLength(0)
    await app.run(Workflows.use((w) => w.update(made?.id ?? "", { enabled: true })))
    await app.run(Workflows.use((w) => w.tick(later())))
    await Bun.sleep(100)
    expect(await app.run(Workflows.use((w) => w.runs(made?.id ?? "")))).toHaveLength(1)
  })

  test("text in the file that looks like a secret is hidden", async () => {
    const app = await setup()
    const path = app.write(
      "keys.json",
      file([
        {
          name: `Keys ${LOOKALIKE}`,
          steps: [{ kind: "agent", name: "A", prompt: `Use ${LOOKALIKE} and ${KEY}` }],
          notes: [{ text: LOOKALIKE }],
        },
      ]),
    )
    await app.importFile(path)
    expect(JSON.stringify(await app.list())).not.toContain(LOOKALIKE)
    expect(JSON.stringify(await app.list())).not.toContain(KEY)
  })

  test("a cancelled dialog gives nothing; an import without a file is refused", async () => {
    const app = await setup()
    app.pick.open = undefined
    expect(await app.run(WorkflowFiles.use((f) => f.open(app.server.id)))).toBeNull()
    expect(
      failure(
        await app.exit(WorkflowFiles.use((f) => f.import({ serverId: app.server.id, pick: [0] }))),
      ),
    ).toMatchObject({ code: "invalid_input" })
  })
})

describe("a file that is refused", () => {
  const nothingMade = async (app: App) => expect(await app.list()).toHaveLength(0)

  test("a graph fault refuses the whole file and names the workflow and the place", async () => {
    const app = await setup()
    const path = app.write(
      "graph.json",
      file([
        { name: "Fine", steps: [{ kind: "notify", name: "N" }] },
        {
          name: "Broken",
          steps: [
            { kind: "notify", name: "N" },
            { kind: "notify", name: "M" },
          ],
          connections: [
            { from: 1, to: 2 },
            { from: 2, to: 3 },
          ],
        },
      ]),
    )
    const error = failure(await app.openExit(path))
    expect(error?.code).toBe("workflow_file_graph")
    expect(JSON.parse(error?.detail ?? "{}")).toEqual({
      workflow: "Broken",
      fault: "unknown_step",
      place: { kind: "connection", n: 2 },
    })
    await nothingMade(app)
    // An import after a refused open has nothing to make.
    expect(
      failure(
        await app.exit(WorkflowFiles.use((f) => f.import({ serverId: app.server.id, pick: [0] }))),
      ),
    ).toMatchObject({ code: "invalid_input" })
  })

  test("a condition without both branches, and more steps than the limit", async () => {
    const app = await setup()
    const oneBranch = app.write(
      "branch.json",
      file([
        {
          name: "Half",
          steps: [
            { kind: "condition", name: "C" },
            { kind: "notify", name: "N" },
          ],
          connections: [{ from: 1, to: 2, branch: "no" }],
        },
      ]),
    )
    const first = failure(await app.openExit(oneBranch))
    expect(JSON.parse(first?.detail ?? "{}")).toMatchObject({
      workflow: "Half",
      fault: "branches",
      place: { kind: "step", n: 1 },
    })
    const tooMany = app.write(
      "many.json",
      file([
        {
          name: "Long",
          steps: Array.from({ length: 31 }, (_, i) => ({ kind: "notify", name: `N${i}` })),
        },
      ]),
    )
    const second = failure(await app.openExit(tooMany))
    expect(JSON.parse(second?.detail ?? "{}")).toEqual({
      workflow: "Long",
      fault: "too_many_steps",
      place: { kind: "steps", n: 31 },
    })
    await nothingMade(app)
  })

  test("not a workflow file, a newer version, two workflows of one name, 21 workflows", async () => {
    const app = await setup()
    const codes = async (value: unknown) =>
      failure(await app.openExit(app.write("x.json", value)))?.code
    expect(await codes("nope")).toBe("workflow_file_format")
    expect(await codes({ format: "robot-agents", version: 1, agents: [] })).toBe(
      "workflow_file_format",
    )
    expect(await codes({ ...file([{ name: "A" }]), version: 2 })).toBe("workflow_file_version")
    expect(await codes(file([{ name: "A" }, { name: " a " }]))).toBe("workflow_file_duplicate")
    expect(await codes(file(Array.from({ length: 21 }, (_, i) => ({ name: `W${i}` }))))).toBe(
      "workflow_file_too_many",
    )
    expect(await codes(file([]))).toBe("workflow_file_empty")
    await nothingMade(app)
  })

  test("a file of more than 10 MB is refused before it is read", async () => {
    const app = await setup()
    const big = app.write("big.json", "x".repeat(WORKFLOW_FILE_MAX_BYTES + 1))
    expect(failure(await app.openExit(big))).toMatchObject({ code: "workflow_file_too_large" })
  })

  test("a file that is not there", async () => {
    const app = await setup()
    expect(failure(await app.openExit(join(app.dataDir, "gone.json")))).toMatchObject({
      code: "file_unreadable",
    })
  })
})

describe("the round trip", () => {
  test("a workflow exported from one app and imported into another is the same", async () => {
    const source = await setup()
    const { workflow } = await full(source)
    const first = join(source.dataDir, "one.json")
    await source.exportTo(first, [workflow.id])

    const target = await setup()
    await target.agent("Ada")
    await target.importFile(first)
    const [made] = await target.list()
    const second = join(target.dataDir, "two.json")
    await target.exportTo(second, [made?.id ?? ""])
    expect(readFile(second)).toEqual(readFile(first))
  })

  test("a failure while the workflows are made names the one that stopped, and the earlier ones stay", async () => {
    const app = await setup()
    const path = app.write("two.json", file([{ name: "One" }, { name: "Two" }]))
    await app.openFile(path)
    // The second insert fails: the table has a name that the database refuses.
    app.db.run(
      "CREATE TRIGGER stop_two BEFORE INSERT ON workflow WHEN NEW.name = 'Two' BEGIN SELECT RAISE(ABORT, 'no'); END",
    )
    const error = failure(
      await app.exit(WorkflowFiles.use((f) => f.import({ serverId: app.server.id, pick: [0, 1] }))),
    )
    expect(error?.code).toBe("workflow_file_failed")
    const info = JSON.parse(error?.detail ?? "{}") as WorkflowFileFailure
    expect(info).toMatchObject({ name: "Two", made: 1 })
    expect((await app.list()).map((w) => w.name)).toEqual(["One"])
  })
})

describe("review before an import (spec 014)", () => {
  const pickIt = (app: App, pick: readonly number[]) =>
    app.exit(WorkflowFiles.use((f) => f.import({ serverId: app.server.id, pick })))
  const checklistOf = (app: App, workflowId: string) =>
    app.run(Checklists.use((c) => c.forWorkflow(workflowId)))

  const hand = {
    name: "Ask Zed",
    trigger: { kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } },
    steps: [
      { kind: "agent", name: "Zed works", agent: "Zed", prompt: "Say hi", model: "fast" },
      { kind: "post", name: "Share", channel: "general" },
      { kind: "agent", name: "Ada works", agent: "Ada" },
    ],
    connections: [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ],
    color: "red",
  }

  test("the preview names the missing agents of each workflow, the place of a post step and unknown fields", async () => {
    const app = await setup()
    await app.agent("Ada")
    const path = app.write(
      "hand.json",
      file([hand, { name: "Clean", steps: [{ kind: "notify", name: "N" }] }]),
    )
    const preview = await app.openFile(path)
    expect(preview?.workflows.map((w) => [w.name, w.missingAgents, w.secretRemoved])).toEqual([
      ["Ask Zed", ["Zed"], false],
      ["Clean", [], false],
    ])
    expect(preview?.notImported).toEqual([
      { reason: "unknown_field", owner: "Ask Zed", field: "color" },
      { reason: "unknown_field", owner: "Ask Zed", field: "steps[0].model" },
      { reason: "unknown_field", owner: "Ask Zed", field: "steps[1].channel" },
      { reason: "no_place", owner: "Ask Zed", step: 2, name: "Share" },
    ])
  })

  test("a workflow with a hidden secret is marked, and only the ticked workflows are made", async () => {
    const app = await setup()
    const path = app.write(
      "two.json",
      file([
        { name: "Keyed", steps: [{ kind: "notify", name: "N", title: `Use ${LOOKALIKE}` }] },
        { name: "Plain", steps: [{ kind: "notify", name: "N" }] },
      ]),
    )
    const preview = await app.openFile(path)
    expect(preview?.workflows.map((w) => w.secretRemoved)).toEqual([true, false])
    expect(Exit.isSuccess(await pickIt(app, [1]))).toBe(true)
    const made = await app.list()
    expect(made.map((w) => w.name)).toEqual(["Plain"])
    // A workflow with nothing to do has no checklist.
    expect(await checklistOf(app, made[0]?.id ?? "")).toBeNull()
  })

  test("the new workflow has a checklist: pick an agent, pick a place, turn it on", async () => {
    const app = await setup()
    await app.agent("Ada")
    const path = app.write("hand.json", file([hand]))
    await app.openFile(path)
    await pickIt(app, [0])
    const [made] = await app.list()
    expect(made?.enabled).toBe(false)
    const checklist = await checklistOf(app, made?.id ?? "")
    expect(checklist?.items).toEqual([
      { kind: "stepAgent", stepId: "s1", name: "Zed works" },
      { kind: "stepPlace", stepId: "s2", name: "Share" },
      { kind: "workflowOn" },
    ])
  })

  test("nothing ticked, or a place that the file does not have, is refused", async () => {
    const app = await setup()
    const path = app.write("one.json", file([{ name: "One" }]))
    await app.openFile(path)
    expect(failure(await pickIt(app, []))?.code).toBe("import_nothing_picked")
    expect(failure(await pickIt(app, [2]))?.code).toBe("invalid_input")
    expect(failure(await pickIt(app, [0, 0]))?.code).toBe("invalid_input")
    expect(await app.list()).toHaveLength(0)
  })
})

describe("export for CC Workflow Studio (spec 010)", () => {
  const exportCc = (app: App, path: string, workflowId: string) => {
    app.pick.save = path
    return app.run(WorkflowFiles.use((f) => f.exportCc({ serverId: app.server.id, workflowId })))
  }
  const written = (path: string) =>
    JSON.parse(readFileSync(path, "utf8")) as {
      name: string
      nodes: { id: string; type: string; data: Record<string, unknown> }[]
      connections: { from: string; fromPort: string; to: string }[]
    }

  test("it writes the file of that tool, and lists what the file does not hold", async () => {
    const app = await setup()
    const { workflow } = await full(app)
    const path = join(app.dataDir, "digest.json")
    const result = await exportCc(app, path, workflow.id)
    expect(result.path).toBe(path)
    const file = written(path)
    expect(file.name).toBe("digest")
    expect(file.nodes.map((n) => [n.id, n.type])).toEqual([
      ["start", "start"],
      ["step-1", "subAgent"],
      ["step-2", "ifElse"],
      ["step-3", "askUserQuestion"],
      ["end", "end"],
    ])
    expect(file.nodes[1]?.data).toMatchObject({ description: "Draft", prompt: "Write a haiku" })
    expect(file.connections.map((c) => `${c.from}:${c.fromPort}>${c.to}`).sort()).toEqual([
      "start:output>step-1",
      "step-1:output>step-2",
      "step-2:branch-0>step-3",
      "step-2:branch-1>end",
      "step-3:branch-0>end",
    ])
    expect(result.notExported).toEqual([
      { kind: "step", step: 4, stepKind: "post", name: "Post" },
      { kind: "step", step: 5, stepKind: "notify", name: "Tell" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "notes", count: 1 },
      { kind: "stepSettings", count: 1 },
    ])
  })

  test("the file holds no id, no agent, no channel and no key of this app", async () => {
    const app = await setup()
    const { workflow, ada, out } = await full(app)
    const path = join(app.dataDir, "digest.json")
    await exportCc(app, path, workflow.id)
    const text = readFileSync(path, "utf8")
    for (const needle of [ada.id, out.id, workflow.id, "Ada", KEY])
      expect(text).not.toContain(needle)
  })

  test("text that looks like a secret, and a stored key, are hidden", async () => {
    const app = await setup()
    const workflow = await app.create("Keyed", {
      steps: [
        {
          id: "a",
          kind: "agent",
          name: "Use",
          x: 0,
          y: 0,
          agentId: "",
          prompt: `Sign in with ${LOOKALIKE} and ${KEY}`,
          continueOnFailure: false,
        },
      ],
    })
    const path = join(app.dataDir, "keyed.json")
    await exportCc(app, path, workflow.id)
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain(LOOKALIKE)
    expect(text).not.toContain(KEY)
    expect(text).toContain("[redacted]")
  })

  test("a cancelled dialog writes nothing, and an unknown workflow is refused", async () => {
    const app = await setup()
    const workflow = await app.create("One")
    app.pick.save = undefined
    const cancelled = await app.run(
      WorkflowFiles.use((f) => f.exportCc({ serverId: app.server.id, workflowId: workflow.id })),
    )
    expect(cancelled).toEqual({ path: null, notExported: [] })
    app.pick.save = join(app.dataDir, "none.json")
    const missing = await app.exit(
      WorkflowFiles.use((f) => f.exportCc({ serverId: app.server.id, workflowId: "nope" })),
    )
    expect(failure(missing)?.code).toBe("workflow_not_found")
    expect(existsSync(join(app.dataDir, "none.json"))).toBe(false)
  })

  test("the file that was written imports into an empty app with the same steps and prompts", async () => {
    const app = await setup()
    const ada = await app.agent("Ada")
    const workflow = await app.create("Round", {
      steps: [
        {
          id: "a",
          kind: "agent",
          name: "Draft",
          x: 10,
          y: 20,
          agentId: ada.id,
          prompt: "Write a haiku",
          continueOnFailure: false,
        },
        {
          id: "c",
          kind: "condition",
          name: "Haiku?",
          x: 300,
          y: 20,
          contains: "haiku",
          mode: "contains",
        },
        {
          id: "y",
          kind: "agent",
          name: "Yes",
          x: 600,
          y: 0,
          agentId: ada.id,
          prompt: "Say well done",
          continueOnFailure: false,
        },
        {
          id: "n",
          kind: "agent",
          name: "No",
          x: 600,
          y: 120,
          agentId: ada.id,
          prompt: "Try again",
          continueOnFailure: false,
        },
      ],
      edges: [app.edge("a", "c"), app.edge("c", "y", "yes"), app.edge("c", "n", "no")],
    })
    const path = join(app.dataDir, "round.json")
    await exportCc(app, path, workflow.id)

    const other = await setup()
    await other.openFile(path)
    expect(
      Exit.isSuccess(
        await other.exit(
          WorkflowFiles.use((f) => f.import({ serverId: other.server.id, pick: [0] })),
        ),
      ),
    ).toBe(true)
    const [made] = await other.list()
    expect(made?.name).toBe("round")
    expect(made?.steps.map((s) => [s.kind, s.name])).toEqual([
      ["agent", "Draft"],
      ["condition", "The input of this step"],
      ["agent", "Yes"],
      ["agent", "No"],
    ])
    expect(made?.steps.map((s) => (s.kind === "agent" ? s.prompt : null))).toEqual([
      "Write a haiku",
      null,
      "Say well done",
      "Try again",
    ])
    expect(made?.steps[1]).toMatchObject({ mode: "ask" })
    expect(made?.edges.map((e) => [e.from, e.to, e.branch])).toEqual([
      ["s1", "s2", undefined],
      ["s2", "s3", "yes"],
      ["s2", "s4", "no"],
    ])
  })
})

describe("a file of CC Workflow Studio (spec 010)", () => {
  const node = (id: string, type: string, data: Record<string, unknown> = {}, name = id) => ({
    id,
    type,
    name,
    position: { x: 10, y: 20 },
    data,
  })
  const link = (from: string, to: string, fromPort?: string) => ({
    id: `${from}-${to}`,
    from,
    to,
    ...(fromPort ? { fromPort } : {}),
  })
  /** First prompt, a question node, second prompt: the second prompt loses its input. */
  const cc = (over: Record<string, unknown> = {}) => ({
    id: "w1",
    name: "daily-flow",
    version: "1.0.0",
    nodes: [
      node("start", "start"),
      node("a", "prompt", { label: "First", prompt: "one" }),
      node("q", "askUserQuestion", { questionText: "Which way?", options: [] }, "which-way"),
      node("b", "prompt", { label: "Second", prompt: "two" }),
      node("end", "end"),
    ],
    connections: [
      link("start", "a", "output"),
      link("a", "q", "output"),
      link("q", "b", "branch-0"),
      link("b", "end", "output"),
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  })
  const apply = (app: App, over: { pick?: readonly number[]; agentId?: string } = {}) =>
    app.exit(
      WorkflowFiles.use((f) =>
        f.import({ serverId: app.server.id, pick: over.pick ?? [0], agentId: over.agentId }),
      ),
    )
  const checklistOf = (app: App, workflowId: string) =>
    app.run(Checklists.use((c) => c.forWorkflow(workflowId)))

  test("the preview tells the form, the lost connections, the agent steps and the notes", async () => {
    const app = await setup()
    const preview = await app.openFile(app.write("cc.json", cc()))
    expect(preview?.form).toBe("cc")
    expect(preview?.workflows).toEqual([
      {
        name: "daily-flow",
        fileName: null,
        trigger: "manual",
        steps: 2,
        notes: 1,
        missingAgents: [],
        secretRemoved: false,
        lostConnections: true,
        needAgent: 2,
      },
    ])
    expect(preview?.notImported).toEqual([
      { reason: "no_step", owner: "daily-flow", nodeType: "askUserQuestion", name: "which-way" },
    ])
  })

  test("the wrapped form is read too, and a ROBot file has the form robot", async () => {
    const app = await setup()
    const wrapped = await app.openFile(app.write("w.json", { meta: {}, workflow: cc() }))
    expect(wrapped?.form).toBe("cc")
    const robot = await app.openFile(app.write("r.json", file([{ name: "One" }])))
    expect(robot?.form).toBe("robot")
    expect(robot?.workflows.map((w) => [w.lostConnections, w.needAgent])).toEqual([[false, 0]])
  })

  test("a taken name gets a number, and the list of what is not imported uses the new name", async () => {
    const app = await setup()
    await app.create("Daily-Flow")
    const preview = await app.openFile(app.write("cc.json", cc()))
    expect(preview?.workflows[0]).toMatchObject({ name: "daily-flow 2", fileName: "daily-flow" })
    expect(preview?.notImported.map((n) => ("owner" in n ? n.owner : null))).toEqual([
      "daily-flow 2",
    ])
  })

  test("the import makes one workflow that is off, with a pink note, and a checklist", async () => {
    const app = await setup()
    await app.openFile(app.write("cc.json", cc()))
    expect(Exit.isSuccess(await apply(app))).toBe(true)
    const [made] = await app.list()
    expect(made).toMatchObject({ name: "daily-flow", enabled: false, trigger: { kind: "manual" } })
    expect(made?.steps.map((s) => [s.kind, s.name])).toEqual([
      ["agent", "First"],
      ["agent", "Second"],
    ])
    expect(made?.edges).toEqual([])
    expect(made?.notes).toMatchObject([
      { tone: "pink", text: "Not imported: askUserQuestion which-way\nWhich way?", x: 10, y: 20 },
    ])
    const checklist = await checklistOf(app, made?.id ?? "")
    expect(checklist?.items).toEqual([
      { kind: "stepAgent", stepId: "s1", name: "First" },
      { kind: "stepAgent", stepId: "s2", name: "Second" },
      { kind: "stepConnect", stepId: "s2", name: "Second" },
    ])
  })

  test("an agent that the user picks is the agent of every agent step", async () => {
    const app = await setup()
    const ada = await app.agent("Ada")
    await app.openFile(app.write("cc.json", cc()))
    expect(Exit.isSuccess(await apply(app, { agentId: ada.id }))).toBe(true)
    const [made] = await app.list()
    expect(made?.steps.map((s) => (s.kind === "agent" ? s.agentId : null))).toEqual([
      ada.id,
      ada.id,
    ])
    const checklist = await checklistOf(app, made?.id ?? "")
    expect(checklist?.items).toEqual([{ kind: "stepConnect", stepId: "s2", name: "Second" }])
  })

  test("an agent that does not exist or is archived is refused, and nothing is made", async () => {
    const app = await setup()
    const ada = await app.agent("Ada")
    await app.run(Agents.use((a) => a.archive(ada.id)))
    await app.openFile(app.write("cc.json", cc()))
    expect(failure(await apply(app, { agentId: "nobody" }))?.code).toBe("invalid_input")
    expect(failure(await apply(app, { agentId: ada.id }))?.code).toBe("invalid_input")
    expect(await app.list()).toHaveLength(0)
  })

  test("a file with no lost connection has no item Connect, and none is lost without a note", async () => {
    const app = await setup()
    const clean = cc({
      nodes: [node("a", "prompt", { prompt: "one" }), node("b", "prompt", { prompt: "two" })],
      connections: [link("a", "b", "output")],
    })
    const preview = await app.openFile(app.write("cc.json", clean))
    expect(preview?.workflows[0]).toMatchObject({ lostConnections: false, notes: 0 })
    expect(preview?.notImported).toEqual([])
    await apply(app)
    const [made] = await app.list()
    expect(made?.edges).toHaveLength(1)
    const checklist = await checklistOf(app, made?.id ?? "")
    expect(checklist?.items.map((i) => i.kind)).toEqual(["stepAgent", "stepAgent"])
  })

  test("text that looks like a secret is hidden, also in the list of what is not imported", async () => {
    const app = await setup()
    const keyed = cc({
      nodes: [
        node("a", "prompt", { label: "First", prompt: `Use ${LOOKALIKE} to sign in` }),
        node("q", "skill", { name: "lint" }, `skill-${LOOKALIKE}`),
      ],
      connections: [],
    })
    const preview = await app.openFile(app.write("cc.json", keyed))
    expect(preview?.workflows[0]?.secretRemoved).toBe(true)
    expect(JSON.stringify(preview)).not.toContain(LOOKALIKE)
    await apply(app)
    const [made] = await app.list()
    expect(JSON.stringify(made)).not.toContain(LOOKALIKE)
  })

  test("a loop refuses the file, names the workflow, and makes nothing", async () => {
    const app = await setup()
    const loop = cc({
      nodes: [node("a", "prompt", { prompt: "1" }), node("b", "prompt", { prompt: "2" })],
      connections: [link("a", "b"), link("b", "a")],
    })
    const result = await app.openExit(app.write("loop.json", loop))
    expect(failure(result)?.code).toBe("workflow_file_graph")
    expect(JSON.parse(failure(result)?.detail ?? "{}")).toMatchObject({
      workflow: "daily-flow",
      fault: "cycle",
    })
    expect(await app.list()).toHaveLength(0)
  })

  test("a file that is neither form is refused as before", async () => {
    const app = await setup()
    const result = await app.openExit(app.write("no.json", { nodes: [], hello: 1 }))
    expect(failure(result)?.code).toBe("workflow_file_format")
  })
})

const untilEnded = async (app: App, runId: string) => {
  for (let i = 0; i < 300; i++) {
    const detail = await app.run(Workflows.use((w) => w.runDetail(runId)))
    if (detail.run.state !== "running") return
    await Bun.sleep(15)
  }
  throw new Error("the run did not end")
}

describe('a workflow from a starter (spec 010, "Starters")', () => {
  /** Makes the workflow as the window does when the user presses Create. */
  const fromStarter = async (app: App, agentId: string, locale: "en" | "ko" = "en") => {
    const text = workflowStarterText(locale, "tla")
    const taken = (await app.list()).map((w) => w.name)
    return app.run(
      Workflows.use((w) =>
        w.create(
          buildTlaStarter({
            serverId: app.server.id,
            name: starterWorkflowName(text.name, taken),
            agentId,
            text,
          }),
        ),
      ),
    )
  }

  for (const locale of ["en", "ko"] as const) {
    test(`it is saved with six steps, five connections and one note, and the file holds the same (${locale})`, async () => {
      const app = await setup()
      const reviewer = await app.agent("Reviewer")
      const made = await fromStarter(app, reviewer.id, locale)
      expect(made.trigger).toEqual({ kind: "manual" })
      expect(made.steps.map((s) => s.kind)).toEqual([
        "agent",
        "agent",
        "condition",
        "notify",
        "agent",
        "notify",
      ])
      expect(made.notes.map((n) => n.tone)).toEqual(["yellow"])

      const path = join(app.dataDir, "starter.json")
      await app.exportTo(path, [made.id])
      const written = readFile(path)
      const [flow] = written.workflows
      expect(flow?.name).toBe(workflowStarterText(locale, "tla").name)
      expect(flow?.steps.map((s) => s.kind)).toEqual([
        "agent",
        "agent",
        "condition",
        "notify",
        "agent",
        "notify",
      ])
      // Every agent step names the agent. Nothing was hidden as a secret.
      expect(flow?.steps.filter((s) => s.kind === "agent").map((s) => s.agent)).toEqual([
        "Reviewer",
        "Reviewer",
        "Reviewer",
      ])
      expect(JSON.stringify(written)).not.toContain("[redacted]")
      expect(flow?.connections).toEqual([
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 3, to: 4, branch: "yes" },
        { from: 3, to: 5, branch: "no" },
        { from: 5, to: 6 },
      ])
      expect(flow?.steps[2]).toMatchObject({ mode: "contains", text: "TLC_RESULT: PASS" })
    })

    test(`the file imports into an empty app that has the agent: nothing is left out, and the workflow is the same (${locale})`, async () => {
      const source = await setup()
      const reviewer = await source.agent("Reviewer")
      const made = await fromStarter(source, reviewer.id, locale)
      const first = join(source.dataDir, "one.json")
      await source.exportTo(first, [made.id])

      const target = await setup()
      const other = await target.agent("Reviewer")
      const preview = await target.openFile(first)
      expect(preview?.notImported).toEqual([])
      expect(preview?.workflows.map((w) => [w.steps, w.notes, w.missingAgents])).toEqual([
        [6, 1, []],
      ])
      await target.importFile(first)
      const [imported] = await target.list()
      expect(
        imported?.steps
          .filter((s) => s.kind === "agent")
          .map((s) => s.kind === "agent" && s.agentId),
      ).toEqual([other.id, other.id, other.id])
      const second = join(target.dataDir, "two.json")
      await target.exportTo(second, [imported?.id ?? ""])
      expect(readFile(second)).toEqual(readFile(first))
    })
  }

  test("a second workflow from the starter has the same name with a number", async () => {
    const app = await setup()
    const reviewer = await app.agent("Reviewer")
    const one = await fromStarter(app, reviewer.id)
    const two = await fromStarter(app, reviewer.id)
    const three = await fromStarter(app, reviewer.id)
    expect([one.name, two.name, three.name]).toEqual(["TLA+ check", "TLA+ check 2", "TLA+ check 3"])
  })

  test("the new workflow is on, is not running, and runs on this computer", async () => {
    const app = await setup()
    const reviewer = await app.agent("Reviewer")
    const made = await fromStarter(app, reviewer.id)
    expect(made.runsOn).toBeNull()
    expect(made.running).toBe(false)
    expect(made.enabled).toBe(true)
  })
})
