import { randomUUID } from "node:crypto"
import {
  ACTION_LOG_DAYS,
  ACTION_LOG_MAX,
  ACTION_TARGET_MAX,
  type ActionCheck,
  type ActionDecider,
  type ActionKind,
  type ActionLogEntry,
  type ActionResult,
  type ActionRule,
  isCheckReason,
  isOutsideSource,
  isRuleKind,
  isSensitiveLabel,
  LOGGED_KINDS,
  type OutsideSource,
  type RuleRef,
  redactSecrets,
  type SensitiveLabel,
  type StepAccess,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

/** What a step adds to the log. The service adds the time, the name of the agent and the id. */
export interface ActionLogInput {
  readonly agentId: string
  readonly kind: ActionKind
  /** For a step of a file, whether it read or wrote. Left out for every other kind. */
  readonly access?: StepAccess | null
  readonly target: string
  readonly decidedBy: ActionDecider
  readonly result: ActionResult
  readonly taskId: string | null
  readonly outside: OutsideSource | null
  /** The label of the first credential place that the turn read, or none (spec 007). */
  readonly sensitive?: SensitiveLabel | null
  /** The rule that decided the step, or the rule that could not be read (spec 007). */
  readonly rule?: RuleRef | null
  /** The check of "Ask when unsure", when the step went to the check (spec 007). */
  readonly check?: ActionCheck | null
}

export interface ActionLogFilter {
  readonly agentId?: string
  readonly result?: ActionResult
  /** The kind of step (spec 007: the log has filters for the agent, the result and the step kind). */
  readonly kind?: ActionKind
  /** A search of the target: the entries whose target holds this text, with no regard to case. */
  readonly search?: string
}

export interface ActionLogService {
  /** Adds an entry, and removes entries older than 90 days and over 100000, the oldest first. */
  add(input: ActionLogInput): ActionLogEntry
  /** The entries, newest first, at most `limit`. */
  list(filter?: ActionLogFilter, limit?: number): Effect.Effect<readonly ActionLogEntry[]>
  /**
   * The steps of a task of the four kinds of "Permission rules" (file, shell command, web page,
   * tool of a connection), oldest first. The retry note of spec 005 reads them.
   */
  ofTask(taskId: string): readonly ActionLogEntry[]
}

interface Row {
  id: string
  at: number
  agent_id: string
  agent_name: string
  kind: ActionKind
  access: StepAccess | null
  target: string
  decided_by: ActionDecider
  result: ActionResult
  task_id: string | null
  outside: string | null
  sensitive: string | null
  rule_id: string | null
  rule_kind: string | null
  rule_text: string | null
  rule_detail: string | null
  /** 1 while the rule that decided the step still exists. */
  rule_alive: number | null
  check_reason: string | null
  check_probability: number | null
}

/** The columns of an entry, and whether its rule still exists. */
const COLUMNS = `l.*, CASE WHEN l.rule_id IS NULL THEN NULL
  ELSE EXISTS (SELECT 1 FROM permission_rule r WHERE r.id = l.rule_id) END AS rule_alive`

const parseOutside = (text: string | null): OutsideSource | null => {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return isOutsideSource(value) ? value : null
  } catch {
    return null
  }
}

const toRule = (r: Row): ActionRule | null =>
  r.rule_id !== null && r.rule_text !== null && isRuleKind(r.rule_kind)
    ? {
        id: r.rule_id,
        kind: r.rule_kind,
        text: r.rule_text,
        detail: r.rule_detail,
        deleted: r.rule_alive !== 1,
      }
    : null

/** The check of a row: none, allowed, or sent to the user with a reason. */
const toCheck = (r: Row): ActionCheck | null => {
  if (r.check_reason === null) return null
  if (r.check_reason === "allowed")
    return { allowed: true, probability: r.check_probability, reason: null }
  return {
    allowed: false,
    probability: r.check_probability,
    reason: isCheckReason(r.check_reason) ? r.check_reason : "unreadable",
  }
}

const toEntry = (r: Row): ActionLogEntry => ({
  id: r.id,
  at: r.at,
  agentId: r.agent_id,
  agentName: r.agent_name,
  kind: r.kind,
  access: r.access,
  target: r.target,
  decidedBy: r.decided_by,
  result: r.result,
  taskId: r.task_id,
  outside: parseOutside(r.outside),
  sensitive: isSensitiveLabel(r.sensitive) ? r.sensitive : null,
  rule: toRule(r),
  check: toCheck(r),
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
      // The entries of the last 90 days stay, also when no step adds one (spec 007).
      db.run("DELETE FROM action_log WHERE at < ?", Date.now() - ACTION_LOG_DAYS * DAY_MS)
      return ActionLog.of({
        add: (input) => {
          const id = randomUUID()
          const at = Date.now()
          const name =
            db.get<{ name: string }>("SELECT name FROM agent WHERE id = ?", input.agentId)?.name ??
            ""
          db.run(
            `INSERT INTO action_log (id, at, agent_id, agent_name, kind, access, target, decided_by, result, task_id, outside, sensitive, rule_id, rule_kind, rule_text, rule_detail, check_reason, check_probability)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            at,
            input.agentId,
            name,
            input.kind,
            input.kind === "file" ? (input.access ?? null) : null,
            logTarget(input.target),
            input.decidedBy,
            input.result,
            input.taskId,
            input.outside ? JSON.stringify(input.outside) : null,
            input.sensitive ?? null,
            input.rule?.id ?? null,
            input.rule?.kind ?? null,
            input.rule ? logTarget(input.rule.text) : null,
            input.rule?.detail ? logTarget(input.rule.detail) : null,
            input.check
              ? input.check.allowed
                ? "allowed"
                : (input.check.reason ?? "unsure")
              : null,
            input.check?.probability ?? null,
          )
          db.run("DELETE FROM action_log WHERE at < ?", at - ACTION_LOG_DAYS * DAY_MS)
          db.run(
            `DELETE FROM action_log WHERE rowid IN (
               SELECT rowid FROM action_log ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
            ACTION_LOG_MAX,
          )
          bus.emit("actionLog.changed", {})
          return toEntry(
            db.get<Row>(`SELECT ${COLUMNS} FROM action_log l WHERE l.id = ?`, id) as Row,
          )
        },
        ofTask: (taskId) =>
          db
            .all<Row>(
              `SELECT ${COLUMNS} FROM action_log l WHERE l.task_id = ? AND l.kind IN (${LOGGED_KINDS.map(() => "?").join(", ")})
               ORDER BY l.at, l.rowid`,
              taskId,
              ...LOGGED_KINDS,
            )
            .map(toEntry),
        list: (filter = {}, limit = 500) =>
          Effect.sync(() => {
            const where: string[] = []
            const params: (string | number)[] = []
            if (filter.agentId) {
              where.push("l.agent_id = ?")
              params.push(filter.agentId)
            }
            if (filter.result) {
              where.push("l.result = ?")
              params.push(filter.result)
            }
            if (filter.kind) {
              where.push("l.kind = ?")
              params.push(filter.kind)
            }
            const search = filter.search?.trim()
            if (search) {
              where.push("l.target LIKE ? ESCAPE '\\'")
              params.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`)
            }
            return db
              .all<Row>(
                `SELECT ${COLUMNS} FROM action_log l ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY l.at DESC, l.rowid DESC LIMIT ?`,
                ...params,
                Math.max(1, Math.min(limit, 1000)),
              )
              .map(toEntry)
          }),
      })
    }),
  )
}
