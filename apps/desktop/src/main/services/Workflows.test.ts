import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { DOCUMENT_MAX, DOCUMENT_VERSIONS_MAX, NODES_MAX } from "@robot/shared"
import { Effect, Exit } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Database } from "./Database.ts"
import { Rules } from "./Rules.ts"
import { Servers } from "./Servers.ts"
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
