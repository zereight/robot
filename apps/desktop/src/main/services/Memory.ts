import { randomUUID } from "node:crypto"
import {
  factKey,
  looksLikeSecret,
  MEMORY_HISTORY_DAYS,
  MEMORY_HISTORY_ROWS,
  MEMORY_USER_MAX,
  type MemoryActor,
  type MemoryHistoryRow,
  type MemoryItem,
  type MemoryKind,
  type MemoryMode,
  type MemorySource,
  type MemoryState,
  matchesWords,
  searchWords,
  selectForRead,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"

/**
 * The memory of a workflow (spec 008): the items, the history of their changes, and the choices of
 * the memory page. A node or the chat saves and reads items with the memory tool (`memoryTool.ts`);
 * this service holds the store, and the changes of the user.
 *
 * Not built, and listed in the report of W8: the memory check (008, "Memory check"): the specs leave
 * open which model it uses and where the user sees it (docs/spec-questions.md, W2 rows for 008).
 */

interface ItemRow {
  id: string
  workflow_id: string
  text: string
  source: MemorySource
  task_id: string | null
  created_at: number
  updated_at: number
}

interface HistoryRow {
  id: string
  workflow_id: string
  memory_id: string
  at: number
  actor: MemoryActor
  kind: MemoryKind
  source: MemorySource
  old_text: string | null
  new_text: string | null
  hidden: number
  undo_of: string | null
  undone_by: string | null
}

/** Who makes a change: the actor of the history row and where the item came from. */
export interface MemoryAuthor {
  readonly actor: Exclude<MemoryActor, "undo">
  readonly source: MemorySource
  readonly taskId?: string | null
}

export interface Saved {
  readonly item: MemoryItem
  readonly historyId: string
}

export interface MemoryService {
  readonly state: (workflowId: string, search?: string) => Effect.Effect<MemoryState, AppError>
  readonly history: (workflowId: string) => Effect.Effect<readonly MemoryHistoryRow[], AppError>
  /** The user types an item (spec 008, "Flows", 2). Up to 1000 characters; a secret is allowed by hand. */
  readonly add: (workflowId: string, text: string) => Effect.Effect<MemoryItem, AppError>
  readonly update: (id: string, text: string) => Effect.Effect<MemoryItem, AppError>
  readonly remove: (id: string) => Effect.Effect<void, AppError>
  /** Undo of one row of the history (spec 008, "Flows", 4). */
  readonly undo: (historyId: string) => Effect.Effect<void, AppError>
  readonly setEnabled: (
    workflowId: string,
    enabled: boolean,
  ) => Effect.Effect<MemoryState, AppError>
  readonly setMode: (workflowId: string, mode: MemoryMode) => Effect.Effect<MemoryState, AppError>
  /**
   * Makes an item for a node, for an accepted proposal. The caller has checked the limits, the
   * secret, the duplicate and the switches (see `memoryTool.ts` and `Proposals.ts`).
   */
  readonly insert: (
    workflowId: string,
    text: string,
    author: MemoryAuthor,
  ) => Effect.Effect<Saved, AppError>
  /** True when an item with this text exists: spaces at both ends and case do not matter. */
  readonly known: (workflowId: string, text: string) => boolean
  /** The items that a search of the memory tool gives back (spec 008, "Flows", 5). */
  readonly search: (
    workflowId: string,
    query: string,
  ) => Effect.Effect<{ items: readonly MemoryItem[]; more: boolean; total: number }, AppError>
  /** What the run view tells about the memory work of one task (spec 008, "Flows", 1). */
  readonly ofTask: (taskId: string) => readonly TaskMemoryEvent[]
  /** Whether memory is on for a workflow, which mode, and the switch "Self-improvement". */
  readonly settings: (
    workflowId: string,
  ) => { enabled: boolean; mode: MemoryMode; selfImprovement: boolean } | null
}

/** A memory line of a task: an item that it saved, or a fact that it suggested. */
export interface TaskMemoryEvent {
  readonly kind: "saved" | "suggested"
  readonly text: string
  /** For a saved item: the row of the history that Undo reads, and whether Undo still works. */
  readonly historyId: string | null
  readonly canUndo: boolean
  readonly proposalId: string | null
}

export class Memory extends Context.Service<Memory, MemoryService>()("robot/main/Memory") {
  static readonly layer = Layer.effect(
    Memory,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus

      const workflowRow = (id: string) =>
        db.get<{
          id: string
          server_id: string
          memory_enabled: number
          memory_mode: MemoryMode
          self_improvement: number
        }>(
          "SELECT id, server_id, memory_enabled, memory_mode, self_improvement FROM workflow WHERE id = ?",
          id,
        )
      const need = (
        id: string,
      ): Effect.Effect<NonNullable<ReturnType<typeof workflowRow>>, AppError> => {
        const w = workflowRow(id)
        return w ? Effect.succeed(w) : Effect.fail(new AppError({ code: "workflow_not_found" }))
      }
      const itemRow = (id: string) => db.get<ItemRow>("SELECT * FROM memory WHERE id = ?", id)
      const toItem = (r: ItemRow): MemoryItem => ({
        id: r.id,
        text: r.text,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })
      const changed = (workflowId: string) => bus.emit("memory.changed", { workflowId })

      /**
       * Keeps the history inside its limits: 90 days and 1000 rows for each workflow, the oldest
       * first. Removing a row does not change an item (spec 008, "Rules").
       */
      const trim = (workflowId: string) => {
        db.run(
          "DELETE FROM memory_history WHERE workflow_id = ? AND at < ?",
          workflowId,
          Date.now() - MEMORY_HISTORY_DAYS * 86_400_000,
        )
        db.run(
          `DELETE FROM memory_history WHERE workflow_id = ? AND id NOT IN (
             SELECT id FROM memory_history WHERE workflow_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
          workflowId,
          workflowId,
          MEMORY_HISTORY_ROWS,
        )
      }

      /**
       * Writes a row of the history. A text that looks like a secret is not stored: the row is
       * hidden, shows "[redacted]" and has no Undo (spec 008, "Rules").
       */
      const log = (row: {
        workflowId: string
        memoryId: string
        actor: MemoryActor
        kind: MemoryKind
        source: MemorySource
        oldText: string | null
        newText: string | null
        undoOf?: string | null
      }): string => {
        const id = randomUUID()
        const hidden = [row.oldText, row.newText].some((t) => t !== null && looksLikeSecret(t))
        db.run(
          `INSERT INTO memory_history (id, workflow_id, memory_id, at, actor, kind, source, old_text, new_text, hidden, undo_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          row.workflowId,
          row.memoryId,
          Date.now(),
          row.actor,
          row.kind,
          row.source,
          hidden ? null : row.oldText,
          hidden ? null : row.newText,
          hidden ? 1 : 0,
          row.undoOf ?? null,
        )
        trim(row.workflowId)
        return id
      }

      const insertItem = (
        workflowId: string,
        text: string,
        author: MemoryAuthor & { id?: string },
        historyActor: MemoryActor = author.actor,
        undoOf: string | null = null,
      ): Saved => {
        const id = author.id ?? randomUUID()
        const now = Date.now()
        let historyId = ""
        db.transaction(() => {
          db.run(
            `INSERT INTO memory (id, workflow_id, text, source, task_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            workflowId,
            text,
            author.source,
            author.taskId ?? null,
            now,
            now,
          )
          historyId = log({
            workflowId,
            memoryId: id,
            actor: historyActor,
            kind: "added",
            source: author.source,
            oldText: null,
            newText: text,
            undoOf,
          })
        })
        changed(workflowId)
        return { item: toItem(itemRow(id) as ItemRow), historyId }
      }

      const checkText = (text: string) => {
        const t = text.trim()
        if (t === "") return new AppError({ code: "memory_text_empty", detail: "text" })
        if ([...t].length > MEMORY_USER_MAX)
          return new AppError({ code: "memory_text_long", detail: "text" })
        return null
      }

      /**
       * True while the item is exactly as the change of a row made it, so Undo is on (spec 008,
       * "Flows", 4): after an add or an edit the item has the new text; after a delete the item is
       * missing.
       */
      const asMade = (r: HistoryRow): boolean => {
        const item = itemRow(r.memory_id)
        if (r.kind === "deleted") return item === undefined
        return item !== undefined && item.text === r.new_text
      }

      const toHistory = (r: HistoryRow): MemoryHistoryRow => {
        const redacted = r.hidden === 1
        const undoBlocked: MemoryHistoryRow["undoBlocked"] = redacted
          ? "redacted"
          : r.undone_by
            ? "undone"
            : asMade(r)
              ? null
              : "newer"
        return {
          id: r.id,
          memoryId: r.memory_id,
          at: r.at,
          actor: r.actor,
          kind: r.kind,
          source: r.source,
          oldText: redacted ? null : r.old_text,
          newText: redacted ? null : r.new_text,
          redacted,
          undoOf: r.undo_of,
          undoneBy: r.undone_by,
          canUndo: undoBlocked === null,
          undoBlocked,
        }
      }

      const stateOf = (workflowId: string, search?: string): MemoryState => {
        const w = workflowRow(workflowId) as NonNullable<ReturnType<typeof workflowRow>>
        const words = searchWords(search ?? "")
        const items = db
          .all<ItemRow>(
            "SELECT * FROM memory WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC",
            workflowId,
          )
          .filter((r) => words.length === 0 || matchesWords(r.text, words))
          .map(toItem)
        return {
          workflowId,
          enabled: w.memory_enabled === 1,
          mode: w.memory_mode,
          selfImprovement: w.self_improvement === 1,
          items,
          proposals:
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM proposal WHERE workflow_id = ? AND kind = 'memory' AND state = 'waiting'",
              workflowId,
            )?.n ?? 0,
        }
      }

      const known = (workflowId: string, text: string) => {
        const key = factKey(text)
        return db
          .all<{ text: string }>("SELECT text FROM memory WHERE workflow_id = ?", workflowId)
          .some((r) => factKey(r.text) === key)
      }

      const add = (workflowId: string, text: string) =>
        Effect.gen(function* () {
          yield* need(workflowId)
          const problem = checkText(text)
          if (problem) return yield* problem
          return insertItem(workflowId, text.trim(), { actor: "user", source: "user" }).item
        })

      const update = (id: string, text: string) =>
        Effect.gen(function* () {
          const row = itemRow(id)
          if (!row) return yield* new AppError({ code: "memory_not_found" })
          const problem = checkText(text)
          if (problem) return yield* problem
          const next = text.trim()
          if (next === row.text) return toItem(row)
          db.transaction(() => {
            db.run("UPDATE memory SET text = ?, updated_at = ? WHERE id = ?", next, Date.now(), id)
            log({
              workflowId: row.workflow_id,
              memoryId: id,
              actor: "user",
              kind: "edited",
              source: row.source,
              oldText: row.text,
              newText: next,
            })
          })
          changed(row.workflow_id)
          return toItem(itemRow(id) as ItemRow)
        })

      const remove = (id: string) =>
        Effect.gen(function* () {
          const row = itemRow(id)
          if (!row) return yield* new AppError({ code: "memory_not_found" })
          db.transaction(() => {
            db.run("DELETE FROM memory WHERE id = ?", id)
            log({
              workflowId: row.workflow_id,
              memoryId: id,
              actor: "user",
              kind: "deleted",
              source: row.source,
              oldText: row.text,
              newText: null,
            })
          })
          changed(row.workflow_id)
        })

      const undo = (historyId: string) =>
        Effect.gen(function* () {
          const r = db.get<HistoryRow>("SELECT * FROM memory_history WHERE id = ?", historyId)
          if (!r) return yield* new AppError({ code: "history_not_found" })
          const view = toHistory(r)
          if (!view.canUndo) return yield* new AppError({ code: "memory_undo_blocked" })
          db.transaction(() => {
            let undoRow: string
            if (r.kind === "added") {
              db.run("DELETE FROM memory WHERE id = ?", r.memory_id)
              undoRow = log({
                workflowId: r.workflow_id,
                memoryId: r.memory_id,
                actor: "undo",
                kind: "deleted",
                source: r.source,
                oldText: r.new_text,
                newText: null,
                undoOf: r.id,
              })
            } else if (r.kind === "edited") {
              db.run(
                "UPDATE memory SET text = ?, updated_at = ? WHERE id = ?",
                r.old_text,
                Date.now(),
                r.memory_id,
              )
              undoRow = log({
                workflowId: r.workflow_id,
                memoryId: r.memory_id,
                actor: "undo",
                kind: "edited",
                source: r.source,
                oldText: r.new_text,
                newText: r.old_text,
                undoOf: r.id,
              })
            } else {
              const now = Date.now()
              db.run(
                `INSERT INTO memory (id, workflow_id, text, source, task_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
                r.memory_id,
                r.workflow_id,
                r.old_text ?? "",
                r.source,
                now,
                now,
              )
              undoRow = log({
                workflowId: r.workflow_id,
                memoryId: r.memory_id,
                actor: "undo",
                kind: "added",
                source: r.source,
                oldText: null,
                newText: r.old_text,
                undoOf: r.id,
              })
            }
            // The undone row says so. When the row that is undone was itself an undo, the row that
            // it undid has its effect again, so it is no longer undone.
            db.run("UPDATE memory_history SET undone_by = ? WHERE id = ?", undoRow, r.id)
            if (r.undo_of)
              db.run("UPDATE memory_history SET undone_by = NULL WHERE id = ?", r.undo_of)
            // An item that a proposal made: the row of the proposal in the change log shows the
            // same result (spec 002, "Undo"; each place shows the result of the other). The item
            // is gone: the proposal is Undone. The item is back, after the undo of an undo: the
            // proposal is Applied again.
            const made = db.all<{ id: string; state: string; new_text: string | null }>(
              `SELECT id, state, new_text FROM proposal
               WHERE kind = 'memory' AND state IN ('applied', 'undone')
                 AND json_extract(applied, '$.memoryId') = ?`,
              r.memory_id,
            )
            const item = itemRow(r.memory_id)
            for (const p of made) {
              if (item === undefined && p.state === "applied")
                db.run(
                  "UPDATE proposal SET state = 'undone', undone_at = ? WHERE id = ?",
                  Date.now(),
                  p.id,
                )
              else if (item !== undefined && p.state === "undone" && item.text === p.new_text)
                db.run("UPDATE proposal SET state = 'applied', undone_at = NULL WHERE id = ?", p.id)
            }
          })
          changed(r.workflow_id)
          bus.emit("proposals.changed", { workflowId: r.workflow_id })
        })

      return Memory.of({
        state: (workflowId, search) =>
          need(workflowId).pipe(Effect.map(() => stateOf(workflowId, search))),
        history: (workflowId) =>
          Effect.gen(function* () {
            yield* need(workflowId)
            trim(workflowId)
            return db
              .all<HistoryRow>(
                "SELECT * FROM memory_history WHERE workflow_id = ? ORDER BY at DESC, rowid DESC",
                workflowId,
              )
              .map(toHistory)
          }),
        add,
        update,
        remove,
        undo,
        setEnabled: (workflowId, enabled) =>
          Effect.gen(function* () {
            yield* need(workflowId)
            db.run(
              "UPDATE workflow SET memory_enabled = ?, updated_at = ? WHERE id = ?",
              enabled ? 1 : 0,
              Date.now(),
              workflowId,
            )
            changed(workflowId)
            return stateOf(workflowId)
          }),
        setMode: (workflowId, mode) =>
          Effect.gen(function* () {
            yield* need(workflowId)
            db.run(
              "UPDATE workflow SET memory_mode = ?, updated_at = ? WHERE id = ?",
              mode,
              Date.now(),
              workflowId,
            )
            changed(workflowId)
            return stateOf(workflowId)
          }),
        insert: (workflowId, text, author) =>
          need(workflowId).pipe(Effect.map(() => insertItem(workflowId, text, author))),
        known,
        search: (workflowId, query) =>
          Effect.gen(function* () {
            yield* need(workflowId)
            const all = db
              .all<ItemRow>(
                "SELECT * FROM memory WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC",
                workflowId,
              )
              .map(toItem)
            const picked = selectForRead(all, query)
            return { items: picked.items, more: picked.more, total: all.length }
          }),
        ofTask: (taskId) => {
          const events: TaskMemoryEvent[] = []
          for (const r of db.all<ItemRow>(
            "SELECT * FROM memory WHERE task_id = ? ORDER BY created_at, rowid",
            taskId,
          )) {
            const h = db.get<HistoryRow>(
              "SELECT * FROM memory_history WHERE memory_id = ? AND kind = 'added' AND actor = 'node' ORDER BY at, rowid LIMIT 1",
              r.id,
            )
            events.push({
              kind: "saved",
              text: r.text,
              historyId: h?.id ?? null,
              canUndo: h ? toHistory(h).canUndo : false,
              proposalId: null,
            })
          }
          for (const p of db.all<{ id: string; new_text: string }>(
            "SELECT id, new_text FROM proposal WHERE task_id = ? AND kind = 'memory' ORDER BY created_at, rowid",
            taskId,
          ))
            events.push({
              kind: "suggested",
              text: p.new_text,
              historyId: null,
              canUndo: false,
              proposalId: p.id,
            })
          return events
        },
        settings: (workflowId) => {
          const w = workflowRow(workflowId)
          return w
            ? {
                enabled: w.memory_enabled === 1,
                mode: w.memory_mode,
                selfImprovement: w.self_improvement === 1,
              }
            : null
        },
      })
    }),
  )
}
