import {
  holdEnd,
  type MessagePart,
  type ModelPick,
  type TaskBackupNote,
  type WorkflowNode,
} from "@robot/shared"
import type { ToolEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import type { DatabaseService } from "./Database.ts"
import { holdClock, type ModelHoldsService } from "./ModelHolds.ts"

/**
 * The backup model of a text node during a task (spec 006, "Backup model"). The engine (`Runs.ts`)
 * calls these functions. Everything that the spec says about the backup is here, so that the
 * optional backup model can be taken out in one place (docs/spec-questions.md, B6).
 *
 * What the spec does not say is not decided here: a failure that is not a limit reason (a key that
 * is not valid, a model that does not exist, a request that the provider refuses, a busy provider
 * after its tries) never moves a turn to the backup.
 */

export interface BackupDeps {
  readonly holds: ModelHoldsService
  /**
   * The backup is ready on this computer: it has the account, the account is connected and, for a
   * program, Ready (spec 006).
   */
  readonly ready: (accountId: string) => Promise<boolean>
}

/** The backup model that a node uses. A decision node has none: it names the decision model. */
export const backupOf = (node: WorkflowNode): ModelPick | null =>
  node.kind === "text" ? node.backup : null

/**
 * True when the turn starts on the backup model: the node has one, the hold of its main model lasts,
 * and the backup is ready. When the backup is not ready, the hold ends at once, and the turn tries
 * the main model (spec 006).
 */
export const startsOnBackup = async (deps: BackupDeps, node: WorkflowNode): Promise<boolean> => {
  const backup = backupOf(node)
  if (backup === null || deps.holds.active(node.id, backup) === null) return false
  if (await deps.ready(backup.accountId)) return true
  deps.holds.clear(node.id)
  return false
}

/** What a switch to the backup came to. */
export interface BackupSwitch {
  readonly backup: ModelPick
  /** False when the user ended the hold of the same limit by hand: the task view shows no line. */
  readonly fresh: boolean
  /** The reset time that the provider named, when it is in the future. */
  readonly resetsAt: number | null
}

/**
 * A turn on the main model failed. When the failure is a limit reason, and the node has a backup that
 * is ready, the main model is held until the reset time (15 minutes when the provider names none)
 * and the answer says that the turn goes on with the backup. Otherwise null: the turn fails as a
 * turn with no backup does. A limit of the backup itself is no switch either (`onBackup`).
 */
export const limitSwitch = async (
  deps: BackupDeps,
  node: WorkflowNode,
  error: unknown,
  onBackup: boolean,
): Promise<BackupSwitch | null> => {
  const backup = backupOf(node)
  if (
    backup === null ||
    onBackup ||
    !(error instanceof ProviderFailure) ||
    error.code !== "provider_limit"
  )
    return null
  if (!(await deps.ready(backup.accountId))) return null
  const now = holdClock.now()
  const { fresh } = deps.holds.start(node.id, backup, holdEnd(now, error.resetsAt))
  return {
    backup,
    fresh,
    resetsAt: error.resetsAt !== undefined && error.resetsAt > now ? error.resetsAt : null,
  }
}

/**
 * The main model answered. A limit that the user ended by hand is over, so the next limit is a new
 * one and shows its line (spec 006).
 */
export const mainAnswered = (deps: BackupDeps, node: WorkflowNode) => {
  if (backupOf(node) !== null && deps.holds.stored(node.id)?.released === true)
    deps.holds.clear(node.id)
}

/** The line "<main model> reached its limit. <backup model> goes on." for a task, as it is stored. */
export const noteOf = (main: string, switched: BackupSwitch): TaskBackupNote => ({
  main,
  backup: switched.backup.model,
  resetsAt: switched.resetsAt,
})

export const writeNote = (db: DatabaseService, taskId: string, note: TaskBackupNote) =>
  db.run("UPDATE task SET backup_note = ? WHERE id = ?", JSON.stringify(note), taskId)

export const readNote = (json: string | null): TaskBackupNote | null => {
  if (json === null) return null
  try {
    const note = JSON.parse(json) as Partial<TaskBackupNote>
    return typeof note.main === "string" && typeof note.backup === "string"
      ? {
          main: note.main,
          backup: note.backup,
          resetsAt: typeof note.resetsAt === "number" ? note.resetsAt : null,
        }
      : null
  } catch {
    return null
  }
}

/**
 * The work of one try of a turn, as parts of a reply: the text and each step. The backup model that
 * goes on after a try that ran steps reads it (spec 006).
 */
export const workLog = () => {
  let parts: MessagePart[] = []
  return {
    reset: () => {
      parts = []
    },
    text: (text: string) => {
      const last = parts.at(-1)
      if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + text }
      else parts.push({ kind: "text", text })
    },
    tool: (event: ToolEvent) => {
      const at = parts.findIndex((p) => p.kind === "tool" && p.id === event.call.id)
      const part: MessagePart = {
        kind: "tool",
        id: event.call.id,
        name: event.call.name,
        label: "",
        state: event.state,
        input: event.call.input,
        output: event.state === "running" ? "" : event.output,
      }
      if (at >= 0) parts[at] = part
      else parts.push(part)
    },
    parts: (): readonly MessagePart[] => parts,
  }
}

/**
 * Adds what a unit of work spent to the row of the model that made it (spec 006: the usage page
 * counts the tokens for the model that made them). A field that the provider did not report stays
 * NULL, it is not 0 (spec 005).
 */
export const addModelUsage = (
  db: DatabaseService,
  taskId: string,
  pick: { readonly accountId: string; readonly model: string },
  spent: {
    readonly input?: number
    readonly output?: number
    readonly cached?: number
    readonly costMicros?: number
  },
) => {
  const sum = (column: string) =>
    `${column} = CASE WHEN excluded.${column} IS NULL THEN task_usage.${column}
       WHEN task_usage.${column} IS NULL THEN excluded.${column}
       ELSE task_usage.${column} + excluded.${column} END`
  db.run(
    `INSERT INTO task_usage (task_id, account_id, model, input_tokens, output_tokens, cached_tokens, cost_micros)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, account_id, model) DO UPDATE SET
       ${sum("input_tokens")}, ${sum("output_tokens")}, ${sum("cached_tokens")}, ${sum("cost_micros")}`,
    taskId,
    pick.accountId,
    pick.model,
    spent.input ?? null,
    spent.output ?? null,
    spent.cached ?? null,
    spent.costMicros ?? null,
  )
}

/** The tokens of a task for each model that made them, oldest row first. */
export const modelUsageOf = (db: DatabaseService, taskId: string) =>
  db
    .all<{
      account_id: string
      model: string
      input_tokens: number | null
      output_tokens: number | null
      cached_tokens: number | null
      cost_micros: number | null
    }>(
      `SELECT account_id, model, input_tokens, output_tokens, cached_tokens, cost_micros
       FROM task_usage WHERE task_id = ? ORDER BY rowid`,
      taskId,
    )
    .map((r) => ({
      accountId: r.account_id,
      model: r.model,
      input: r.input_tokens,
      output: r.output_tokens,
      cached: r.cached_tokens,
      costMicros: r.cost_micros,
    }))
