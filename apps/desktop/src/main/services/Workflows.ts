import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  type CheckOutcome,
  changesBackup,
  charLength,
  checkGraphKey,
  checkStateOf,
  DEFAULT_PERMISSION,
  DOCUMENT_MAX,
  DOCUMENT_VERSIONS_MAX,
  type DocumentSource,
  type DocumentVersion,
  type GraphVersion,
  isLooser,
  isRuntimeKind,
  type ModelPick,
  NODES_MAX,
  type NodeInput,
  type NodePatch,
  nameKey,
  OPTIONS_MIN,
  type PermissionLevel,
  programName,
  redactSecrets,
  resolveLocale,
  sameModelChoice,
  THRESHOLD_DEFAULT,
  translate,
  type VersionSource,
  type Workflow,
  type WorkflowConnection,
  type WorkflowCreate,
  type WorkflowDetail,
  type WorkflowGraph,
  type WorkflowNode,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Browsers } from "./Browsers.ts"
import { Database, type DatabaseService } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { SettingsStore } from "./Settings.ts"
import { sharingWorkflows } from "./sharedFolders.ts"

export type { GraphVersion, NodeInput, NodePatch }

/**
 * The programs of the text nodes of a workflow that take no part in file claims (spec 025,
 * "Rules"): a vendor runtime runs its own file steps, and the app cannot see or refuse them. One
 * name for each program, in order of first use.
 */
const claimlessPrograms = (db: DatabaseService, workflowId: string): readonly string[] => {
  const names: string[] = []
  for (const row of db.all<{ kind: string }>(
    `SELECT a.kind FROM workflow_node n JOIN provider_account a ON a.id = n.account_id
     WHERE n.workflow_id = ? AND n.kind = 'text' ORDER BY n.number`,
    workflowId,
  )) {
    if (!isRuntimeKind(row.kind)) continue
    const name = programName(row.kind)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

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
  readonly updateNode: (
    nodeId: string,
    patch: NodePatch,
    source?: VersionSource,
  ) => Effect.Effect<WorkflowNode, AppError>
  readonly removeNode: (nodeId: string) => Effect.Effect<void, AppError>
  /**
   * Moves a node on the canvas. A move is not a change of the graph: it keeps no version, and the
   * number of the node stays (spec 010).
   */
  readonly moveNode: (nodeId: string, x: number, y: number) => Effect.Effect<void, AppError>
  /** Adds an option to a decision node. The option has no connection yet. */
  readonly addOption: (nodeId: string, label: string) => Effect.Effect<WorkflowNode, AppError>
  readonly renameOption: (optionId: string, label: string) => Effect.Effect<WorkflowNode, AppError>
  /** Removes an option with its connection. A decision node keeps at least two options. */
  readonly removeOption: (optionId: string) => Effect.Effect<WorkflowNode, AppError>
  readonly connect: (
    workflowId: string,
    from: string,
    to: string,
    optionId?: string | null,
  ) => Effect.Effect<WorkflowConnection, AppError>
  readonly disconnect: (connectionId: string) => Effect.Effect<void, AppError>
  /**
   * Replaces the graph with another one: the change of an accepted graph proposal, and the undo of
   * one (spec 002, "Self-improvement"). The graph as it is now is kept as a version, and its id is
   * returned. A node that stays keeps its id, so the tasks of the node keep their node.
   */
  readonly applyGraph: (
    id: string,
    graph: WorkflowGraph,
    source: VersionSource,
    /** The linked device that asked for the change: "Last changed by <device>" (spec 012). */
    device?: string | null,
  ) => Effect.Effect<{ versionId: string }, AppError>
  /** Changes the prompt of one node and keeps the graph as it was as a version (spec 002). */
  readonly applyPrompt: (
    nodeId: string,
    prompt: string,
    source: VersionSource,
  ) => Effect.Effect<{ versionId: string }, AppError>
  /** The switch "Self-improvement" of a workflow. Only the user sets it (spec 002). */
  readonly setSelfImprovement: (id: string, enabled: boolean) => Effect.Effect<Workflow, AppError>
  /** The versions of the graph, newest first (spec 010, "Flows", item 4). */
  readonly versions: (id: string) => Effect.Effect<readonly GraphVersion[], AppError>
  /** Restores a version. The graph as it is now is kept as a version too. */
  readonly restoreVersion: (
    id: string,
    versionId: string,
    /**
     * A linked device restores a graph: the backup models of the nodes stay as they are now, and a
     * node that is back from the version gets none. Only the user at this computer changes a
     * backup model (spec 006; docs/spec-questions.md, B6).
     */
    options?: { readonly keepBackups?: boolean },
  ) => Effect.Effect<WorkflowGraph, AppError>
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
  backup_account_id: string | null
  backup_model: string | null
  backup_effort: string | null
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

/**
 * The result of the check that was stored for this graph, or null. A result of another graph is not
 * valid (see `checkGraphKey`).
 */
export const readStoredCheck = (
  db: DatabaseService,
  workflowId: string,
  graph: WorkflowGraph,
): CheckOutcome | null => {
  const row = db.get<{ graph_key: string; outcome: string }>(
    "SELECT graph_key, outcome FROM workflow_check WHERE workflow_id = ?",
    workflowId,
  )
  if (!row || row.graph_key !== checkGraphKey(graph)) return null
  try {
    return JSON.parse(row.outcome) as CheckOutcome
  } catch {
    return null
  }
}

/**
 * A graph that a version kept, read again. A version from before the backup model has no `backup`
 * on its nodes: they have none (spec 006).
 */
const versionGraph = (json: string): WorkflowGraph => {
  const graph = JSON.parse(json) as WorkflowGraph
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n, backup: n.backup ?? null })),
  }
}

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
        backup:
          r.backup_account_id !== null && r.backup_model !== null
            ? { accountId: r.backup_account_id, model: r.backup_model, effort: r.backup_effort }
            : null,
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
      const browsers = yield* Browsers

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
      const toWorkflow = (r: WorkflowRow, graph = readGraph(db, r.id)): Workflow => {
        const last = db.get<{ state: string; started_at: number }>(
          "SELECT state, started_at FROM run WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
          r.id,
        )
        return {
          id: r.id,
          serverId: r.server_id,
          name: r.name,
          folder: r.folder,
          permission: r.permission,
          selfImprovement: r.self_improvement === 1,
          proposals:
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM proposal WHERE workflow_id = ? AND state = 'waiting'",
              r.id,
            )?.n ?? 0,
          nodeCount: nodeCount(r.id),
          running: checkIdle(r.id) !== null,
          working:
            db.get(
              "SELECT 1 FROM run WHERE workflow_id = ? AND finished_at IS NULL AND state = 'running'",
              r.id,
            ) !== undefined,
          lastRun: last ? { state: last.state, startedAt: last.started_at } : null,
          check: checkStateOf(readStoredCheck(db, r.id, graph)),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }
      }
      const detail = (r: WorkflowRow): WorkflowDetail => {
        const graph = readGraph(db, r.id)
        const sharedWith = sharingWorkflows(db, r.id).map((w) => w.name)
        return {
          ...toWorkflow(r, graph),
          document: r.document,
          graph,
          checkOutcome: readStoredCheck(db, r.id, graph),
          sharedWith,
          claimless: sharedWith.length === 0 ? [] : claimlessPrograms(db, r.id),
        }
      }
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
      const keepVersion = (
        workflowId: string,
        source: VersionSource,
        device: string | null = null,
      ): string => {
        const id = randomUUID()
        db.run(
          "INSERT INTO workflow_version (id, workflow_id, graph, source, device, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          workflowId,
          JSON.stringify(readGraph(db, workflowId)),
          source,
          device,
          Date.now(),
        )
        return id
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

      /** A decision node uses no model, no reasoning level and no tools (spec 010). */
      const checkDecisionFields = (patch: {
        accountId?: string | null
        model?: string | null
        effort?: string | null
        backup?: ModelPick | null
        permission?: PermissionLevel | null
      }) => {
        if (patch.effort !== undefined && patch.effort !== null)
          return new AppError({ code: "decision_effort", detail: "effort" })
        // A decision node names the decision model, so it keeps it and gets no backup (spec 006).
        if (patch.backup !== undefined && patch.backup !== null)
          return new AppError({ code: "decision_backup", detail: "backup" })
        if (
          (patch.accountId !== undefined && patch.accountId !== null) ||
          (patch.model !== undefined && patch.model !== null)
        )
          return new AppError({ code: "decision_model", detail: "model" })
        if (patch.permission !== undefined && patch.permission !== null)
          return new AppError({ code: "decision_permission", detail: "permission" })
        return null
      }

      /** True when a text node of the graph holds a level that is looser than the given level. */
      const loosestNode = (
        nodes: readonly { kind: string; permission: PermissionLevel | null }[],
        level: PermissionLevel,
      ) =>
        nodes.some(
          (n) => n.kind === "text" && n.permission !== null && isLooser(n.permission, level),
        )

      const create = (input: WorkflowCreate) =>
        Effect.gen(function* () {
          if (!db.get("SELECT 1 FROM server WHERE id = ?", input.serverId))
            return yield* new AppError({ code: "server_not_found" })
          const name = input.name.trim()
          const problem = checkName(input.serverId, name)
          if (problem) return yield* problem
          // A new workflow gets a short default text in the language of the interface (spec 002
          // and 010, "New workflow"). A text that the caller gives stays as it is, also empty.
          const { language } = yield* settings.get
          const document =
            input.document ??
            translate(
              resolveLocale(language, platform.systemLocale()),
              "workflows.document.default",
            )
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

      /**
       * Writes a whole graph in place of the one that the workflow has: keeps the graph as it is now
       * as a version, and returns the id of that version. A node that comes back keeps the tasks of
       * its id (deleting a node sets the node of its tasks to NULL).
       */
      const writeGraph = (
        row: WorkflowRow,
        graph: WorkflowGraph,
        source: VersionSource,
        device: string | null = null,
      ): string => {
        const id = row.id
        let versionId = ""
        db.transaction(() => {
          versionId = keepVersion(id, source, device)
          const links = db.all<{ id: string; node_id: string }>(
            "SELECT id, node_id FROM task WHERE workflow_id = ? AND node_id IS NOT NULL",
            id,
          )
          db.run("DELETE FROM workflow_node WHERE workflow_id = ?", id)
          for (const n of graph.nodes) {
            db.run(
              `INSERT INTO workflow_node (id, workflow_id, number, kind, name, prompt, account_id, model, effort,
                 backup_account_id, backup_model, backup_effort,
                 permission, continue_on_failure, question, threshold, x, y)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              n.id,
              id,
              n.number,
              n.kind,
              n.name,
              n.prompt,
              n.accountId,
              n.model,
              n.effort,
              // A decision node has no backup model (spec 006). A version from before the field
              // has no `backup`.
              n.kind === "text" ? (n.backup?.accountId ?? null) : null,
              n.kind === "text" ? (n.backup?.model ?? null) : null,
              n.kind === "text" ? (n.backup?.effort ?? null) : null,
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
          const back = new Set(graph.nodes.map((n) => n.id))
          for (const link of links)
            if (back.has(link.node_id))
              db.run("UPDATE task SET node_id = ? WHERE id = ?", link.node_id, link.id)
          touch(id)
        })
        changed(row.server_id)
        return versionId
      }

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
                "SELECT * FROM workflow WHERE server_id = ? ORDER BY name_key, rowid",
                serverId,
              )
              .map((r) => toWorkflow(r)),
          ),
        get: (id) => findRow(id).pipe(Effect.map(detail)),
        create,
        rename: (id, name) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            const busy = checkIdle(id)
            if (busy) return yield* busy
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
            // A workflow that runs is not deleted: the cascade would remove its run rows.
            const busy = checkIdle(id)
            if (busy) return yield* busy
            // Every table of the workflow holds a foreign key with ON DELETE CASCADE, but the holds
            // of the main models have none on purpose (spec 006): they leave with the workflow.
            db.transaction(() => {
              db.run(
                "DELETE FROM model_hold WHERE node_id IN (SELECT id FROM workflow_node WHERE workflow_id = ?)",
                id,
              )
              db.run("DELETE FROM workflow WHERE id = ?", id)
            })
            // The browser of a deleted workflow closes at once (spec 007, "Idle work").
            browsers.forget(id)
            changed(row.server_id)
            // The workflow left the list of every connection (spec 018, "Rules"): the page of
            // connections reads its rows again.
            bus.emit("connections.changed", {})
          }),
        setPermission: (id, level) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            const busy = checkIdle(id)
            if (busy) return yield* busy
            // Spec 010 says a node is never looser than its workflow, and does not say what a
            // tighter workflow does to a looser node. The app refuses and names no node.
            if (loosestNode(readGraph(db, id).nodes, level))
              return yield* new AppError({
                code: "workflow_permission_nodes",
                detail: "permission",
              })
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
            const busy = checkIdle(id)
            if (busy) return yield* busy
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
            if (input.kind === "decision") {
              const fields = checkDecisionFields(input)
              if (fields) return yield* fields
            }
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
        updateNode: (nodeId, patch, source = "editor") =>
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
            if (node.kind === "decision") {
              const fields = checkDecisionFields(patch)
              if (fields) return yield* fields
            }
            const pick = <T>(next: T | undefined, now: T) => (next === undefined ? now : next)
            // The backup model (spec 006, "Backup model"): the editor refuses the same account, model
            // and reasoning level as the main choice, and a backup on a node that has no main choice.
            const backupNow: ModelPick | null =
              node.backup_account_id !== null && node.backup_model !== null
                ? {
                    accountId: node.backup_account_id,
                    model: node.backup_model,
                    effort: node.backup_effort,
                  }
                : null
            const backupNext = pick(patch.backup, backupNow)
            if (backupNext !== null) {
              const mainAccount = pick(patch.accountId, node.account_id)
              const mainModel = pick(patch.model, node.model)
              if (mainAccount !== null && mainModel !== null) {
                if (
                  sameModelChoice(
                    {
                      accountId: mainAccount,
                      model: mainModel,
                      effort: pick(patch.effort, node.effort),
                    },
                    backupNext,
                  )
                )
                  return yield* new AppError({ code: "backup_same", detail: "backup" })
              } else if (patch.backup !== undefined)
                return yield* new AppError({ code: "backup_no_main", detail: "backup" })
            }
            db.transaction(() => {
              keepVersion(row.id, source)
              db.run(
                `UPDATE workflow_node SET name = ?, prompt = ?, account_id = ?, model = ?, effort = ?,
                   backup_account_id = ?, backup_model = ?, backup_effort = ?,
                   permission = ?, continue_on_failure = ?, question = ?, threshold = ?, x = ?, y = ?
                 WHERE id = ?`,
                pick(patch.name?.trim(), node.name),
                pick(patch.prompt, node.prompt),
                pick(patch.accountId, node.account_id),
                pick(patch.model, node.model),
                pick(patch.effort, node.effort),
                backupNext?.accountId ?? null,
                backupNext?.model ?? null,
                backupNext?.effort ?? null,
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
              db.run("DELETE FROM model_hold WHERE node_id = ?", nodeId)
              renumber(row.id)
              touch(row.id)
            })
            changed(row.server_id)
          }),
        moveNode: (nodeId, x, y) =>
          Effect.gen(function* () {
            const node = yield* nodeRow(nodeId)
            const row = yield* findRow(node.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            if (!Number.isFinite(x) || !Number.isFinite(y))
              return yield* new AppError({ code: "invalid_input" })
            db.run("UPDATE workflow_node SET x = ?, y = ? WHERE id = ?", x, y, nodeId)
            changed(row.server_id)
          }),
        addOption: (nodeId, label) =>
          Effect.gen(function* () {
            const node = yield* nodeRow(nodeId)
            const row = yield* findRow(node.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            if (node.kind !== "decision") return yield* new AppError({ code: "text_node_options" })
            if (label.trim() === "")
              return yield* new AppError({ code: "option_label_empty", detail: "options" })
            db.transaction(() => {
              keepVersion(row.id, "editor")
              const next =
                db.get<{ n: number }>(
                  "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM workflow_option WHERE node_id = ?",
                  nodeId,
                )?.n ?? 0
              db.run(
                "INSERT INTO workflow_option (id, node_id, position, label) VALUES (?, ?, ?, ?)",
                randomUUID(),
                nodeId,
                next,
                label.trim(),
              )
              touch(row.id)
            })
            changed(row.server_id)
            return nodeOf(nodeId)
          }),
        renameOption: (optionId, label) =>
          Effect.gen(function* () {
            const option = db.get<{ node_id: string }>(
              "SELECT node_id FROM workflow_option WHERE id = ?",
              optionId,
            )
            if (!option) return yield* new AppError({ code: "option_not_found" })
            const node = yield* nodeRow(option.node_id)
            const row = yield* findRow(node.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            if (label.trim() === "")
              return yield* new AppError({ code: "option_label_empty", detail: "options" })
            db.transaction(() => {
              keepVersion(row.id, "editor")
              db.run("UPDATE workflow_option SET label = ? WHERE id = ?", label.trim(), optionId)
              touch(row.id)
            })
            changed(row.server_id)
            return nodeOf(option.node_id)
          }),
        removeOption: (optionId) =>
          Effect.gen(function* () {
            const option = db.get<{ node_id: string }>(
              "SELECT node_id FROM workflow_option WHERE id = ?",
              optionId,
            )
            if (!option) return yield* new AppError({ code: "option_not_found" })
            const node = yield* nodeRow(option.node_id)
            const row = yield* findRow(node.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            const count =
              db.get<{ n: number }>(
                "SELECT COUNT(*) AS n FROM workflow_option WHERE node_id = ?",
                option.node_id,
              )?.n ?? 0
            if (count <= OPTIONS_MIN)
              return yield* new AppError({ code: "decision_options", detail: "options" })
            db.transaction(() => {
              keepVersion(row.id, "editor")
              // The connection of the option goes with it (ON DELETE CASCADE).
              db.run("DELETE FROM workflow_option WHERE id = ?", optionId)
              touch(row.id)
            })
            changed(row.server_id)
            return nodeOf(option.node_id)
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
            // Each option has one outgoing connection (spec 010), and the same line is not made twice.
            const taken = db.get(
              optionId === null
                ? "SELECT 1 FROM workflow_connection WHERE from_node_id = ? AND to_node_id = ? AND option_id IS NULL"
                : "SELECT 1 FROM workflow_connection WHERE option_id = ?",
              ...(optionId === null ? [from, to] : [optionId]),
            )
            if (taken) return yield* new AppError({ code: "connection_exists" })
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
                graph: versionGraph(r.graph),
              }))
          }),
        restoreVersion: (id, versionId, options) =>
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
            const kept = versionGraph(version.graph)
            const graph = options?.keepBackups
              ? (() => {
                  const now = new Map(readGraph(db, id).nodes.map((n) => [n.id, n.backup]))
                  return {
                    ...kept,
                    nodes: kept.nodes.map((n) => ({ ...n, backup: now.get(n.id) ?? null })),
                  }
                })()
              : kept
            // The workflow level may be stricter now than when the version was saved.
            if (loosestNode(graph.nodes, row.permission))
              return yield* new AppError({ code: "node_permission_looser", detail: "permission" })
            // A restore keeps the graph as it is now as a version (spec 010).
            writeGraph(row, graph, "restore")
            return readGraph(db, id)
          }),
        applyGraph: (id, graph, source, device) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            const busy = checkIdle(id)
            if (busy) return yield* busy
            if (loosestNode(graph.nodes, row.permission))
              return yield* new AppError({ code: "node_permission_looser", detail: "permission" })
            // A change of the whole graph, from a proposal or from the chat, never sets or moves a
            // backup model: it is a second account for the node, and only the user sets it, in the
            // editor (spec 006; docs/spec-questions.md, B6). This holds whatever the caller built.
            if (changesBackup(readGraph(db, id), graph) !== null)
              return yield* new AppError({ code: "backup_change_refused", detail: "backup" })
            return { versionId: writeGraph(row, graph, source, device ?? null) }
          }),
        applyPrompt: (nodeId, prompt, source) =>
          Effect.gen(function* () {
            const node = yield* nodeRow(nodeId)
            const row = yield* findRow(node.workflow_id)
            const busy = checkIdle(row.id)
            if (busy) return yield* busy
            let versionId = ""
            db.transaction(() => {
              versionId = keepVersion(row.id, source)
              db.run("UPDATE workflow_node SET prompt = ? WHERE id = ?", prompt, nodeId)
              touch(row.id)
            })
            changed(row.server_id)
            return { versionId }
          }),
        setSelfImprovement: (id, enabled) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            db.run(
              "UPDATE workflow SET self_improvement = ?, updated_at = ? WHERE id = ?",
              enabled ? 1 : 0,
              Date.now(),
              id,
            )
            changed(row.server_id)
            bus.emit("proposals.changed", { workflowId: id })
            return toWorkflow(yield* findRow(id))
          }),
      })
    }),
  )
}
