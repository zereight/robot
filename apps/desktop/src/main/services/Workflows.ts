import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  charLength,
  DEFAULT_PERMISSION,
  DOCUMENT_MAX,
  DOCUMENT_VERSIONS_MAX,
  type DocumentSource,
  type DocumentVersion,
  isLooser,
  NODES_MAX,
  nameKey,
  OPTIONS_MIN,
  type PermissionLevel,
  redactSecrets,
  THRESHOLD_DEFAULT,
  type VersionSource,
  type Workflow,
  type WorkflowConnection,
  type WorkflowCreate,
  type WorkflowDetail,
  type WorkflowGraph,
  type WorkflowNode,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database, type DatabaseService } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { SettingsStore } from "./Settings.ts"

/** A node to add (spec 010). A decision node needs at least two options. */
export interface NodeInput {
  readonly kind: "text" | "decision"
  readonly name: string
  readonly prompt?: string
  readonly accountId?: string | null
  readonly model?: string | null
  readonly effort?: string | null
  readonly permission?: PermissionLevel | null
  readonly continueOnFailure?: boolean
  readonly question?: string
  readonly threshold?: number
  /** The labels of the options of a decision node. */
  readonly options?: readonly string[]
  readonly x?: number
  readonly y?: number
}

/** A change of a node. A field that is left out stays as it was. */
export type NodePatch = Partial<Omit<NodeInput, "kind" | "options">>

export interface WorkflowsService {
  readonly list: (serverId: string) => Effect.Effect<readonly Workflow[]>
  readonly get: (id: string) => Effect.Effect<WorkflowDetail, AppError>
  /**
   * Makes a workflow with a responsible document (spec 010, "New workflow") and an empty folder in
   * the default workspace folder (spec 010, "Folder and permission level").
   */
  readonly create: (input: WorkflowCreate) => Effect.Effect<Workflow, AppError>
  readonly rename: (id: string, name: string) => Effect.Effect<Workflow, AppError>
  /** Deletes the workflow with its graph, versions, document history, chat, runs and memory. */
  readonly remove: (id: string) => Effect.Effect<void, AppError>
  /** Only the user changes the folder and the permission level of a workflow (spec 010). */
  readonly setPermission: (id: string, level: PermissionLevel) => Effect.Effect<Workflow, AppError>
  readonly setFolder: (id: string, folder: string) => Effect.Effect<Workflow, AppError>
  readonly saveDocument: (
    id: string,
    text: string,
    source?: DocumentSource,
    device?: string,
  ) => Effect.Effect<WorkflowDetail, AppError>
  readonly documentHistory: (id: string) => Effect.Effect<readonly DocumentVersion[], AppError>
  readonly restoreDocument: (
    id: string,
    versionId: string,
  ) => Effect.Effect<WorkflowDetail, AppError>
  /** The nodes and connections of the graph, in the order of the numbers of the nodes. */
  readonly graph: (id: string) => Effect.Effect<WorkflowGraph, AppError>
  readonly addNode: (workflowId: string, input: NodeInput) => Effect.Effect<WorkflowNode, AppError>
  readonly updateNode: (nodeId: string, patch: NodePatch) => Effect.Effect<WorkflowNode, AppError>
  readonly removeNode: (nodeId: string) => Effect.Effect<void, AppError>
  readonly connect: (
    workflowId: string,
    from: string,
    to: string,
    optionId?: string | null,
  ) => Effect.Effect<WorkflowConnection, AppError>
  readonly disconnect: (connectionId: string) => Effect.Effect<void, AppError>
  /** The versions of the graph, newest first (spec 010, "Flows", item 4). */
  readonly versions: (id: string) => Effect.Effect<readonly GraphVersion[], AppError>
  /** Restores a version. The graph as it is now is kept as a version too. */
  readonly restoreVersion: (id: string, versionId: string) => Effect.Effect<WorkflowGraph, AppError>
}

export interface GraphVersion {
  readonly id: string
  readonly source: VersionSource
  readonly createdAt: number
  readonly graph: WorkflowGraph
}

interface WorkflowRow {
  id: string
  server_id: string
  name: string
  name_key: string
  document: string
  folder: string
  permission: PermissionLevel
  self_improvement: number
  created_at: number
  updated_at: number
}

interface NodeRow {
  id: string
  workflow_id: string
  number: number
  kind: "text" | "decision"
  name: string
  prompt: string
  account_id: string | null
  model: string | null
  effort: string | null
  permission: PermissionLevel | null
  continue_on_failure: number
  question: string
  threshold: number
  x: number
  y: number
}

interface OptionRow {
  id: string
  node_id: string
  position: number
  label: string
}

interface ConnectionRow {
  id: string
  from_node_id: string
  to_node_id: string
  option_id: string | null
}

/** A folder name made from the workflow name, with a short unique tail. */
export const workflowFolderName = (name: string, id: string) => {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return `${slug || "workflow"}-${id.slice(0, 6)}`
}

/** The stricter of two levels. The level of a node never loosens the level of its workflow. */
export const effectivePermission = (
  workflow: PermissionLevel,
  node: PermissionLevel | null,
): PermissionLevel => (node === null || isLooser(node, workflow) ? workflow : node)

/** The graph of a workflow, read from the tables. */
export const readGraph = (db: DatabaseService, workflowId: string): WorkflowGraph => {
  const options = db.all<OptionRow>(
    `SELECT o.* FROM workflow_option o JOIN workflow_node n ON n.id = o.node_id
     WHERE n.workflow_id = ? ORDER BY o.node_id, o.position`,
    workflowId,
  )
  const nodes = db
    .all<NodeRow>("SELECT * FROM workflow_node WHERE workflow_id = ? ORDER BY number", workflowId)
    .map(
      (r): WorkflowNode => ({
        id: r.id,
        number: r.number,
        kind: r.kind,
        name: r.name,
        prompt: r.prompt,
        accountId: r.account_id,
        model: r.model,
        effort: r.effort,
        permission: r.permission,
        continueOnFailure: r.continue_on_failure === 1,
        question: r.question,
        threshold: r.threshold,
        options: options
          .filter((o) => o.node_id === r.id)
          .map((o) => ({ id: o.id, label: o.label })),
        x: r.x,
        y: r.y,
      }),
    )
  const connections = db
    .all<ConnectionRow>(
      "SELECT * FROM workflow_connection WHERE workflow_id = ? ORDER BY rowid",
      workflowId,
    )
    .map((c) => ({ id: c.id, from: c.from_node_id, to: c.to_node_id, optionId: c.option_id }))
  return { nodes, connections }
}

export class Workflows extends Context.Service<Workflows, WorkflowsService>()(
  "robot/main/Workflows",
) {
  static readonly layer = Layer.effect(
    Workflows,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform
      const settings = yield* SettingsStore

      const findRow = (id: string) => {
        const row = db.get<WorkflowRow>("SELECT * FROM workflow WHERE id = ?", id)
        return row ? Effect.succeed(row) : Effect.fail(new AppError({ code: "workflow_not_found" }))
      }
      const nodeRow = (id: string) => {
        const row = db.get<NodeRow>("SELECT * FROM workflow_node WHERE id = ?", id)
        return row ? Effect.succeed(row) : Effect.fail(new AppError({ code: "node_not_found" }))
      }
      const changed = (serverId: string) => bus.emit("workflows.changed", { serverId })
      const nodeCount = (id: string) =>
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workflow_node WHERE workflow_id = ?", id)
          ?.n ?? 0
      const toWorkflow = (r: WorkflowRow): Workflow => ({
        id: r.id,
        serverId: r.server_id,
        name: r.name,
        folder: r.folder,
        permission: r.permission,
        selfImprovement: r.self_improvement === 1,
        nodeCount: nodeCount(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })
      const detail = (r: WorkflowRow): WorkflowDetail => ({
        ...toWorkflow(r),
        document: r.document,
        graph: readGraph(db, r.id),
      })
      const nameTaken = (serverId: string, name: string, exceptId?: string) =>
        db.get(
          "SELECT 1 FROM workflow WHERE server_id = ? AND name_key = ? AND id != ?",
          serverId,
          nameKey(name),
          exceptId ?? "",
        ) !== undefined
      const checkName = (serverId: string, name: string, exceptId?: string) => {
        if (name.trim() === "") return new AppError({ code: "workflow_name_empty", detail: "name" })
        if (nameTaken(serverId, name, exceptId))
          return new AppError({ code: "workflow_name_taken", detail: "name" })
        return null
      }
      /** The editor is read-only while a run works or waits (spec 010, "Rules"). */
      const checkIdle = (workflowId: string) =>
        db.get("SELECT 1 FROM run WHERE workflow_id = ? AND finished_at IS NULL", workflowId)
          ? new AppError({ code: "workflow_running" })
          : null

      /** Keeps the graph as it is now as a version, before a change (spec 010). */
      const keepVersion = (workflowId: string, source: VersionSource) => {
        db.run(
          "INSERT INTO workflow_version (id, workflow_id, graph, source, created_at) VALUES (?, ?, ?, ?, ?)",
          randomUUID(),
          workflowId,
          JSON.stringify(readGraph(db, workflowId)),
          source,
          Date.now(),
        )
      }
      const touch = (workflowId: string) =>
        db.run("UPDATE workflow SET updated_at = ? WHERE id = ?", Date.now(), workflowId)

      /** Renumbers the nodes of a workflow, from 1, in the order of their numbers. */
      const renumber = (workflowId: string) => {
        const rows = db.all<{ id: string }>(
          "SELECT id FROM workflow_node WHERE workflow_id = ? ORDER BY number, rowid",
          workflowId,
        )
        rows.forEach((r, i) => {
          db.run("UPDATE workflow_node SET number = ? WHERE id = ?", i + 1, r.id)
        })
      }

      const checkLevel = (workflow: WorkflowRow, level: PermissionLevel | null | undefined) =>
        level !== null && level !== undefined && isLooser(level, workflow.permission)
          ? new AppError({ code: "node_permission_looser", detail: "permission" })
          : null

      const create = (input: WorkflowCreate) =>
        Effect.gen(function* () {
          if (!db.get("SELECT 1 FROM server WHERE id = ?", input.serverId))
            return yield* new AppError({ code: "server_not_found" })
          const name = input.name.trim()
          const problem = checkName(input.serverId, name)
          if (problem) return yield* problem
          const document = input.document ?? ""
          if (charLength(document) > DOCUMENT_MAX)
            return yield* new AppError({ code: "document_too_long", detail: "document" })
          const id = randomUUID()
          const root = (yield* settings.get).workspaceRoot || platform.defaultWorkspaceRoot
          const folder = join(root, workflowFolderName(name, id))
          yield* Effect.try({
            try: () => mkdirSync(folder, { recursive: true }),
            catch: (e) => new AppError({ code: "workspace_failed", detail: String(e) }),
          })
          const now = Date.now()
          db.run(
            `INSERT INTO workflow (id, server_id, name, name_key, document, folder, permission, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            input.serverId,
            name,
            nameKey(name),
            document,
            folder,
            DEFAULT_PERMISSION,
            now,
            now,
          )
          changed(input.serverId)
          return toWorkflow(yield* findRow(id))
        })

      const writeDocument = (
        row: WorkflowRow,
        text: string,
        source: DocumentSource,
        device?: string,
      ) => {
        // Each change keeps the old text as a version. The oldest of more than 50 goes first.
        db.transaction(() => {
          db.run(
            "INSERT INTO document_version (id, workflow_id, text, source, device, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            randomUUID(),
            row.id,
            row.document,
            source,
            device ?? null,
            Date.now(),
          )
          db.run(
            `DELETE FROM document_version WHERE workflow_id = ? AND id NOT IN (
               SELECT id FROM document_version WHERE workflow_id = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
            row.id,
            row.id,
            DOCUMENT_VERSIONS_MAX,
          )
          db.run(
            "UPDATE workflow SET document = ?, updated_at = ? WHERE id = ?",
            text,
            Date.now(),
            row.id,
          )
        })
        changed(row.server_id)
      }

      const saveDocument = (id: string, text: string, source: DocumentSource, device?: string) =>
        Effect.gen(function* () {
          const row = yield* findRow(id)
          if (charLength(text) > DOCUMENT_MAX)
            return yield* new AppError({ code: "document_too_long", detail: "document" })
          // Text that looks like a secret is refused (spec 002, "Text of a secret").
          if (redactSecrets(text) !== text)
            return yield* new AppError({ code: "document_secret", detail: "document" })
          const busy = checkIdle(id)
          if (busy) return yield* busy
          if (text !== row.document) writeDocument(row, text, source, device)
          return detail(yield* findRow(id))
        })

      const nodeOf = (id: string): WorkflowNode =>
        readGraph(
          db,
          (
            db.get<{ workflow_id: string }>(
              "SELECT workflow_id FROM workflow_node WHERE id = ?",
              id,
            ) as { workflow_id: string }
          ).workflow_id,
        ).nodes.find((n) => n.id === id) as WorkflowNode

      return Workflows.of({
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<WorkflowRow>(
                "SELECT * FROM workflow WHERE server_id = ? ORDER BY created_at, rowid",
                serverId,
              )
              .map(toWorkflow),
          ),
        get: (id) => findRow(id).pipe(Effect.map(detail)),
        create,
        rename: (id, name) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            const trimmed = name.trim()
            const problem = checkName(row.server_id, trimmed, id)
            if (problem) return yield* problem
            db.run(
              "UPDATE workflow SET name = ?, name_key = ?, updated_at = ? WHERE id = ?",
              trimmed,
              nameKey(trimmed),
              Date.now(),
              id,
            )
            changed(row.server_id)
            return toWorkflow(yield* findRow(id))
          }),
        remove: (id) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            // Every table of the workflow holds a foreign key with ON DELETE CASCADE.
            db.run("DELETE FROM workflow WHERE id = ?", id)
            changed(row.server_id)
          }),
        setPermission: (id, level) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            db.run(
              "UPDATE workflow SET permission = ?, updated_at = ? WHERE id = ?",
              level,
              Date.now(),
              id,
            )
            changed(row.server_id)
            return toWorkflow(yield* findRow(id))
          }),
        setFolder: (id, folder) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            if (folder.trim() === "")
              return yield* new AppError({ code: "workflow_folder_empty", detail: "folder" })
            db.run(
              "UPDATE workflow SET folder = ?, updated_at = ? WHERE id = ?",
              folder,
              Date.now(),
              id,
            )
            changed(row.server_id)
            return toWorkflow(yield* findRow(id))
          }),
        saveDocument: (id, text, source = "editor", device) =>
          saveDocument(id, text, source, device),
        documentHistory: (id) =>
          Effect.gen(function* () {
            yield* findRow(id)
            return db
              .all<{
                id: string
                text: string
                source: DocumentSource
                device: string | null
                created_at: number
              }>(
                "SELECT * FROM document_version WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC",
                id,
              )
              .map((r) => ({
                id: r.id,
                text: r.text,
                source: r.source,
                device: r.device,
                createdAt: r.created_at,
              }))
          }),
        restoreDocument: (id, versionId) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            const version = db.get<{ text: string }>(
              "SELECT text FROM document_version WHERE id = ? AND workflow_id = ?",
              versionId,
              id,
            )
            if (!version) return yield* new AppError({ code: "version_not_found" })
            const busy = checkIdle(id)
            if (busy) return yield* busy
            // A restore makes a new version. It does not delete the versions after it (spec 002).
            if (version.text !== row.document) writeDocument(row, version.text, "restore")
            return detail(yield* findRow(id))
          }),
        graph: (id) =>
          Effect.gen(function* () {
            const r = yield* findRow(id)
            return readGraph(db, r.id)
          }),
        addNode: (workflowId, input) =>
          Effect.gen(function* () {
            const row = yield* findRow(workflowId)
            const busy = checkIdle(workflowId)
            if (busy) return yield* busy
            if (nodeCount(workflowId) >= NODES_MAX)
              return yield* new AppError({ code: "workflow_nodes_full" })
            if (input.name.trim() === "")
              return yield* new AppError({ code: "node_name_empty", detail: "name" })
            const level = checkLevel(row, input.permission)
            if (level) return yield* level
            const options = input.options ?? []
            if (input.kind === "decision" && options.length < OPTIONS_MIN)
              return yield* new AppError({ code: "decision_options", detail: "options" })
            if (input.kind === "text" && options.length > 0)
              return yield* new AppError({ code: "text_node_options", detail: "options" })
            const threshold = input.threshold ?? THRESHOLD_DEFAULT
            if (!(threshold >= 0 && threshold <= 1))
              return yield* new AppError({ code: "decision_threshold", detail: "threshold" })
            const id = randomUUID()
            db.transaction(() => {
              keepVersion(workflowId, "editor")
              db.run(
                `INSERT INTO workflow_node (id, workflow_id, number, kind, name, prompt, account_id, model, effort,
                   permission, continue_on_failure, question, threshold, x, y)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                id,
                workflowId,
                nodeCount(workflowId) + 1,
                input.kind,
                input.name.trim(),
                input.prompt ?? "",
                input.accountId ?? null,
                input.model ?? null,
                input.effort ?? null,
                input.permission ?? null,
                input.continueOnFailure ? 1 : 0,
                input.question ?? "",
                threshold,
                input.x ?? 0,
                input.y ?? 0,
              )
              options.forEach((label, i) => {
                db.run(
                  "INSERT INTO workflow_option (id, node_id, position, label) VALUES (?, ?, ?, ?)",
                  randomUUID(),
                  id,
                  i,
                  label,
                )
              })
              touch(workflowId)
            })
            changed(row.server_id)
            return nodeOf(id)
          }),
        updateNode: (nodeId, patch) =>
          Effect.gen(function* () {
            const node = yield* nodeRow(nodeId)
            const row = yield* findRow(node.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            if (patch.name !== undefined && patch.name.trim() === "")
              return yield* new AppError({ code: "node_name_empty", detail: "name" })
            const level = checkLevel(row, patch.permission)
            if (level) return yield* level
            if (patch.threshold !== undefined && !(patch.threshold >= 0 && patch.threshold <= 1))
              return yield* new AppError({ code: "decision_threshold", detail: "threshold" })
            // A decision node has no reasoning level and no tools (spec 010).
            if (node.kind === "decision" && patch.effort !== undefined && patch.effort !== null)
              return yield* new AppError({ code: "decision_effort", detail: "effort" })
            const pick = <T>(next: T | undefined, now: T) => (next === undefined ? now : next)
            db.transaction(() => {
              keepVersion(row.id, "editor")
              db.run(
                `UPDATE workflow_node SET name = ?, prompt = ?, account_id = ?, model = ?, effort = ?,
                   permission = ?, continue_on_failure = ?, question = ?, threshold = ?, x = ?, y = ?
                 WHERE id = ?`,
                pick(patch.name?.trim(), node.name),
                pick(patch.prompt, node.prompt),
                pick(patch.accountId, node.account_id),
                pick(patch.model, node.model),
                pick(patch.effort, node.effort),
                pick(patch.permission, node.permission),
                patch.continueOnFailure === undefined
                  ? node.continue_on_failure
                  : patch.continueOnFailure
                    ? 1
                    : 0,
                pick(patch.question, node.question),
                pick(patch.threshold, node.threshold),
                pick(patch.x, node.x),
                pick(patch.y, node.y),
                nodeId,
              )
              touch(row.id)
            })
            changed(row.server_id)
            return nodeOf(nodeId)
          }),
        removeNode: (nodeId) =>
          Effect.gen(function* () {
            const node = yield* nodeRow(nodeId)
            const row = yield* findRow(node.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            db.transaction(() => {
              keepVersion(row.id, "editor")
              // The connections and the options of the node go with it (ON DELETE CASCADE).
              db.run("DELETE FROM workflow_node WHERE id = ?", nodeId)
              renumber(row.id)
              touch(row.id)
            })
            changed(row.server_id)
          }),
        connect: (workflowId, from, to, optionId = null) =>
          Effect.gen(function* () {
            const row = yield* findRow(workflowId)
            const busy = checkIdle(workflowId)
            if (busy) return yield* busy
            const a = db.get<NodeRow>(
              "SELECT * FROM workflow_node WHERE id = ? AND workflow_id = ?",
              from,
              workflowId,
            )
            const b = db.get<NodeRow>(
              "SELECT * FROM workflow_node WHERE id = ? AND workflow_id = ?",
              to,
              workflowId,
            )
            if (!a || !b) return yield* new AppError({ code: "connection_node_missing" })
            if (from === to) return yield* new AppError({ code: "connection_to_self" })
            if (a.kind === "decision") {
              const option = optionId
                ? db.get(
                    "SELECT 1 FROM workflow_option WHERE id = ? AND node_id = ?",
                    optionId,
                    from,
                  )
                : undefined
              if (!option) return yield* new AppError({ code: "connection_option_missing" })
            } else if (optionId !== null) {
              return yield* new AppError({ code: "connection_option_unexpected" })
            }
            const id = randomUUID()
            db.transaction(() => {
              keepVersion(workflowId, "editor")
              db.run(
                "INSERT INTO workflow_connection (id, workflow_id, from_node_id, to_node_id, option_id) VALUES (?, ?, ?, ?, ?)",
                id,
                workflowId,
                from,
                to,
                optionId,
              )
              touch(workflowId)
            })
            changed(row.server_id)
            return { id, from, to, optionId }
          }),
        disconnect: (connectionId) =>
          Effect.gen(function* () {
            const c = db.get<{ workflow_id: string }>(
              "SELECT workflow_id FROM workflow_connection WHERE id = ?",
              connectionId,
            )
            if (!c) return yield* new AppError({ code: "connection_not_found" })
            const row = yield* findRow(c.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            db.transaction(() => {
              keepVersion(row.id, "editor")
              db.run("DELETE FROM workflow_connection WHERE id = ?", connectionId)
              touch(row.id)
            })
            changed(row.server_id)
          }),
        versions: (id) =>
          Effect.gen(function* () {
            yield* findRow(id)
            return db
              .all<{ id: string; graph: string; source: VersionSource; created_at: number }>(
                "SELECT * FROM workflow_version WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC",
                id,
              )
              .map((r) => ({
                id: r.id,
                source: r.source,
                createdAt: r.created_at,
                graph: JSON.parse(r.graph) as WorkflowGraph,
              }))
          }),
        restoreVersion: (id, versionId) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            const version = db.get<{ graph: string }>(
              "SELECT graph FROM workflow_version WHERE id = ? AND workflow_id = ?",
              versionId,
              id,
            )
            if (!version) return yield* new AppError({ code: "version_not_found" })
            const busy = checkIdle(id)
            if (busy) return yield* busy
            const graph = JSON.parse(version.graph) as WorkflowGraph
            db.transaction(() => {
              // A restore keeps the graph as it is now as a version (spec 010).
              keepVersion(id, "restore")
              db.run("DELETE FROM workflow_node WHERE workflow_id = ?", id)
              for (const n of graph.nodes) {
                db.run(
                  `INSERT INTO workflow_node (id, workflow_id, number, kind, name, prompt, account_id, model, effort,
                     permission, continue_on_failure, question, threshold, x, y)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  n.id,
                  id,
                  n.number,
                  n.kind,
                  n.name,
                  n.prompt,
                  n.accountId,
                  n.model,
                  n.effort,
                  n.permission,
                  n.continueOnFailure ? 1 : 0,
                  n.question,
                  n.threshold,
                  n.x,
                  n.y,
                )
                n.options.forEach((o, i) => {
                  db.run(
                    "INSERT INTO workflow_option (id, node_id, position, label) VALUES (?, ?, ?, ?)",
                    o.id,
                    n.id,
                    i,
                    o.label,
                  )
                })
              }
              for (const c of graph.connections) {
                db.run(
                  "INSERT INTO workflow_connection (id, workflow_id, from_node_id, to_node_id, option_id) VALUES (?, ?, ?, ?, ?)",
                  c.id,
                  id,
                  c.from,
                  c.to,
                  c.optionId,
                )
              }
              touch(id)
            })
            changed(row.server_id)
            return readGraph(db, id)
          }),
      })
    }),
  )
}
