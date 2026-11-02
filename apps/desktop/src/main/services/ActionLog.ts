import { randomUUID } from "node:crypto"
import {
  ACTION_LOG_DAYS,
  ACTION_LOG_MAX,
  ACTION_TARGET_MAX,
  type ActionDecider,
  type ActionLogEntry,
  type ActionResult,
  type GuardedStep,
  isOutsideSource,
  type OutsideSource,
  redactSecrets,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

/** What a step adds to the log. The service adds the time, the name of the agent and the id. */
export interface ActionLogInput {
  readonly agentId: string
  readonly kind: GuardedStep
  readonly target: string
  readonly decidedBy: ActionDecider
  readonly result: ActionResult
  readonly taskId: string | null
  readonly outside: OutsideSource | null
}

export interface ActionLogFilter {
  readonly agentId?: string
  readonly result?: ActionResult
}

export interface ActionLogService {
  /** Adds an entry, and removes entries older than 90 days and over 100000, the oldest first. */
  add(input: ActionLogInput): ActionLogEntry
  /** The entries, newest first, at most `limit`. */
  list(filter?: ActionLogFilter, limit?: number): Effect.Effect<readonly ActionLogEntry[]>
}

interface Row {
  id: string
  at: number
  agent_id: string
  agent_name: string
  kind: GuardedStep
  target: string
  decided_by: ActionDecider
  result: ActionResult
  task_id: string | null
  outside: string | null
}

const parseOutside = (text: string | null): OutsideSource | null => {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return isOutsideSource(value) ? value : null
  } catch {
    return null
  }
}

const toEntry = (r: Row): ActionLogEntry => ({
  id: r.id,
  at: r.at,
  agentId: r.agent_id,
  agentName: r.agent_name,
  kind: r.kind,
  target: r.target,
  decidedBy: r.decided_by,
  result: r.result,
  taskId: r.task_id,
  outside: parseOutside(r.outside),
})

/** The target as the log keeps it: secrets hidden, then cut at 200 characters. */
export const logTarget = (text: string) => {
  const clean = redactSecrets(text.replace(/\s+/g, " ").trim())
  return clean.length > ACTION_TARGET_MAX ? `${clean.slice(0, ACTION_TARGET_MAX - 1)}…` : clean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The action log of spec 007. It stays on this computer. */
export class ActionLog extends Context.Service<ActionLog, ActionLogService>()(
  "robot/main/ActionLog",
) {
  static readonly layer = Layer.effect(
    ActionLog,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      return ActionLog.of({
        add: (input) => {
          const id = randomUUID()
          const at = Date.now()
          const name =
            db.get<{ name: string }>("SELECT name FROM agent WHERE id = ?", input.agentId)?.name ??
            ""
          db.run(
            `INSERT INTO action_log (id, at, agent_id, agent_name, kind, target, decided_by, result, task_id, outside)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            at,
            input.agentId,
            name,
            input.kind,
            logTarget(input.target),
            input.decidedBy,
            input.result,
            input.taskId,
            input.outside ? JSON.stringify(input.outside) : null,
          )
          db.run("DELETE FROM action_log WHERE at < ?", at - ACTION_LOG_DAYS * DAY_MS)
          db.run(
            `DELETE FROM action_log WHERE rowid IN (
               SELECT rowid FROM action_log ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
            ACTION_LOG_MAX,
          )
          bus.emit("actionLog.changed", {})
          return toEntry(db.get<Row>("SELECT * FROM action_log WHERE id = ?", id) as Row)
        },
        list: (filter = {}, limit = 500) =>
          Effect.sync(() => {
            const where: string[] = []
            const params: (string | number)[] = []
            if (filter.agentId) {
              where.push("agent_id = ?")
              params.push(filter.agentId)
            }
            if (filter.result) {
              where.push("result = ?")
              params.push(filter.result)
            }
            return db
              .all<Row>(
                `SELECT * FROM action_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY at DESC, rowid DESC LIMIT ?`,
                ...params,
                Math.max(1, Math.min(limit, 1000)),
              )
              .map(toEntry)
          }),
      })
    }),
  )
}
