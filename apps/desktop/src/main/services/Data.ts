import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  type ChatMessage,
  KNOWLEDGE_FOLDER,
  KNOWLEDGE_SOURCES,
  looksLikeSecret,
  REDACTED,
  RUNTIME_KINDS,
  redactSecrets,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { unzipSync } from "fflate"
import { Agents } from "./Agents.ts"
import { type ArchiveFile, writeZip } from "./archive.ts"
import { Connections } from "./Connections.ts"
import { repairChannelTree } from "./channelTreeRepair.ts"
import { Database } from "./Database.ts"
import { DECISION_KEY } from "./Decision.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { migrations } from "./migrations.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"

export interface DataService {
  /** Writes an archive to `target` without asking where. Sync uses it for its backups. */
  backup(target: string): Effect.Effect<{ path: string; files: number }, AppError>
  /** Writes one archive: the database, the attachments and a readme. Secrets are left out. */
  export(): Effect.Effect<{ path: string | null; files: number }, AppError>
  /** Restores an archive into an app that has no agents and no accounts yet. */
  import(): Effect.Effect<{ agents: number; messages: number } | null, AppError>
}

const FORMAT = 1
const SAFE_NAME = /^[^/\\]+$/

const README = `ROBot export

This archive holds the data of one ROBot app. It has no keys or tokens.

robot.db            The database (SQLite). Servers, agents with their instruction history,
                    the handbook with its history, chats, accounts and settings.
meta.json           The version of this format and of the database.
attachments/<id>/   Files that were attached to chats, one folder per agent id.
knowledge/<id>/     The articles of agent knowledge (Markdown files) and, in the folder
                    sources, the sources as they were kept. One folder per agent id.

Text that looks like a key or a token was replaced with [redacted] in the chats.
To restore it, choose Settings > Data > Import in an empty ROBot. Accounts come back
as "Not connected": sign in again to use them.
`

const utf8 = (text: string) => new TextEncoder().encode(text)

/** The names of the files in a folder. A missing folder counts as empty. */
const filesIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : []

/** The knowledge of one agent as files: articles at the top, sources in one folder. */
const knowledgeFiles = (workspace: string) => {
  const root = join(workspace, KNOWLEDGE_FOLDER)
  const out: { rel: string; data: Buffer; article: boolean }[] = []
  const read = (dir: string, prefix: string, article: boolean) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue
      if (article && !/\.md$/i.test(entry.name)) continue
      out.push({
        rel: `${prefix}${entry.name}`,
        data: readFileSync(join(dir, entry.name)),
        article,
      })
    }
  }
  read(root, "", true)
  read(join(root, KNOWLEDGE_SOURCES), `${KNOWLEDGE_SOURCES}/`, false)
  return out
}

/**
 * The entries of a connection (environment values or headers) with no secret value and no mark
 * that a value is saved. A value of the keychain stays on the computer that holds it.
 */
const forgetSecretValues = (text: string): string => {
  try {
    const entries = JSON.parse(text) as { name?: unknown; secret?: unknown; value?: unknown }[]
    if (!Array.isArray(entries)) return "[]"
    return JSON.stringify(
      entries.map((e) =>
        e.secret === true ? { name: e.name, secret: true, saved: false } : { ...e, saved: false },
      ),
    )
  } catch {
    return "[]"
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

export class Data extends Context.Service<Data, DataService>()("robot/main/Data") {
  static readonly layer = Layer.effect(
    Data,
    Effect.gen(function* () {
      const db = yield* Database
      const platform = yield* Platform
      const secrets = yield* Secrets
      const providers = yield* Providers
      const agents = yield* Agents
      const servers = yield* Servers
      const settings = yield* SettingsStore
      const savedSecrets = yield* SavedSecrets
      const connections = yield* Connections
      const bus = yield* EventBus

      const writeArchive = Effect.fn("Data.writeArchive")(function* (target: string) {
        const known = [
          ...(yield* providers.list)
            .map((a) => secrets.get(secretKey(a.id)))
            .filter((k): k is string => k !== null),
          // The key of the decision model (spec 013) is a stored key too.
          ...[secrets.get(DECISION_KEY)].filter((k): k is string => k !== null),
          // The values of saved secrets (spec 020) are hidden too, wherever a text holds one.
          ...savedSecrets.knownValues(),
          // So are the values of the secrets of connections (spec 018).
          ...connections.knownValues(),
        ]

        const work = mkdtempSync(join(tmpdir(), "robot-export-"))
        try {
          const copy = join(work, "robot.db")
          db.run("VACUUM INTO ?", copy)
          const out = new DatabaseSync(copy)
          try {
            // A page keeps the bytes of a value that was replaced, unless the file is rebuilt.
            // The copy is rebuilt after the keys are hidden (see below), so that no page holds one.
            out.exec("PRAGMA secure_delete = ON")
            // The index of message search holds a second copy of the text of the messages. The app
            // builds it again from the messages, so the archive does not carry it.
            for (const table of ["message", "channel_message"])
              for (const op of ["insert", "update", "delete"])
                out.exec(`DROP TRIGGER IF EXISTS ${table}_text_${op}`)
            out.exec("DROP TABLE IF EXISTS message_fts; DROP TABLE IF EXISTS message_text")
            // The links of this computer stay on it: an export holds no device keys or addresses.
            out.exec("DELETE FROM device_link")
            // Browser profiles and the choice of an agent stay too, as the browser data does.
            out.exec("DELETE FROM agent_browser; DELETE FROM browser_profile")
            // The Teams link and its sign-in belong to one computer and one profile (spec 028,
            // 014): an export holds none, so an import brings none back.
            out.exec("DELETE FROM teams_link; DELETE FROM teams_record")
            // The hold of the main model of an agent is a state of this computer (spec 006, 014).
            // The backup model itself is a setting of the agent and stays with it.
            out.exec("DELETE FROM model_hold")
            // A saved secret keeps its name, agent, origin and way to send, never its value or the
            // name of the value in the keychain of this computer (spec 020).
            out.exec("UPDATE saved_secret SET value_ref = NULL; DELETE FROM saved_secret_drop")
            // A connection keeps its settings and its plain values, never a secret value or the
            // mark that this computer holds one (spec 018, 014). It holds no reviewed tools either:
            // an import brings it back with none, so the user reviews its tools again (spec 018).
            out.exec("UPDATE tool_connection SET reviewed = '[]', review_adopt = 0")
            for (const row of out.prepare("SELECT id, env, headers FROM tool_connection").all() as {
              id: string
              env: string
              headers: string
            }[])
              out
                .prepare("UPDATE tool_connection SET env = ?, headers = ? WHERE id = ?")
                .run(forgetSecretValues(row.env), forgetSecretValues(row.headers), row.id)
            // Sync records belong to this pair of computers (spec 019). They are not exported.
            for (const table of [
              "sync_pair",
              "sync_item",
              "sync_field",
              "sync_tomb",
              "sync_out",
              "sync_dirty",
              "sync_seen",
              "sync_alias",
              "sync_change",
              "sync_state",
            ]) {
              out.exec(`DELETE FROM ${table}`)
            }
            out.exec(
              "UPDATE message SET origin = NULL; UPDATE channel_message SET origin = NULL; UPDATE task SET origin = NULL; UPDATE workflow_run SET origin = NULL; UPDATE routine SET runs_on = NULL; UPDATE workflow SET runs_on = NULL",
            )
            const rows = out.prepare("SELECT id, parts, error_detail FROM message").all() as {
              id: string
              parts: string
              error_detail: string | null
            }[]
            out
              .prepare("SELECT id, prompt, label FROM task")
              .all()
              .forEach((t) => {
                const task = t as { id: string; prompt: string; label: string }
                out
                  .prepare("UPDATE task SET prompt = ?, label = ? WHERE id = ?")
                  .run(redactSecrets(task.prompt, known), redactSecrets(task.label, known), task.id)
              })
            for (const row of out
              .prepare("SELECT id, parts, error_detail FROM channel_message")
              .all() as { id: string; parts: string; error_detail: string | null }[]) {
              out
                .prepare("UPDATE channel_message SET parts = ?, error_detail = ? WHERE id = ?")
                .run(
                  redactSecrets(row.parts, known),
                  row.error_detail === null ? null : redactSecrets(row.error_detail, known),
                  row.id,
                )
            }
            // The articles are text, so a key in them is hidden like a key in a chat. The hash
            // follows the hidden text, so that the restored files match their records.
            for (const row of out
              .prepare("SELECT agent_id, file, content FROM knowledge_file")
              .all() as {
              agent_id: string
              file: string
              content: string
            }[]) {
              const text = redactSecrets(row.content, known)
              out
                .prepare(
                  "UPDATE knowledge_file SET content = ?, hash = ? WHERE agent_id = ? AND file = ?",
                )
                .run(text, sha256(text), row.agent_id, row.file)
            }
            for (const row of out.prepare("SELECT id, earlier FROM knowledge_change").all() as {
              id: string
              earlier: string | null
            }[])
              if (row.earlier !== null)
                out
                  .prepare("UPDATE knowledge_change SET earlier = ? WHERE id = ?")
                  .run(redactSecrets(row.earlier, known), row.id)
            // The notes of a turn are memory items copied into the message, so a key in them is
            // hidden like a key in the memory.
            for (const row of out
              .prepare("SELECT id, context FROM message WHERE context IS NOT NULL")
              .all() as { id: string; context: string }[])
              out
                .prepare("UPDATE message SET context = ? WHERE id = ?")
                .run(redactSecrets(row.context, known), row.id)
            // The instruction history goes with its agent (spec 002), with keys hidden.
            for (const row of out.prepare("SELECT id, text FROM instruction_version").all() as {
              id: string
              text: string
            }[])
              out
                .prepare("UPDATE instruction_version SET text = ? WHERE id = ?")
                .run(redactSecrets(row.text, known), row.id)
            // The handbook and its history are text of the user (spec 002, 014), and so are the
            // instructions of a channel (spec 004): a key in them is hidden like a key in a chat.
            for (const row of out.prepare("SELECT id, text FROM handbook_version").all() as {
              id: string
              text: string
            }[]) {
              const text = redactSecrets(row.text, known)
              if (text !== row.text)
                out.prepare("UPDATE handbook_version SET text = ? WHERE id = ?").run(text, row.id)
            }
            for (const row of out
              .prepare("SELECT id, instructions FROM channel WHERE instructions <> ''")
              .all() as { id: string; instructions: string }[]) {
              const text = redactSecrets(row.instructions, known)
              if (text !== row.instructions)
                out.prepare("UPDATE channel SET instructions = ? WHERE id = ?").run(text, row.id)
            }
            // A rule keeps the text of a step, which can hold a key. The key is hidden like a key
            // in a chat; the restored rule then matches no step (spec 014).
            for (const row of out
              .prepare("SELECT id, match_text, detail FROM permission_rule")
              .all() as { id: string; match_text: string; detail: string | null }[]) {
              const text = redactSecrets(row.match_text, known)
              const detail = row.detail === null ? null : redactSecrets(row.detail, known)
              if (text !== row.match_text || detail !== row.detail)
                out
                  .prepare("UPDATE permission_rule SET match_text = ?, detail = ? WHERE id = ?")
                  .run(text, detail, row.id)
            }
            // A skill keeps its instructions, which can hold a key although its form says not to.
            // The key is hidden like a key in a chat (spec 014, 017).
            for (const row of out
              .prepare("SELECT id, description, instructions FROM skill")
              .all() as { id: string; description: string; instructions: string }[]) {
              const description = redactSecrets(row.description, known)
              const instructions = redactSecrets(row.instructions, known)
              if (description !== row.description || instructions !== row.instructions)
                out
                  .prepare("UPDATE skill SET description = ?, instructions = ? WHERE id = ?")
                  .run(description, instructions, row.id)
            }
            for (const row of out.prepare("SELECT id, text FROM memory").all() as {
              id: string
              text: string
            }[])
              out
                .prepare("UPDATE memory SET text = ? WHERE id = ?")
                .run(redactSecrets(row.text, known), row.id)
            // The proposals and the history of memory follow the same rule. A history row whose
            // text looks like a secret keeps no text, and the mark keeps its Undo off (spec 014).
            for (const row of out.prepare("SELECT id, text FROM memory_proposal").all() as {
              id: string
              text: string
            }[])
              out
                .prepare("UPDATE memory_proposal SET text = ? WHERE id = ?")
                .run(redactSecrets(row.text, known), row.id)
            for (const row of out
              .prepare("SELECT id, old_text, new_text FROM memory_history")
              .all() as { id: string; old_text: string | null; new_text: string | null }[]) {
              const secret = [row.old_text, row.new_text].some(
                (text) => text !== null && looksLikeSecret(text, known),
              )
              if (!secret) continue
              out
                .prepare(
                  "UPDATE memory_history SET old_text = ?, new_text = ?, hidden = 1 WHERE id = ?",
                )
                .run(
                  row.old_text === null ? null : REDACTED,
                  row.new_text === null ? null : REDACTED,
                  row.id,
                )
            }
            const update = out.prepare(
              "UPDATE message SET parts = ?, error_detail = ? WHERE id = ?",
            )
            for (const row of rows) {
              const parts = (JSON.parse(row.parts) as ChatMessage["parts"]).map((p) => {
                if (p.kind === "file") return p
                if (p.kind === "tool")
                  return {
                    ...p,
                    label: redactSecrets(p.label, known),
                    input: redactSecrets(p.input, known),
                    output: redactSecrets(p.output, known),
                    // A change from the chat can hold the old and the new instructions.
                    ...(p.settings
                      ? {
                          settings: {
                            ...p.settings,
                            changes: p.settings.changes.map((c) => ({
                              ...c,
                              before:
                                typeof c.before === "string"
                                  ? redactSecrets(c.before, known)
                                  : c.before,
                              after:
                                typeof c.after === "string"
                                  ? redactSecrets(c.after, known)
                                  : c.after,
                            })),
                          },
                        }
                      : {}),
                  }
                if (p.kind === "skill")
                  return { ...p, instructions: redactSecrets(p.instructions, known) }
                if (p.kind === "note") return p
                // The brief of a handover card was written with the keys hidden. It is hidden again
                // here, with the stored values of this export (spec 003, 014).
                if (p.kind === "handover") return { ...p, brief: redactSecrets(p.brief, known) }
                if (p.kind === "compacted")
                  return { ...p, summary: redactSecrets(p.summary, known) }
                return { ...p, text: redactSecrets(p.text, known) }
              })
              update.run(
                JSON.stringify(parts),
                row.error_detail === null ? null : redactSecrets(row.error_detail, known),
                row.id,
              )
            }
            // The pages of the first copy can hold the old text of a row, also in space that no
            // row uses. A rebuild writes only the rows as they are now.
            out.exec("VACUUM")
          } finally {
            out.close()
          }

          // The files are read from the disk one by one while the archive is written, so the data
          // of the user is never all in memory, and the main process is free for the chats.
          const entries: ArchiveFile[] = [
            { name: "README.txt", data: utf8(README) },
            {
              name: "meta.json",
              data: utf8(
                JSON.stringify({
                  format: FORMAT,
                  schema: migrations.length,
                  exportedAt: Date.now(),
                }),
              ),
            },
            { name: "robot.db", path: copy },
          ]
          let files = 0
          for (const server of yield* servers.list) {
            for (const archived of [false, true]) {
              for (const agent of yield* agents.list(server.id, archived)) {
                const dir = join(agent.workspace, "attachments")
                for (const name of filesIn(dir)) {
                  entries.push({ name: `attachments/${agent.id}/${name}`, path: join(dir, name) })
                  files++
                }
                // Articles are text and lose their keys. Sources are copied as they are.
                for (const file of knowledgeFiles(agent.workspace)) {
                  entries.push({
                    name: `knowledge/${agent.id}/${file.rel}`,
                    data: file.article
                      ? utf8(redactSecrets(file.data.toString("utf8"), known))
                      : file.data,
                  })
                  files++
                }
              }
            }
          }
          yield* Effect.promise(() => writeZip(target, entries))
          return { path: target, files }
        } finally {
          rmSync(work, { recursive: true, force: true })
        }
      })

      const exportData = Effect.fn("Data.export")(function* () {
        const stamp = new Date().toISOString().slice(0, 10)
        const target = yield* Effect.promise(() =>
          platform.pickSavePath(`ROBot-export-${stamp}.zip`),
        )
        if (!target) return { path: null, files: 0 }
        return yield* writeArchive(target)
      })

      const importData = Effect.fn("Data.restore")(function* () {
        const used =
          db.get("SELECT 1 AS x FROM agent LIMIT 1") ??
          db.get("SELECT 1 AS x FROM provider_account LIMIT 1")
        if (used) return yield* new AppError({ code: "import_not_empty" })
        const source = yield* Effect.promise(() => platform.pickArchive())
        if (!source) return null

        let entries: Record<string, Uint8Array>
        try {
          entries = unzipSync(readFileSync(source))
        } catch {
          return yield* new AppError({ code: "import_invalid" })
        }
        const dbFile = entries["robot.db"]
        const metaFile = entries["meta.json"]
        if (!dbFile || !metaFile) return yield* new AppError({ code: "import_invalid" })
        let meta: { format?: number; schema?: number }
        try {
          meta = JSON.parse(new TextDecoder().decode(metaFile))
        } catch {
          return yield* new AppError({ code: "import_invalid" })
        }
        if (meta.format !== FORMAT || meta.schema !== migrations.length)
          return yield* new AppError({ code: "import_version" })

        const local = yield* servers.local
        const defaultRoot = (yield* settings.get).workspaceRoot || platform.defaultWorkspaceRoot
        const work = mkdtempSync(join(tmpdir(), "robot-import-"))
        const copy = join(work, "robot.db")
        writeFileSync(copy, dbFile)
        let counts = { agents: 0, messages: 0 }
        try {
          // The archive is untrusted: it is read through SQL only, and only known tables are used.
          db.run("ATTACH DATABASE ? AS imp", copy)
          try {
            db.transaction(() => {
              // The imported agents move to this computer's server.
              const copyToServer = (table: string) => {
                const columns = db
                  .all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
                  .map((c) => c.name)
                db.run(
                  `INSERT INTO ${table} (${columns.join(", ")})
                   SELECT ${columns.map((c) => (c === "server_id" ? "?" : c)).join(", ")} FROM imp.${table}`,
                  local.id,
                )
              }
              // The sections come first: agents and channels point to them.
              copyToServer("place_section")
              copyToServer("agent")
              // The history of the instructions goes with its agent, and the handbook with its
              // history goes to this computer's server (spec 002, 014).
              db.run("INSERT INTO instruction_version SELECT * FROM imp.instruction_version")
              copyToServer("handbook_version")
              copyToServer("channel")
              copyToServer("routine")
              copyToServer("workflow")
              // Skills (spec 017) move to this computer's server too.
              copyToServer("skill")
              db.run("INSERT INTO workflow_run SELECT * FROM imp.workflow_run")
              db.run("INSERT INTO workflow_run_step SELECT * FROM imp.workflow_run_step")
              db.run("INSERT INTO routine_skip SELECT * FROM imp.routine_skip")
              db.run("INSERT INTO channel_member SELECT * FROM imp.channel_member")
              db.run("INSERT INTO channel_message SELECT * FROM imp.channel_message")
              // The archive is untrusted. A tree that breaks the rules (a loop, a fourth level) comes
              // back repaired, with one muted line in each channel that lost its parent (spec 030).
              repairChannelTree(db, { mode: "restore" })
              db.run("INSERT INTO provider_account SELECT * FROM imp.provider_account")
              // The models that the user turned off, and the fields of the custom models, come back
              // with their accounts (spec 006, 014).
              db.run(
                "INSERT INTO provider_model SELECT * FROM imp.provider_model WHERE account_id IN (SELECT id FROM imp.provider_account)",
              )
              // The sign-in of a vendor program belongs to the other computer. Connect again.
              const runtimeKinds = RUNTIME_KINDS.filter((kind) => /^[a-z_]+$/.test(kind))
                .map((kind) => `'${kind}'`)
                .join(", ")
              db.run(`UPDATE provider_account SET off = 1 WHERE kind IN (${runtimeKinds})`)
              // The threads come before the messages that point to them (spec 003, 014). A thread
              // holds its marks, so a handover comes back with the marks of its new thread.
              db.run("INSERT INTO thread SELECT * FROM imp.thread")
              db.run("INSERT INTO message SELECT * FROM imp.message")
              db.run("INSERT INTO memory SELECT * FROM imp.memory")
              db.run("INSERT INTO memory_proposal SELECT * FROM imp.memory_proposal")
              db.run("INSERT INTO memory_history SELECT * FROM imp.memory_history")
              db.run("INSERT INTO knowledge_file SELECT * FROM imp.knowledge_file")
              db.run("INSERT INTO knowledge_change SELECT * FROM imp.knowledge_change")
              // The rules come back with the agents that they name; a rule for all agents moves to
              // this computer's server (spec 014). A rule that this build cannot read stays.
              db.run(
                `INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
                 SELECT id, ?, agent_id, kind, match_text, detail, decision, source, created_at
                 FROM imp.permission_rule WHERE agent_id IS NULL OR agent_id IN (SELECT id FROM agent)`,
                local.id,
              )
              // Connections come back turned off, with no tools read, no reviewed tools and no secret
              // value (spec 018, 014): their tools are all held at the first start. The archive is
              // untrusted: the flags are made again here, and the review columns are not read at all.
              db.run(
                `INSERT INTO tool_connection
                   (id, server_id, name, name_key, kind, command, args, folder, env, address, headers,
                    agents, channels, enabled, state, failure, tools, tools_more, tools_off, created_at)
                 SELECT id, ?, name, name_key, kind, command, args, folder, env, address, headers,
                        agents, channels, 0, 'untested', NULL, '[]', 0, tools_off, created_at
                 FROM imp.tool_connection`,
                local.id,
              )
              for (const row of db.all<{ id: string; env: string; headers: string }>(
                "SELECT id, env, headers FROM tool_connection",
              ))
                db.run(
                  "UPDATE tool_connection SET env = ?, headers = ? WHERE id = ?",
                  forgetSecretValues(row.env),
                  forgetSecretValues(row.headers),
                  row.id,
                )
              // The log keeps the entries and the rules that decided them (spec 007, 014).
              db.run(`INSERT INTO action_log SELECT * FROM imp.action_log`)
              // The values stay in the keychain of the other computer: each secret shows
              // "Value missing" until the user replaces it (spec 020).
              db.run(
                `INSERT INTO saved_secret (id, agent_id, name, name_key, origin, auth, value_ref, saved_at, last_used_at)
                 SELECT id, agent_id, name, name_key, origin, auth, NULL, saved_at, last_used_at
                 FROM imp.saved_secret WHERE agent_id IN (SELECT id FROM agent)`,
              )
              db.run("INSERT INTO task SELECT * FROM imp.task")
              db.run("INSERT INTO import_checklist SELECT * FROM imp.import_checklist")
              db.run(
                "INSERT OR REPLACE INTO setting (key, value) SELECT key, value FROM imp.setting",
              )
              // The hand-off rule comes back (spec 030, 014). The archive is untrusted: only a
              // value that this build knows is taken.
              db.run(
                `INSERT OR REPLACE INTO organization (id, hand_off, changed_at)
                 SELECT 'organization', hand_off, changed_at FROM imp.organization
                 WHERE hand_off IN ('any', 'channels') LIMIT 1`,
              )
              // A workspace path from another computer may not work here.
              for (const a of db.all<{ id: string; workspace: string }>(
                "SELECT id, workspace FROM agent",
              )) {
                try {
                  mkdirSync(a.workspace, { recursive: true })
                } catch {
                  const fallback = join(
                    defaultRoot,
                    `${basename(a.workspace) || "agent"}-${a.id.slice(0, 6)}`,
                  )
                  mkdirSync(fallback, { recursive: true })
                  db.run("UPDATE agent SET workspace = ? WHERE id = ?", fallback, a.id)
                }
              }
              counts = {
                agents: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent")?.n ?? 0,
                messages: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message")?.n ?? 0,
              }
            })
          } finally {
            db.run("DETACH DATABASE imp")
          }

          const workspaces = new Map(
            db
              .all<{ id: string; workspace: string }>("SELECT id, workspace FROM agent")
              .map((a) => [a.id, a.workspace]),
          )
          const plain = (name: string | undefined): name is string =>
            !!name && SAFE_NAME.test(name) && name !== "." && name !== ".." && !name.startsWith(".")
          for (const [path, data] of Object.entries(entries)) {
            const [root, agentId, name, ...rest] = path.split("/")
            const workspace = agentId ? workspaces.get(agentId) : undefined
            if (!workspace) continue
            if (root === "attachments") {
              if (
                rest.length > 0 ||
                !name ||
                !SAFE_NAME.test(name) ||
                name === "." ||
                name === ".."
              )
                continue
              const dir = join(workspace, "attachments")
              mkdirSync(dir, { recursive: true })
              writeFileSync(join(dir, name), data)
            } else if (root === "knowledge") {
              // An article is one file at the top; a source is one file in the sources folder.
              const [first, second, ...deeper] = [name, ...rest]
              const isSource = first === KNOWLEDGE_SOURCES && plain(second) && deeper.length === 0
              const isArticle = rest.length === 0 && plain(first) && /\.md$/i.test(first)
              if (!isSource && !isArticle) continue
              const dir = isSource
                ? join(workspace, KNOWLEDGE_FOLDER, KNOWLEDGE_SOURCES)
                : join(workspace, KNOWLEDGE_FOLDER)
              mkdirSync(dir, { recursive: true })
              const target = join(dir, (isSource ? second : first) as string)
              // A source that is there already is read-only, so it goes first.
              rmSync(target, { force: true })
              writeFileSync(target, data)
              // A source never changes.
              if (isSource) chmodSync(target, 0o444)
            }
          }
        } catch (error) {
          return yield* new AppError({ code: "import_invalid", detail: String(error) })
        } finally {
          rmSync(work, { recursive: true, force: true })
        }

        const next = yield* settings.get
        platform.setThemeSource(next.theme)
        bus.emit("settings.changed", next)
        bus.emit("agents.changed", { serverId: "*" })
        bus.emit("providers.changed", {})
        bus.emit("places.changed", { serverId: local.id })
        return counts
      })

      return Data.of({
        export: exportData,
        import: importData,
        backup: (target) => writeArchive(target),
      })
    }),
  )
}
