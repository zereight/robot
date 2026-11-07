import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { catalogues, DOCUMENT_MAX, DOCUMENT_VERSIONS_MAX, NODES_MAX } from "@robot/shared"
import { Effect, Exit } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Database } from "./Database.ts"
import { Rules } from "./Rules.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { testRuntime } from "./testing.ts"
import { effectivePermission, Workflows, workflowFolderName } from "./Workflows.ts"

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const w = <A>(f: (x: Workflows["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>) =>
    run(Workflows.use(f))
  const create = (name: string, document?: string) =>
    w((x) =>
      x.create({ serverId: server.id, name, ...(document === undefined ? {} : { document }) }),
    )
  const code = async <A>(
    f: (x: Workflows["Service"]) => Effect.Effect<A, import("./errors.ts").AppError>,
  ) => {
    const exit = await t.runtime.runPromiseExit(Workflows.use(f))
    if (Exit.isSuccess(exit)) return "ok"
    return exit.cause.reasons
      .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
      .join()
  }
  const sql = (statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.run(statement, ...params))))
  const rows = <T>(statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all<T>(statement, ...params))))
  return { ...t, run, server, w, create, code, sql, rows }
}

describe("a new workflow (spec 010)", () => {
  test("it has the trimmed name, a document, a folder on disk and the default permission level", async () => {
    const t = await setup()
    const flow = await t.create("  Weekly report ", "Send the report.")
    expect(flow.name).toBe("Weekly report")
    expect(flow.permission).toBe("ask_risky")
    expect(flow.nodeCount).toBe(0)
    expect(existsSync(flow.folder)).toBe(true)
    expect(flow.folder).toContain(workflowFolderName("Weekly report", flow.id))
    const detail = await t.w((x) => x.get(flow.id))
    expect(detail.document).toBe("Send the report.")
    expect(detail.graph).toEqual({ nodes: [], connections: [] })
  })

  test("with no text, the document has the short default text in the language of the interface", async () => {
    const t = await setup()
    const en = await t.create("English")
    expect(en.id).toBeTruthy()
    expect((await t.w((x) => x.get(en.id))).document).toBe(
      catalogues.en["workflows.document.default"],
    )
    await t.run(SettingsStore.use((s) => s.update({ language: "ko" })))
    const ko = await t.create("한국어")
    const text = (await t.w((x) => x.get(ko.id))).document
    expect(text).toBe(catalogues.ko["workflows.document.default"])
    expect(text).not.toBe(catalogues.en["workflows.document.default"])
    expect(text.length).toBeGreaterThan(0)
    expect(text.length).toBeLessThan(500)
  })

  test("a text that the caller gives replaces the default, also an empty one", async () => {
    const t = await setup()
    const empty = await t.create("Empty", "")
    expect((await t.w((x) => x.get(empty.id))).document).toBe("")
  })

  test("a name is not empty and is unique on the server, ignoring case", async () => {
    const t = await setup()
    await t.create("Report")
    expect(await t.code((x) => x.create({ serverId: t.server.id, name: "  " }))).toBe(
      "workflow_name_empty",
    )
    expect(await t.code((x) => x.create({ serverId: t.server.id, name: "REPORT" }))).toBe(
      "workflow_name_taken",
    )
  })

  test("a rename keeps the name rule, and the same name in another case is allowed", async () => {
    const t = await setup()
    const a = await t.create("Report")
    await t.create("Other")
    expect(await t.code((x) => x.rename(a.id, "other"))).toBe("workflow_name_taken")
    expect((await t.w((x) => x.rename(a.id, "REPORT"))).name).toBe("REPORT")
  })

  test("a change tells the screens", async () => {
    const t = await setup()
    await t.create("Report")
    expect(t.events.some((e) => e.event === "workflows.changed")).toBe(true)
  })
})

describe("the responsible document (spec 002)", () => {
  test("a save keeps the old text as a version; the same text makes none", async () => {
    const t = await setup()
    const flow = await t.create("Report", "one")
    await t.w((x) => x.saveDocument(flow.id, "two"))
    await t.w((x) => x.saveDocument(flow.id, "two"))
    const history = await t.w((x) => x.documentHistory(flow.id))
    expect(history.map((v) => v.text)).toEqual(["one"])
    expect((await t.w((x) => x.get(flow.id))).document).toBe("two")
  })

  test("the history keeps the 50 newest versions", async () => {
    const t = await setup()
    const flow = await t.create("Report", "v0")
    for (let i = 1; i <= DOCUMENT_VERSIONS_MAX + 5; i++)
      await t.w((x) => x.saveDocument(flow.id, `v${i}`))
    const history = await t.w((x) => x.documentHistory(flow.id))
    expect(history).toHaveLength(DOCUMENT_VERSIONS_MAX)
    expect(history[0]?.text).toBe(`v${DOCUMENT_VERSIONS_MAX + 4}`)
  })

  test("a restore makes a new version and keeps the others", async () => {
    const t = await setup()
    const flow = await t.create("Report", "one")
    await t.w((x) => x.saveDocument(flow.id, "two"))
    const [first] = await t.w((x) => x.documentHistory(flow.id))
    const restored = await t.w((x) => x.restoreDocument(flow.id, (first as { id: string }).id))
    expect(restored.document).toBe("one")
    const history = await t.w((x) => x.documentHistory(flow.id))
    expect(history.map((v) => v.text)).toEqual(["two", "one"])
    expect(history[0]?.source).toBe("restore")
    expect(await t.code((x) => x.restoreDocument(flow.id, "nope"))).toBe("version_not_found")
  })

  test("text over 20000 characters or with a secret is refused, and nothing changes", async () => {
    const t = await setup()
    const flow = await t.create("Report", "keep")
    expect(await t.code((x) => x.saveDocument(flow.id, "x".repeat(DOCUMENT_MAX + 1)))).toBe(
      "document_too_long",
    )
    expect(
      await t.code((x) =>
        x.saveDocument(flow.id, "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
      ),
    ).toBe("document_secret")
    expect((await t.w((x) => x.get(flow.id))).document).toBe("keep")
    expect(await t.w((x) => x.documentHistory(flow.id))).toEqual([])
  })

  test("the editor is read-only while a run works", async () => {
    const t = await setup()
    const flow = await t.create("Report", "one")
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'working', 'hand', ?)",
      flow.id,
      Date.now(),
    )
    expect(await t.code((x) => x.saveDocument(flow.id, "two"))).toBe("workflow_running")
  })

  test("a workflow cannot be renamed or deleted while a run works; the run rows stay", async () => {
    const t = await setup()
    const flow = await t.create("Report", "one")
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'working', 'hand', ?)",
      flow.id,
      Date.now(),
    )
    expect(await t.code((x) => x.rename(flow.id, "Other"))).toBe("workflow_running")
    expect(await t.code((x) => x.remove(flow.id))).toBe("workflow_running")
    expect((await t.w((x) => x.get(flow.id))).name).toBe("Report")
    expect(await t.rows("SELECT id FROM run WHERE workflow_id = ?", flow.id)).toHaveLength(1)
    await t.sql("UPDATE run SET finished_at = ? WHERE id = 'r1'", Date.now())
    await t.w((x) => x.rename(flow.id, "Other"))
    expect((await t.w((x) => x.get(flow.id))).name).toBe("Other")
  })
})

describe("the graph (spec 010)", () => {
  test("a node gets the next number; a removed node renumbers the rest and drops its connections", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const a = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Read" }))
    const b = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Write" }))
    const c = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Send" }))
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3])
    await t.w((x) => x.connect(flow.id, a.id, b.id))
    await t.w((x) => x.connect(flow.id, b.id, c.id))
    await t.w((x) => x.removeNode(b.id))
    const graph = await t.w((x) => x.graph(flow.id))
    expect(graph.nodes.map((n) => [n.name, n.number])).toEqual([
      ["Read", 1],
      ["Send", 2],
    ])
    expect(graph.connections).toEqual([])
  })

  test("a workflow holds at most 30 nodes", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    for (let i = 0; i < NODES_MAX; i++)
      await t.w((x) => x.addNode(flow.id, { kind: "text", name: `N${i}` }))
    expect(await t.code((x) => x.addNode(flow.id, { kind: "text", name: "More" }))).toBe(
      "workflow_nodes_full",
    )
  })

  test("a node permission level may only be stricter than the workflow level", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    await t.w((x) => x.setPermission(flow.id, "ask_risky"))
    expect(
      await t.code((x) => x.addNode(flow.id, { kind: "text", name: "A", permission: "full" })),
    ).toBe("node_permission_looser")
    const strict = await t.w((x) =>
      x.addNode(flow.id, { kind: "text", name: "B", permission: "ask_all" }),
    )
    expect(strict.permission).toBe("ask_all")
    expect(await t.code((x) => x.updateNode(strict.id, { permission: "full" }))).toBe(
      "node_permission_looser",
    )
    expect(effectivePermission("ask_risky", null)).toBe("ask_risky")
    expect(effectivePermission("ask_risky", "read_only")).toBe("read_only")
    expect(effectivePermission("ask_all", "full")).toBe("ask_all")
  })

  test("a decision node has at least two options, a threshold of 0.9 by default, and each option leads on", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    expect(
      await t.code((x) => x.addNode(flow.id, { kind: "decision", name: "Ok?", options: ["Yes"] })),
    ).toBe("decision_options")
    const d = await t.w((x) =>
      x.addNode(flow.id, {
        kind: "decision",
        name: "Ok?",
        question: "Is it fine?",
        options: ["Yes", "No"],
      }),
    )
    expect(d.threshold).toBe(0.9)
    expect(d.options.map((o) => o.label)).toEqual(["Yes", "No"])
    const next = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Go" }))
    // A decision node connects through one of its options only.
    expect(await t.code((x) => x.connect(flow.id, d.id, next.id))).toBe("connection_option_missing")
    const link = await t.w((x) => x.connect(flow.id, d.id, next.id, d.options[0]?.id ?? null))
    expect(link.optionId).toBe(d.options[0]?.id ?? null)
    expect(await t.code((x) => x.connect(flow.id, next.id, next.id))).toBe("connection_to_self")
    expect(await t.code((x) => x.connect(flow.id, next.id, d.id, d.options[0]?.id ?? null))).toBe(
      "connection_option_unexpected",
    )
  })

  test("a line is not made twice, and an option has one outgoing connection", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const a = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "A" }))
    const b = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "B" }))
    const c = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "C" }))
    await t.w((x) => x.connect(flow.id, a.id, b.id))
    expect(await t.code((x) => x.connect(flow.id, a.id, b.id))).toBe("connection_exists")
    const d = await t.w((x) =>
      x.addNode(flow.id, {
        kind: "decision",
        name: "Ok?",
        question: "Fine?",
        options: ["Yes", "No"],
      }),
    )
    const yes = d.options[0]?.id ?? null
    const no = d.options[1]?.id ?? null
    await t.w((x) => x.connect(flow.id, d.id, b.id, yes))
    // The same option cannot lead to a second node, and the other option stays free.
    expect(await t.code((x) => x.connect(flow.id, d.id, c.id, yes))).toBe("connection_exists")
    expect(await t.code((x) => x.connect(flow.id, d.id, c.id, no))).toBe("ok")
    expect((await t.w((x) => x.graph(flow.id))).connections).toHaveLength(3)
  })

  test("a restore keeps the node of the tasks of a node that comes back", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const a = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Read" }))
    const b = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Write" }))
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at, finished_at) VALUES ('r1', ?, 'done', 'hand', 1, 2)",
      flow.id,
    )
    for (const [id, node, name, number] of [
      ["t1", a.id, "Read", 1],
      ["t2", b.id, "Write", 2],
    ] as const)
      await t.sql(
        "INSERT INTO task (id, run_id, workflow_id, node_id, node_name, node_number, state, created_at) VALUES (?, 'r1', ?, ?, ?, ?, 'done', 1)",
        id,
        flow.id,
        node,
        name,
        number,
      )
    // The version from before node B was added holds node A only.
    const versions = await t.w((x) => x.versions(flow.id))
    const beforeB = versions[0] as { id: string }
    await t.w((x) => x.restoreVersion(flow.id, beforeB.id))
    const tasks = await t.rows<{ id: string; node_id: string | null }>(
      "SELECT id, node_id FROM task ORDER BY id",
    )
    // Node A is back with its id, so its task still points to it. Node B is gone.
    expect(tasks).toEqual([
      { id: "t1", node_id: a.id },
      { id: "t2", node_id: null },
    ])
  })

  test("a level that is not a permission level is refused by the database", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const node = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "A" }))
    await expect(
      t.sql("UPDATE workflow SET permission = 'everything' WHERE id = ?", flow.id),
    ).rejects.toThrow()
    await expect(
      t.sql("UPDATE workflow_node SET permission = 'everything' WHERE id = ?", node.id),
    ).rejects.toThrow()
    await t.sql("UPDATE workflow_node SET permission = 'read_only' WHERE id = ?", node.id)
    await t.sql("UPDATE workflow_node SET permission = NULL WHERE id = ?", node.id)
  })

  test("a step in the action log names the node of its task as it was then", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const node = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Read" }))
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at, finished_at) VALUES ('r1', ?, 'done', 'hand', 1, 2)",
      flow.id,
    )
    await t.sql(
      "INSERT INTO task (id, run_id, workflow_id, node_id, node_name, node_number, state, created_at) VALUES ('t1', 'r1', ?, ?, 'Read', 1, 'done', 1)",
      flow.id,
      node.id,
    )
    const step = (taskId: string | null) =>
      t.run(
        ActionLog.use((l) =>
          Effect.sync(() =>
            l.add({
              workflowId: flow.id,
              kind: "shell",
              target: "ls",
              decidedBy: "user",
              result: "ran",
              taskId,
              outside: null,
            }),
          ),
        ),
      )
    const withTask = await step("t1")
    expect([withTask.nodeName, withTask.nodeNumber]).toEqual(["Read", 1])
    await t.w((x) => x.updateNode(node.id, { name: "Renamed" }))
    const listed = await t.run(ActionLog.use((l) => l.list({ workflowId: flow.id })))
    expect(listed[0]?.nodeName).toBe("Read")
    const without = await step(null)
    expect([without.nodeName, without.nodeNumber]).toEqual([null, null])
  })

  test("each edit keeps the graph as a version, and a restore keeps the graph it replaces", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const a = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Read" }))
    await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Write" }))
    const versions = await t.w((x) => x.versions(flow.id))
    expect(versions).toHaveLength(2)
    // The oldest version is the empty graph that came before the first node.
    const oldest = versions.at(-1)
    const restored = await t.w((x) => x.restoreVersion(flow.id, (oldest as { id: string }).id))
    expect(restored.nodes).toEqual([])
    expect((await t.w((x) => x.versions(flow.id))).length).toBe(3)
    expect(a.id).toBeTruthy()
  })

  test("the graph is read-only while a run works", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'working', 'hand', ?)",
      flow.id,
      Date.now(),
    )
    expect(await t.code((x) => x.addNode(flow.id, { kind: "text", name: "A" }))).toBe(
      "workflow_running",
    )
  })
})

describe("folder, level and decision fields (spec 010)", () => {
  const running = (t: Awaited<ReturnType<typeof setup>>, id: string) =>
    t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'working', 'hand', 1)",
      id,
    )

  test("the folder and the permission level are refused while a run works", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    await running(t, flow.id)
    expect(await t.code((x) => x.setPermission(flow.id, "read_only"))).toBe("workflow_running")
    expect(await t.code((x) => x.setFolder(flow.id, "/tmp/elsewhere"))).toBe("workflow_running")
    const after = await t.w((x) => x.get(flow.id))
    expect([after.permission, after.folder]).toEqual([flow.permission, flow.folder])
    // The run ends: the same calls work.
    await t.sql("UPDATE run SET state = 'done', finished_at = 2 WHERE id = 'r1'")
    expect((await t.w((x) => x.setPermission(flow.id, "read_only"))).permission).toBe("read_only")
    expect((await t.w((x) => x.setFolder(flow.id, "/tmp/elsewhere"))).folder).toBe("/tmp/elsewhere")
  })

  test("a stricter workflow level is refused while a node is looser, and a restore re-checks the nodes", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    await t.w((x) => x.setPermission(flow.id, "full"))
    const loose = await t.w((x) =>
      x.addNode(flow.id, { kind: "text", name: "A", permission: "ask_unsure" }),
    )
    expect(await t.code((x) => x.setPermission(flow.id, "ask_risky"))).toBe(
      "workflow_permission_nodes",
    )
    expect((await t.w((x) => x.get(flow.id))).permission).toBe("full")
    // A level that no node exceeds works. A node that is stricter than it stays.
    await t.w((x) => x.setPermission(flow.id, "ask_unsure"))
    await t.w((x) => x.updateNode(loose.id, { permission: "ask_all" }))
    await t.w((x) => x.setPermission(flow.id, "ask_risky"))
    // The version before the last edit holds the node at "ask_unsure": looser than the workflow.
    const versions = await t.w((x) => x.versions(flow.id))
    const old = versions.find((v) => v.graph.nodes[0]?.permission === "ask_unsure")
    expect(old).toBeDefined()
    expect(await t.code((x) => x.restoreVersion(flow.id, (old as { id: string }).id))).toBe(
      "node_permission_looser",
    )
    expect((await t.w((x) => x.graph(flow.id))).nodes[0]?.permission).toBe("ask_all")
  })

  test("a decision node takes no model, no reasoning level and no permission level", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const bad = { kind: "decision", name: "Ok?", options: ["Yes", "No"] } as const
    expect(await t.code((x) => x.addNode(flow.id, { ...bad, model: "m" }))).toBe("decision_model")
    expect(await t.code((x) => x.addNode(flow.id, { ...bad, accountId: "a" }))).toBe(
      "decision_model",
    )
    expect(await t.code((x) => x.addNode(flow.id, { ...bad, effort: "high" }))).toBe(
      "decision_effort",
    )
    expect(await t.code((x) => x.addNode(flow.id, { ...bad, permission: "read_only" }))).toBe(
      "decision_permission",
    )
    const d = await t.w((x) => x.addNode(flow.id, bad))
    expect(await t.code((x) => x.updateNode(d.id, { model: "m" }))).toBe("decision_model")
    expect(await t.code((x) => x.updateNode(d.id, { effort: "low" }))).toBe("decision_effort")
    expect(await t.code((x) => x.updateNode(d.id, { permission: "read_only" }))).toBe(
      "decision_permission",
    )
    expect(await t.code((x) => x.updateNode(d.id, { model: null, name: "Fine?" }))).toBe("ok")
    const node = (await t.w((x) => x.graph(flow.id))).nodes[0]
    expect([node?.model, node?.accountId, node?.effort, node?.permission]).toEqual([
      null,
      null,
      null,
      null,
    ])
  })
})

describe("the graph editor (spec 010, flow 2)", () => {
  test("a move changes the place only: no version, same number", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const a = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "A" }))
    const before = (await t.w((x) => x.versions(flow.id))).length
    await t.w((x) => x.moveNode(a.id, 120, 80))
    const moved = (await t.w((x) => x.graph(flow.id))).nodes[0]
    expect([moved?.x, moved?.y, moved?.number]).toEqual([120, 80, 1])
    expect((await t.w((x) => x.versions(flow.id))).length).toBe(before)
    expect(await t.code((x) => x.moveNode(a.id, Number.NaN, 1))).toBe("invalid_input")
  })

  test("a move is refused while a run works", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const a = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "A" }))
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', 1)",
      flow.id,
    )
    expect(await t.code((x) => x.moveNode(a.id, 5, 5))).toBe("workflow_running")
  })

  test("options: add, rename, remove with its connection, keep at least two", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const d = await t.w((x) =>
      x.addNode(flow.id, { kind: "decision", name: "Ok?", options: ["Yes", "No"] }),
    )
    const next = await t.w((x) => x.addNode(flow.id, { kind: "text", name: "Go" }))
    const three = await t.w((x) => x.addOption(d.id, "Maybe"))
    expect(three.options.map((o) => o.label)).toEqual(["Yes", "No", "Maybe"])
    const maybe = three.options[2]?.id ?? ""
    await t.w((x) => x.connect(flow.id, d.id, next.id, maybe))
    const renamed = await t.w((x) => x.renameOption(maybe, " Perhaps "))
    expect(renamed.options[2]?.label).toBe("Perhaps")
    expect(await t.code((x) => x.renameOption(maybe, "  "))).toBe("option_label_empty")
    expect(await t.code((x) => x.addOption(next.id, "No"))).toBe("text_node_options")
    const two = await t.w((x) => x.removeOption(maybe))
    expect(two.options.map((o) => o.label)).toEqual(["Yes", "No"])
    // The connection of the removed option went with it.
    expect((await t.w((x) => x.graph(flow.id))).connections).toEqual([])
    expect(await t.code((x) => x.removeOption(two.options[0]?.id ?? ""))).toBe("decision_options")
    expect(await t.code((x) => x.removeOption("nope"))).toBe("option_not_found")
    // Each change kept the graph before it as a version.
    expect((await t.w((x) => x.versions(flow.id))).length).toBeGreaterThanOrEqual(5)
  })
})

describe("the facts of a card of the list (spec 001)", () => {
  test("a new workflow has no run, no result of the check, and does not run", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const [card] = await t.w((x) => x.list(t.server.id))
    expect(card?.id).toBe(flow.id)
    expect(card?.lastRun).toBeNull()
    expect(card?.running).toBe(false)
    expect(card?.working).toBe(false)
    expect(card?.check).toBe("not_checked")
  })

  test("a run that waits for the user or in the queue locks the editor but does not work (spec 039)", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    const card = async () => (await t.w((x) => x.list(t.server.id)))[0]
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', 1)",
      flow.id,
    )
    expect(await card()).toMatchObject({ running: true, working: true })
    // A run parked on an approval card.
    await t.sql("UPDATE run SET state = 'waiting' WHERE id = 'r1'")
    expect(await card()).toMatchObject({ running: true, working: false })
    // The step goes on after the answer.
    await t.sql("UPDATE run SET state = 'running' WHERE id = 'r1'")
    expect(await card()).toMatchObject({ running: true, working: true })
    // A run in the queue.
    await t.sql("UPDATE run SET state = 'queued' WHERE id = 'r1'")
    expect(await card()).toMatchObject({ running: true, working: false })
    // The detail has the same two flags as the card.
    expect(await t.w((x) => x.get(flow.id))).toMatchObject({ running: true, working: false })
    // An ended run does neither.
    await t.sql("UPDATE run SET state = 'done', finished_at = 2 WHERE id = 'r1'")
    expect(await card()).toMatchObject({ running: false, working: false })
  })

  test("the last run and the running mark follow the runs", async () => {
    const t = await setup()
    const flow = await t.create("Report")
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at, finished_at) VALUES ('r1', ?, 'failed', 'hand', 100, 200)",
      flow.id,
    )
    await t.sql(
      "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r2', ?, 'running', 'chat', 300)",
      flow.id,
    )
    const [card] = await t.w((x) => x.list(t.server.id))
    expect(card?.lastRun).toEqual({ state: "running", startedAt: 300 })
    expect(card?.running).toBe(true)
    expect(card?.working).toBe(true)
    await t.sql("UPDATE run SET state = 'done', finished_at = 400 WHERE id = 'r2'")
    const [after] = await t.w((x) => x.list(t.server.id))
    expect(after?.lastRun).toEqual({ state: "done", startedAt: 300 })
    expect(after?.running).toBe(false)
  })

  test("the list shows workflows in alphabetical order, ignoring case", async () => {
    const t = await setup()
    await t.create("Weekly")
    await t.create("daily")
    await t.create("Monthly")
    const names = (await t.w((x) => x.list(t.server.id))).map((f) => f.name)
    expect(names).toEqual(["daily", "Monthly", "Weekly"])
  })
})

describe("a delete (spec 010)", () => {
  test("it removes the graph, history, chat, runs, memory, rules and secrets of the workflow only", async () => {
    const t = await setup()
    const gone = await t.create("Gone", "text")
    const stay = await t.create("Stay", "text")
    for (const flow of [gone, stay]) {
      await t.w((x) => x.addNode(flow.id, { kind: "text", name: "A" }))
      await t.w((x) => x.saveDocument(flow.id, "changed"))
      await t.sql(
        "INSERT INTO chat_thread (id, workflow_id, title, created_at) VALUES (?, ?, 'T', 1)",
        `t-${flow.id}`,
        flow.id,
      )
      await t.run(
        Rules.use((r) =>
          r.add({ workflowId: flow.id, kind: "shell", text: "ls", decision: "allow" }),
        ),
      )
      await t.run(
        ActionLog.use((l) =>
          Effect.sync(() =>
            l.add({
              workflowId: flow.id,
              kind: "shell",
              target: "ls",
              decidedBy: "user",
              result: "ran",
              taskId: null,
              outside: null,
            }),
          ),
        ),
      )
    }
    await t.w((x) => x.remove(gone.id))
    const count = async (table: string, id: string) =>
      (
        await t.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE workflow_id = ?`, id)
      )[0]?.n
    for (const table of [
      "workflow_node",
      "workflow_version",
      "document_version",
      "chat_thread",
      "permission_rule",
    ]) {
      expect([table, await count(table, gone.id)]).toEqual([table, 0])
      expect(((await count(table, stay.id)) ?? 0) > 0).toBe(true)
    }
    expect(await t.code((x) => x.get(gone.id))).toBe("workflow_not_found")
    expect((await t.w((x) => x.list(t.server.id))).map((f) => f.name)).toEqual(["Stay"])
  })
})
