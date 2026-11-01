import {
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
import { type ChatMessage, redactSecrets } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { unzipSync, zipSync } from "fflate"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { migrations } from "./migrations.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"

export interface DataService {
  /** Writes one archive: the database, the attachments and a readme. Secrets are left out. */
  export(): Effect.Effect<{ path: string | null; files: number }, AppError>
  /** Restores an archive into an app that has no agents and no accounts yet. */
  import(): Effect.Effect<{ agents: number; messages: number } | null, AppError>
}

const FORMAT = 1
const SAFE_NAME = /^[^/\\]+$/

const README = `ROBot export

This archive holds the data of one ROBot app. It has no keys or tokens.

robot.db            The database (SQLite). Servers, agents, chats, accounts and settings.
meta.json           The version of this format and of the database.
attachments/<id>/   Files that were attached to chats, one folder per agent id.

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
      const bus = yield* EventBus

      const exportData = Effect.fn("Data.export")(function* () {
        const stamp = new Date().toISOString().slice(0, 10)
        const target = yield* Effect.promise(() =>
          platform.pickSavePath(`ROBot-export-${stamp}.zip`),
        )
        if (!target) return { path: null, files: 0 }
        const known = (yield* providers.list)
          .map((a) => secrets.get(secretKey(a.id)))
          .filter((k): k is string => k !== null)

        const work = mkdtempSync(join(tmpdir(), "robot-export-"))
        try {
          const copy = join(work, "robot.db")
          db.run("VACUUM INTO ?", copy)
          const out = new DatabaseSync(copy)
          try {
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
            for (const row of out.prepare("SELECT id, text FROM memory").all() as {
              id: string
              text: string
            }[])
              out
                .prepare("UPDATE memory SET text = ? WHERE id = ?")
                .run(redactSecrets(row.text, known), row.id)
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
                  }
                return { ...p, text: redactSecrets(p.text, known) }
              })
              update.run(
                JSON.stringify(parts),
                row.error_detail === null ? null : redactSecrets(row.error_detail, known),
                row.id,
              )
            }
          } finally {
            out.close()
          }

          const entries: Record<string, Uint8Array> = {
            "README.txt": utf8(README),
            "meta.json": utf8(
              JSON.stringify({ format: FORMAT, schema: migrations.length, exportedAt: Date.now() }),
            ),
            "robot.db": readFileSync(copy),
          }
          let files = 0
          for (const server of yield* servers.list) {
            for (const archived of [false, true]) {
              for (const agent of yield* agents.list(server.id, archived)) {
                const dir = join(agent.workspace, "attachments")
                for (const name of filesIn(dir)) {
                  entries[`attachments/${agent.id}/${name}`] = readFileSync(join(dir, name))
                  files++
                }
              }
            }
          }
          writeFileSync(target, zipSync(entries, { level: 6 }))
          return { path: target, files }
        } finally {
          rmSync(work, { recursive: true, force: true })
        }
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
              copyToServer("agent")
              copyToServer("channel")
              db.run("INSERT INTO channel_member SELECT * FROM imp.channel_member")
              db.run("INSERT INTO channel_message SELECT * FROM imp.channel_message")
              db.run("INSERT INTO provider_account SELECT * FROM imp.provider_account")
              db.run("INSERT INTO message SELECT * FROM imp.message")
              db.run("INSERT INTO memory SELECT * FROM imp.memory")
              db.run("INSERT INTO agent_allow SELECT * FROM imp.agent_allow")
              db.run("INSERT INTO task SELECT * FROM imp.task")
              db.run(
                "INSERT OR REPLACE INTO setting (key, value) SELECT key, value FROM imp.setting",
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
          for (const [path, data] of Object.entries(entries)) {
            const [root, agentId, name, ...rest] = path.split("/")
            const workspace = agentId ? workspaces.get(agentId) : undefined
            if (root !== "attachments" || rest.length > 0 || !name || !workspace) continue
            if (!SAFE_NAME.test(name) || name === "." || name === "..") continue
            const dir = join(workspace, "attachments")
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, name), data)
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

      return Data.of({ export: exportData, import: importData })
    }),
  )
}
