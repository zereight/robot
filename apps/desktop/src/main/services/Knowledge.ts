import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  watch,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  articleFileName,
  articleLimit,
  articleLinks,
  cleanLine,
  contentsList,
  formatArticleFile,
  KNOWLEDGE_ARTICLES_MAX,
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_CHANGES_MAX,
  KNOWLEDGE_FOLDER,
  KNOWLEDGE_SOURCE_BYTES,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_SUMMARY_MAX,
  KNOWLEDGE_TITLE_MAX,
  KNOWLEDGE_TURN_CHANGES_MAX,
  type KnowledgeActor,
  type KnowledgeArticle,
  type KnowledgeChange,
  type KnowledgeChangeKind,
  type KnowledgeFindings,
  type KnowledgeSource,
  type KnowledgeSummary,
  type KnowledgeView,
  knowledgeFindings,
  parseArticleFile,
  redactSecrets,
  sourceFileName,
  titleKey,
  withLinks,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { SettingsStore } from "./Settings.ts"

/** What a write asks for. The title names the article. */
export interface KnowledgeWrite {
  readonly type: "write"
  readonly title: string
  /** Left out: an existing article keeps its summary. */
  readonly summary?: string
  readonly body?: string
  /** Titles of other articles. They are added to the end of the body as [[Title]]. */
  readonly links?: readonly string[]
  /** Names of files in the sources folder. Left out: an existing article keeps its sources. */
  readonly sources?: readonly string[]
  /** The file of the article to edit, when the user edits it. Without it, the title finds it. */
  readonly file?: string | null
}

export interface KnowledgeDelete {
  readonly type: "delete"
  readonly title?: string
  readonly file?: string
}

/** A change that is checked and ready, and that has not been written yet. */
export interface KnowledgePlan {
  readonly agentId: string
  readonly kind: KnowledgeChangeKind
  readonly title: string
  /** The file that holds the article after the change. */
  readonly file: string
  /** The file that holds it now, when it exists. */
  readonly oldFile: string | null
  readonly before: string | null
  readonly after: string | null
  readonly beforeHash: string | null
  /** True when the user edited the article last. */
  readonly protected: boolean
  /** True when the Knowledge folder does not exist yet. */
  readonly creates: boolean
  /** True when the workspace is not the default folder. */
  readonly chosenWorkspace: boolean
  readonly folder: string
  /** The readable old and new text for a card. */
  readonly compare: { readonly before: string; readonly after: string | null }
}

export interface KnowledgeService {
  list(agentId: string, query?: string): Effect.Effect<KnowledgeView, AppError>
  get(agentId: string, file: string): Effect.Effect<KnowledgeArticle, AppError>
  /** An article by its title, ignoring case. */
  find(agentId: string, title: string): Effect.Effect<KnowledgeArticle, AppError>
  /** Checks a write or a delete and says what it would do. Nothing is written. */
  plan(
    agentId: string,
    op: KnowledgeWrite | KnowledgeDelete,
  ): Effect.Effect<KnowledgePlan, AppError>
  /** Writes a plan and records the change. */
  apply(plan: KnowledgePlan, actor: KnowledgeActor): Effect.Effect<KnowledgeChange, AppError>
  /** Adds or edits an article for the user. */
  save(
    agentId: string,
    input: { file: string | null; title: string; summary: string; body: string },
  ): Effect.Effect<KnowledgeArticle, AppError>
  /** Deletes an article for the user. */
  remove(agentId: string, file: string): Effect.Effect<void, AppError>
  /**
   * Checks the bytes of a source before it is kept: not too big, and no stored key, key or token.
   * A source is copied as it is in an export, so the app refuses one that holds a key. Nothing is
   * written.
   */
  checkSource(data: Uint8Array | string): Effect.Effect<void, AppError>
  /** Keeps a copy of a source. A copy with the same bytes is not made twice. */
  addSource(
    agentId: string,
    input: { name: string; data: Uint8Array | string },
  ): Effect.Effect<{ name: string; size: number }, AppError>
  removeSource(agentId: string, name: string): Effect.Effect<void, AppError>
  /** The full path of a source file, for the system to open. */
  sourcePath(agentId: string, name: string): Effect.Effect<string, AppError>
  /**
   * The full path of the Knowledge folder, whether it exists, whether the user chose the workspace,
   * and whether an article was saved in it (the folder can hold a source before that).
   */
  folder(
    agentId: string,
  ): Effect.Effect<{ path: string; exists: boolean; chosen: boolean; saved: boolean }, AppError>
  changes(agentId: string): Effect.Effect<readonly KnowledgeChange[]>
  change(agentId: string, changeId: string): Effect.Effect<KnowledgeChange | null>
  undo(agentId: string, changeId: string): Effect.Effect<void, AppError>
  findings(agentId: string): Effect.Effect<KnowledgeFindings, AppError>
  /**
   * The knowledge part of the instructions for one turn, or null when knowledge is off.
   * `files` is for a vendor program, which reads and writes the folder itself.
   */
  prompt(agentId: string, message: string, mode: "tools" | "files"): string | null
  enabled(agentId: string): boolean
  /** A turn starts. The folder is not read again on its own until the turn ends. */
  begin(agentId: string): void
  /**
   * A turn ends. The folder is read again. Changes found now were made by `actor`: the agent,
   * when a vendor program wrote the files itself.
   */
  end(agentId: string, actor: KnowledgeActor): void
}

interface AgentInfo {
  id: string
  workspace: string
  knowledge_enabled: number
}

interface FileRow {
  agent_id: string
  file: string
  hash: string
  editor: KnowledgeActor
  content: string
}

interface ChangeRow {
  id: string
  agent_id: string
  kind: KnowledgeChangeKind
  title: string
  file: string
  earlier: string | null
  actor: KnowledgeActor
  at: number
  undone_at: number | null
}

/** One article as it is on disk now. */
interface Entry {
  readonly file: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly sources: readonly string[]
  readonly extra: readonly string[]
  readonly text: string
  readonly hash: string
  readonly updatedAt: number
  readonly editor: KnowledgeActor
}

interface Scan {
  readonly entries: readonly Entry[]
  readonly byFile: ReadonlyMap<string, Entry>
  readonly skipped: number
  readonly folder: string
  readonly exists: boolean
  readonly changed: boolean
}

interface Cached {
  readonly signature: string
  readonly text: string
  readonly hash: string
  readonly mtime: number
}

const hashText = (text: string) => createHash("sha256").update(text).digest("hex")
const SETTLE_MS = 250
/** An article with all its parts, for a card to compare. */
const readable = (summary: string, body: string) => [summary, body].filter(Boolean).join("\n\n")

const toApp = (error: unknown) =>
  error instanceof AppError
    ? error
    : new AppError({
        code: "knowledge_io",
        detail: String(error instanceof Error ? error.message : error),
      })

const fail = (code: string, detail?: string): never => {
  throw new AppError(detail === undefined ? { code } : { code, detail })
}

/** Writes a file in one step, so that nobody reads half of it. */
const writeAtomic = (path: string, text: string | Uint8Array) => {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, text)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

const toChange = (row: ChangeRow): KnowledgeChange => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  actor: row.actor,
  at: row.at,
  before: row.earlier,
  undone: row.undone_at !== null,
})

export class Knowledge extends Context.Service<Knowledge, KnowledgeService>()(
  "robot/main/Knowledge",
) {
  static readonly layer = Layer.effect(
    Knowledge,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform
      const secrets = yield* Secrets
      const settings = yield* SettingsStore

      /** What the app read from each file the last time, by agent and file name. */
      const cache = new Map<string, Map<string, Cached>>()
      const busy = new Map<string, number>()
      const timers = new Map<string, ReturnType<typeof setTimeout>>()
      const watchers = new Map<string, FSWatcher>()

      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          for (const timer of timers.values()) clearTimeout(timer)
          for (const watcher of watchers.values()) watcher.close()
          watchers.clear()
        }),
      )

      const emit = (agentId: string) => bus.emit("knowledge.changed", { agentId })

      const agentInfo = (agentId: string) =>
        db.get<AgentInfo>(
          "SELECT id, workspace, knowledge_enabled FROM agent WHERE id = ?",
          agentId,
        )
      const needAgent = (agentId: string) => agentInfo(agentId) ?? fail("agent_not_found")
      const folderOf = (info: AgentInfo) => join(info.workspace, KNOWLEDGE_FOLDER)
      const sourcesOf = (folder: string) => join(folder, KNOWLEDGE_SOURCES)

      /** The keys of the model accounts. A text that holds one is not saved. */
      const storedKeys = () =>
        db
          .all<{ id: string }>("SELECT id FROM provider_account")
          .map((a) => secrets.get(secretKey(a.id)))
          .filter((k): k is string => k !== null)
      const looksSecret = (text: string) => redactSecrets(text, storedKeys()) !== text
      /** A source can be any file. A stored key is found in the raw bytes too. */
      const sourceHoldsSecret = (bytes: Uint8Array) => {
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        if (storedKeys().some((key) => key.length >= 8 && buffer.includes(key))) return true
        return looksSecret(buffer.toString("utf8"))
      }
      const sourceBytes = (data: Uint8Array | string) =>
        typeof data === "string" ? new TextEncoder().encode(data) : data
      const checkSourceBytes = (bytes: Uint8Array) => {
        if (bytes.length > KNOWLEDGE_SOURCE_BYTES) fail("knowledge_source_big")
        if (sourceHoldsSecret(bytes)) fail("knowledge_secret")
      }

      const rowsOf = (agentId: string) =>
        new Map(
          db
            .all<FileRow>("SELECT * FROM knowledge_file WHERE agent_id = ?", agentId)
            .map((r) => [r.file, r]),
        )
      const upsertRow = (agentId: string, file: string, text: string, editor: KnowledgeActor) =>
        db.run(
          `INSERT INTO knowledge_file (agent_id, file, hash, editor, content) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (agent_id, file) DO UPDATE SET hash = excluded.hash, editor = excluded.editor,
             content = excluded.content`,
          agentId,
          file,
          hashText(text),
          editor,
          text,
        )

      const record = (
        agentId: string,
        kind: KnowledgeChangeKind,
        title: string,
        file: string,
        earlier: string | null,
        actor: KnowledgeActor,
      ): KnowledgeChange => {
        const id = randomUUID()
        db.run(
          `INSERT INTO knowledge_change (id, agent_id, kind, title, file, earlier, actor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          agentId,
          kind,
          title,
          file,
          earlier,
          actor,
          Date.now(),
        )
        db.run(
          `DELETE FROM knowledge_change WHERE agent_id = ? AND id NOT IN (
             SELECT id FROM knowledge_change WHERE agent_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
          agentId,
          agentId,
          KNOWLEDGE_CHANGES_MAX,
        )
        return toChange(
          db.get<ChangeRow>("SELECT * FROM knowledge_change WHERE id = ?", id) as ChangeRow,
        )
      }

      const cacheOf = (agentId: string) => {
        const known = cache.get(agentId)
        if (known) return known
        const fresh = new Map<string, Cached>()
        cache.set(agentId, fresh)
        return fresh
      }

      /** Notes the file as the app wrote it, so that the next read finds nothing new. */
      const remember = (
        agentId: string,
        folder: string,
        file: string,
        text: string,
        editor: KnowledgeActor,
      ) => {
        const info = statSync(join(folder, file))
        cacheOf(agentId).set(file, {
          signature: `${info.size}:${info.mtimeMs}`,
          text,
          hash: hashText(text),
          mtime: info.mtimeMs,
        })
        upsertRow(agentId, file, text, editor)
      }
      const forget = (agentId: string, file: string) => {
        cacheOf(agentId).delete(file)
        db.run("DELETE FROM knowledge_file WHERE agent_id = ? AND file = ?", agentId, file)
      }

      const putBack = (agentId: string, folder: string, file: string, row: FileRow | undefined) => {
        if (row) {
          writeAtomic(join(folder, file), row.content)
          cacheOf(agentId).delete(file)
          remember(agentId, folder, file, row.content, row.editor)
        } else {
          rmSync(join(folder, file), { force: true })
          cacheOf(agentId).delete(file)
        }
      }

      /**
       * Reads the folder. A file that is new, changed or gone since the last read is a change
       * of `actor`. The folder is the truth: what the files say is what the articles are.
       */
      const scan = (agentId: string, actor: KnowledgeActor): Scan => {
        const info = needAgent(agentId)
        const folder = folderOf(info)
        const exists = existsSync(folder)
        const known = cacheOf(agentId)
        const rows = rowsOf(agentId)
        let names: string[] = []
        if (exists) {
          try {
            // Hidden files and folders are not read. Only Markdown files count.
            names = readdirSync(folder, { withFileTypes: true })
              .filter((e) => e.isFile() && !e.name.startsWith(".") && /\.md$/i.test(e.name))
              .map((e) => e.name)
              // A file that the app knows comes first, so that a new file of another app with the
              // same title is the second file, which is not shown.
              .sort(
                (a, b) => Number(rows.has(b)) - Number(rows.has(a)) || (a < b ? -1 : a > b ? 1 : 0),
              )
          } catch {
            names = []
          }
        }
        const entries: Entry[] = []
        const byFile = new Map<string, Entry>()
        const titles = new Set<string>()
        const hidden = new Set<string>()
        let skipped = 0
        let changed = false
        for (const file of names) {
          let stat: Stats
          try {
            stat = statSync(join(folder, file))
          } catch {
            continue
          }
          const signature = `${stat.size}:${stat.mtimeMs}`
          let read = known.get(file)
          if (read?.signature !== signature) {
            let text: string
            try {
              text = readFileSync(join(folder, file), "utf8")
            } catch {
              continue
            }
            read = { signature, text, hash: hashText(text), mtime: stat.mtimeMs }
            known.set(file, read)
          }
          const parsed = parseArticleFile(file, read.text)
          const key = titleKey(parsed.title)
          if (titles.has(key)) {
            skipped++
            hidden.add(file)
            continue
          }
          const row = rows.get(file)
          if (row?.hash !== read.hash) {
            // A vendor program wrote this file. The key rule holds for it too.
            if (actor === "agent" && looksSecret(read.text)) {
              putBack(agentId, folder, file, row)
              changed = true
              if (!row) continue
              const kept = parseArticleFile(file, row.content)
              titles.add(titleKey(kept.title))
              const text = row.content
              const entry: Entry = {
                file,
                ...kept,
                text,
                hash: hashText(text),
                updatedAt: Date.now(),
                editor: row.editor,
              }
              entries.push(entry)
              byFile.set(file, entry)
              continue
            }
            if (row) record(agentId, "edit", parsed.title, file, row.content, actor)
            else record(agentId, "add", parsed.title, file, null, actor)
            upsertRow(agentId, file, read.text, actor)
            rows.set(file, {
              agent_id: agentId,
              file,
              hash: read.hash,
              editor: actor,
              content: read.text,
            })
            changed = true
          }
          titles.add(key)
          const editor = rows.get(file)?.editor ?? actor
          const entry: Entry = {
            file,
            ...parsed,
            text: read.text,
            hash: read.hash,
            updatedAt: Math.round(read.mtime),
            editor,
          }
          entries.push(entry)
          byFile.set(file, entry)
        }
        for (const row of rows.values()) {
          // A file that is hidden still exists. It is not deleted.
          if (byFile.has(row.file) || hidden.has(row.file)) continue
          // The file is gone, or it no longer counts as an article.
          const parsed = parseArticleFile(row.file, row.content)
          record(agentId, "delete", parsed.title, row.file, row.content, actor)
          forget(agentId, row.file)
          changed = true
        }
        for (const file of [...known.keys()]) if (!names.includes(file)) known.delete(file)
        if (exists) watchFolders(agentId, folder)
        return { entries, byFile, skipped, folder, exists, changed }
      }

      const watchFolders = (agentId: string, folder: string) => {
        for (const dir of [folder, sourcesOf(folder)]) {
          const key = `${agentId}\0${dir}`
          if (watchers.has(key) || !existsSync(dir)) continue
          try {
            const watcher = watch(dir, { persistent: false }, () => settle(agentId))
            watcher.on("error", () => {
              watcher.close()
              watchers.delete(key)
            })
            watchers.set(key, watcher)
          } catch {
            // A folder that cannot be watched is still read when someone asks.
          }
        }
      }
      const unwatch = (agentId: string) => {
        for (const [key, watcher] of watchers)
          if (key.startsWith(`${agentId}\0`)) {
            watcher.close()
            watchers.delete(key)
          }
      }

      /** A file changed on disk. A short wait lets a burst of writes end. */
      const settle = (agentId: string) => {
        clearTimeout(timers.get(agentId))
        const timer = setTimeout(() => {
          timers.delete(agentId)
          // The end of the turn reads the folder.
          if ((busy.get(agentId) ?? 0) > 0) return
          if (!agentInfo(agentId)) {
            // The agent is gone, with its workspace.
            cache.delete(agentId)
            return unwatch(agentId)
          }
          try {
            scan(agentId, "user")
          } catch {
            // The folder may be gone for a moment. The next read tries again.
          }
          emit(agentId)
        }, SETTLE_MS)
        timer.unref?.()
        timers.set(agentId, timer)
      }

      const sourceNames = (folder: string) => {
        try {
          return readdirSync(sourcesOf(folder), { withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort()
        } catch {
          return []
        }
      }

      const toSummary = (e: Entry): KnowledgeSummary => ({
        file: e.file,
        title: e.title,
        summary: e.summary,
        updatedAt: e.updatedAt,
        editor: e.editor,
      })

      const toArticle = (e: Entry, scanned: Scan): KnowledgeArticle => {
        const byTitle = new Map(scanned.entries.map((x) => [titleKey(x.title), x.file]))
        const present = new Set(sourceNames(scanned.folder))
        return {
          ...toSummary(e),
          body: e.body,
          links: articleLinks(e.body).map((title) => ({
            title,
            file: byTitle.get(titleKey(title)) ?? null,
          })),
          sources: e.sources.map((name) => ({ name, exists: present.has(name) })),
        }
      }

      /**
       * A workspace counts as chosen by the user when it is not in the default workspace folder.
       * A folder under a root that the user set in Settings is in the default workspace folder, and
       * so is a folder under the built-in root (an agent made before the user set a root).
       */
      /** True once an article was saved: there is one now, or there was one (a change is kept). */
      const articleSaved = (agentId: string, scanned: Scan) =>
        scanned.entries.length > 0 ||
        scanned.skipped > 0 ||
        db.get("SELECT 1 AS x FROM knowledge_change WHERE agent_id = ? LIMIT 1", agentId) !==
          undefined

      const isChosen = (info: AgentInfo) => {
        const roots = [Effect.runSync(settings.get).workspaceRoot, platform.defaultWorkspaceRoot]
        return !roots.some((root) => {
          if (!root) return false
          const path = relative(resolve(root), resolve(info.workspace))
          return path !== "" && !path.startsWith("..") && !isAbsolute(path)
        })
      }

      const takenFile = (folder: string, names: readonly string[]) => {
        const lower = new Set(names.map((n) => n.toLocaleLowerCase()))
        try {
          for (const name of readdirSync(folder)) lower.add(name.toLocaleLowerCase())
        } catch {}
        return (name: string) => lower.has(name.toLocaleLowerCase())
      }

      const planOf = (agentId: string, op: KnowledgeWrite | KnowledgeDelete): KnowledgePlan => {
        const info = needAgent(agentId)
        const scanned = scan(agentId, "user")
        // An agent names an article by its title (no `file`). The user names it by its file, or
        // sends `null` for a new one, which must not match an article of the same title.
        const byFile = (file: string | null | undefined) =>
          file ? scanned.byFile.get(file) : undefined
        const byTitle = scanned.entries.find((e) => titleKey(e.title) === titleKey(op.title ?? ""))
        const found =
          op.type === "write" && op.file === null ? undefined : op.file ? byFile(op.file) : byTitle
        const base = {
          agentId,
          creates: !scanned.exists,
          chosenWorkspace: isChosen(info),
          folder: scanned.folder,
        }
        if (op.type === "delete") {
          if (!found) return fail("knowledge_not_found")
          return {
            ...base,
            kind: "delete",
            title: found.title,
            file: found.file,
            oldFile: found.file,
            before: found.text,
            after: null,
            beforeHash: found.hash,
            protected: found.editor === "user",
            compare: { before: readable(found.summary, found.body), after: null },
          }
        }
        if (op.file && !found) return fail("knowledge_not_found")
        // The agent names an article by its title and cannot rename it. The user can.
        const title = found && !op.file ? found.title : cleanLine(op.title)
        const summary = op.summary === undefined ? (found?.summary ?? "") : cleanLine(op.summary)
        const body = withLinks(op.body ?? found?.body ?? "", op.links ?? [])
        const limit = articleLimit(title, summary, body)
        if (limit) return fail(limit)
        if (looksSecret([title, summary, body].join("\n"))) return fail("knowledge_secret")
        const clash = scanned.entries.find(
          (e) => titleKey(e.title) === titleKey(title) && e.file !== found?.file,
        )
        if (clash) return fail("knowledge_title_taken")
        if (!found && scanned.entries.length >= KNOWLEDGE_ARTICLES_MAX)
          return fail("knowledge_full")
        const present = sourceNames(scanned.folder)
        const sources = [...new Set(op.sources ?? found?.sources ?? [])]
        for (const name of op.sources ?? [])
          if (!present.includes(name)) return fail("knowledge_source_missing", name)
        const taken = takenFile(
          scanned.folder,
          scanned.entries.filter((e) => e.file !== found?.file).map((e) => e.file),
        )
        const file =
          found && titleKey(found.title) === titleKey(title)
            ? found.file
            : articleFileName(title, taken)
        const after = formatArticleFile({
          title,
          summary,
          body,
          sources,
          extra: found?.extra ?? [],
        })
        return {
          ...base,
          kind: found ? "edit" : "add",
          title,
          file,
          oldFile: found?.file ?? null,
          before: found?.text ?? null,
          after,
          beforeHash: found?.hash ?? null,
          protected: found?.editor === "user",
          compare: {
            before: found ? readable(found.summary, found.body) : "",
            after: readable(summary, body),
          },
        }
      }

      const applyPlan = (plan: KnowledgePlan, actor: KnowledgeActor): KnowledgeChange => {
        const info = needAgent(plan.agentId)
        const folder = folderOf(info)
        const scanned = scan(plan.agentId, "user")
        const current = plan.oldFile ? scanned.byFile.get(plan.oldFile) : undefined
        if (plan.kind === "add") {
          const taken = takenFile(folder, [])
          if (
            taken(plan.file) ||
            scanned.entries.some((e) => titleKey(e.title) === titleKey(plan.title))
          )
            fail("knowledge_changed")
          if (scanned.entries.length >= KNOWLEDGE_ARTICLES_MAX) fail("knowledge_full")
        } else if (!current || current.hash !== plan.beforeHash) fail("knowledge_changed")
        if (plan.kind === "delete") {
          rmSync(join(folder, plan.file), { force: true })
          forget(plan.agentId, plan.file)
        } else {
          mkdirSync(folder, { recursive: true })
          writeAtomic(join(folder, plan.file), plan.after ?? "")
          if (plan.oldFile && plan.oldFile !== plan.file) {
            rmSync(join(folder, plan.oldFile), { force: true })
            forget(plan.agentId, plan.oldFile)
          }
          remember(plan.agentId, folder, plan.file, plan.after ?? "", actor)
          watchFolders(plan.agentId, folder)
        }
        const change = record(plan.agentId, plan.kind, plan.title, plan.file, plan.before, actor)
        emit(plan.agentId)
        return change
      }

      /** Puts an earlier text back as the article of `file`. */
      const restore = (
        agentId: string,
        file: string,
        text: string,
        heldBy: Entry | undefined,
      ): KnowledgeChange => {
        const info = needAgent(agentId)
        const folder = folderOf(info)
        const scanned = scan(agentId, "user")
        const parsed = parseArticleFile(file, text)
        const key = titleKey(parsed.title)
        if (scanned.entries.some((e) => titleKey(e.title) === key && e.file !== heldBy?.file))
          fail("knowledge_title_taken")
        if (!heldBy && scanned.entries.length >= KNOWLEDGE_ARTICLES_MAX) fail("knowledge_full")
        const others = scanned.entries.filter((e) => e.file !== heldBy?.file).map((e) => e.file)
        const taken = takenFile(folder, others)
        let target = file
        if (heldBy) {
          if (titleKey(heldBy.title) !== key) target = articleFileName(parsed.title, taken)
        } else if (taken(file)) target = articleFileName(parsed.title, taken)
        mkdirSync(folder, { recursive: true })
        writeAtomic(join(folder, target), text)
        if (heldBy && heldBy.file !== target) {
          rmSync(join(folder, heldBy.file), { force: true })
          forget(agentId, heldBy.file)
        }
        remember(agentId, folder, target, text, "user")
        watchFolders(agentId, folder)
        return record(
          agentId,
          heldBy ? "edit" : "add",
          parsed.title,
          target,
          heldBy?.text ?? null,
          "user",
        )
      }

      const undo = (agentId: string, changeId: string) => {
        needAgent(agentId)
        const row = db.get<ChangeRow>(
          "SELECT * FROM knowledge_change WHERE id = ? AND agent_id = ?",
          changeId,
          agentId,
        )
        if (!row) return fail("knowledge_not_found")
        if (row.undone_at !== null) return fail("knowledge_undone")
        const scanned = scan(agentId, "user")
        // Later changes do not matter: the article is the one in this file, or else the one with
        // this title (it may have been renamed and its file with it).
        const held =
          scanned.byFile.get(row.file) ??
          scanned.entries.find((e) => titleKey(e.title) === titleKey(row.title))
        if (row.kind === "add") {
          // An added article goes again.
          if (!held) return fail("knowledge_not_found")
          const folder = scanned.folder
          rmSync(join(folder, held.file), { force: true })
          forget(agentId, held.file)
          record(agentId, "delete", held.title, held.file, held.text, "user")
        } else if (row.earlier !== null) {
          // A deleted article returns as a new one. An edit goes back on the article it was made on.
          restore(agentId, row.file, row.earlier, row.kind === "edit" ? held : undefined)
        }
        db.run("UPDATE knowledge_change SET undone_at = ? WHERE id = ?", Date.now(), changeId)
        emit(agentId)
      }

      const view = (agentId: string, query?: string): KnowledgeView => {
        const info = needAgent(agentId)
        const scanned = scan(agentId, "user")
        const tokens = cleanLine(query ?? "")
          .toLocaleLowerCase()
          .split(" ")
          .filter(Boolean)
        const shown = scanned.entries
          .filter((e) => {
            const haystack = `${e.title}\n${e.summary}\n${e.body}`.toLocaleLowerCase()
            return tokens.every((t) => haystack.includes(t))
          })
          .map(toSummary)
          .sort((a, b) => a.title.localeCompare(b.title))
        const sources: KnowledgeSource[] = []
        for (const name of sourceNames(scanned.folder)) {
          try {
            const stat = statSync(join(sourcesOf(scanned.folder), name))
            sources.push({ name, size: stat.size, addedAt: Math.round(stat.mtimeMs) })
          } catch {
            // The file went away while the list was made.
          }
        }
        return {
          enabled: info.knowledge_enabled === 1,
          folder: scanned.folder,
          canOpenFolder: scanned.exists && articleSaved(agentId, scanned),
          articles: shown,
          total: scanned.entries.length,
          limit: KNOWLEDGE_ARTICLES_MAX,
          sources,
          skipped: scanned.skipped,
        }
      }

      const sourceFile = (agentId: string, name: string) => {
        const info = needAgent(agentId)
        if (!name || name !== name.replace(/[\\/]/g, "") || name.startsWith("."))
          return fail("knowledge_source_invalid")
        return join(sourcesOf(folderOf(info)), name)
      }

      const attempt = <A>(run: () => A) => Effect.try({ try: run, catch: toApp })

      return Knowledge.of({
        list: (agentId, query) => attempt(() => view(agentId, query)),
        get: (agentId, file) =>
          attempt(() => {
            const scanned = scan(agentId, "user")
            const entry = scanned.byFile.get(file)
            return entry ? toArticle(entry, scanned) : fail("knowledge_not_found")
          }),
        find: (agentId, title) =>
          attempt(() => {
            const scanned = scan(agentId, "user")
            const entry = scanned.entries.find((e) => titleKey(e.title) === titleKey(title))
            return entry ? toArticle(entry, scanned) : fail("knowledge_not_found")
          }),
        plan: (agentId, op) => attempt(() => planOf(agentId, op)),
        apply: (plan, actor) => attempt(() => applyPlan(plan, actor)),
        save: (agentId, input) =>
          attempt(() => {
            const plan = planOf(agentId, {
              type: "write",
              title: input.title,
              summary: input.summary,
              body: input.body,
              file: input.file,
            })
            applyPlan(plan, "user")
            const scanned = scan(agentId, "user")
            const entry = scanned.byFile.get(plan.file) ?? fail("knowledge_not_found")
            return toArticle(entry, scanned)
          }),
        remove: (agentId, file) =>
          attempt(() => {
            applyPlan(planOf(agentId, { type: "delete", file }), "user")
          }),
        checkSource: (data) => attempt(() => checkSourceBytes(sourceBytes(data))),
        addSource: (agentId, input) =>
          attempt(() => {
            const info = needAgent(agentId)
            const folder = folderOf(info)
            const bytes = sourceBytes(input.data)
            // Nothing is written before the check: a refused source leaves no file and no folder.
            checkSourceBytes(bytes)
            const dir = sourcesOf(folder)
            mkdirSync(dir, { recursive: true })
            const digest = createHash("sha256").update(bytes).digest("hex")
            for (const name of sourceNames(folder)) {
              const path = join(dir, name)
              if (
                statSync(path).size === bytes.length &&
                createHash("sha256").update(readFileSync(path)).digest("hex") === digest
              )
                return { name, size: bytes.length }
            }
            const names = new Set(sourceNames(folder).map((n) => n.toLocaleLowerCase()))
            const name = sourceFileName(input.name, (n) => names.has(n.toLocaleLowerCase()))
            const path = join(dir, name)
            writeAtomic(path, bytes)
            // A source never changes, so the copy is read-only.
            try {
              chmodSync(path, 0o444)
            } catch {}
            watchFolders(agentId, folder)
            emit(agentId)
            return { name, size: bytes.length }
          }),
        removeSource: (agentId, name) =>
          attempt(() => {
            const path = sourceFile(agentId, name)
            if (!existsSync(path)) return fail("knowledge_not_found")
            try {
              chmodSync(path, 0o666)
            } catch {}
            rmSync(path, { force: true })
            emit(agentId)
          }),
        sourcePath: (agentId, name) =>
          attempt(() => {
            const path = sourceFile(agentId, name)
            return existsSync(path) ? path : fail("knowledge_not_found")
          }),
        folder: (agentId) =>
          attempt(() => {
            const info = needAgent(agentId)
            const scanned = scan(agentId, "user")
            return {
              path: scanned.folder,
              exists: scanned.exists,
              chosen: isChosen(info),
              saved: scanned.exists && articleSaved(agentId, scanned),
            }
          }),
        changes: (agentId) =>
          Effect.sync(() =>
            db
              .all<ChangeRow>(
                "SELECT * FROM knowledge_change WHERE agent_id = ? ORDER BY at DESC, rowid DESC",
                agentId,
              )
              .map(toChange),
          ),
        change: (agentId, changeId) =>
          Effect.sync(() => {
            const row = db.get<ChangeRow>(
              "SELECT * FROM knowledge_change WHERE id = ? AND agent_id = ?",
              changeId,
              agentId,
            )
            return row ? toChange(row) : null
          }),
        undo: (agentId, changeId) => attempt(() => undo(agentId, changeId)),
        findings: (agentId) =>
          attempt(() => {
            const scanned = scan(agentId, "user")
            const present = new Set(sourceNames(scanned.folder))
            return knowledgeFindings(
              scanned.entries.map((e) => ({
                title: e.title,
                body: e.body,
                sources: e.sources.filter((s) => present.has(s)),
              })),
            )
          }),
        enabled: (agentId) => agentInfo(agentId)?.knowledge_enabled === 1,
        prompt: (agentId, message, mode) => {
          const info = agentInfo(agentId)
          if (info?.knowledge_enabled !== 1) return null
          const scanned = scan(agentId, "user")
          const { lines, note } = contentsList(
            scanned.entries,
            message,
            (omitted) =>
              `(${omitted} more articles are not in this list.${
                mode === "tools" ? " Read one by its title." : ""
              })`,
          )
          const list =
            lines.length === 0 && note === null
              ? "There are no articles yet."
              : `Contents (title: summary):\n${[...lines, ...(note === null ? [] : [note])].join("\n")}`
          const rules = `An article has a title of 1 to ${KNOWLEDGE_TITLE_MAX} characters that is unique ignoring case, a summary of up to ${KNOWLEDGE_SUMMARY_MAX} characters, and a Markdown body of up to ${KNOWLEDGE_BODY_MAX} characters. Link to another article with [[Title]] in the body. There can be ${KNOWLEDGE_ARTICLES_MAX} articles at most. Never put a password, key or token in an article.`
          if (mode === "tools") {
            return [
              "Your knowledge is a set of linked articles that you keep between chats. Memory is for short facts. Write an article when you learn a lasting topic that is too long or too linked for memory. Open an article with read_article before you use it. Save with write_article (send the whole body), delete with delete_article, and keep a file or page that an article uses with add_source, then name it in the sources of the article. Make at most 5 article changes in one turn. You cannot change a source.",
              rules,
              list,
            ].join("\n\n")
          }
          return [
            `Your knowledge is a folder of Markdown files, one file for each article: ${scanned.folder}. Read it with your file tools before you use it, and keep it current. A file starts with a header between two lines of --- that holds "title:", "summary:" and one "source:" line for each source file; then comes the body. Put a source file in the "${KNOWLEDGE_SOURCES}" folder inside it, and never change or delete a source. Name an article file after its title. In your replies, name an article by its title. Never paste the folder path or a file path. Make at most ${KNOWLEDGE_TURN_CHANGES_MAX} article changes in one turn.`,
            rules,
            list,
          ].join("\n\n")
        },
        begin: (agentId) => {
          busy.set(agentId, (busy.get(agentId) ?? 0) + 1)
        },
        end: (agentId, actor) => {
          const left = (busy.get(agentId) ?? 1) - 1
          if (left > 0) return void busy.set(agentId, left)
          busy.delete(agentId)
          if (!agentInfo(agentId)) return
          try {
            scan(agentId, actor)
          } catch {
            // The folder cannot be read now. The next read tries again.
          }
          emit(agentId)
        },
      })
    }),
  )
}
