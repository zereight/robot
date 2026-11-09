import { randomUUID } from "node:crypto"
import {
  checkRuleInput,
  isAbsoluteRulePath,
  isRuleDecision,
  isRuleKind,
  type MatchEnv,
  normalizeHost,
  type PermissionRule,
  RULE_SOURCES,
  RULE_TEXT_MAX,
  RULES_MAX,
  type RuleDecision,
  type RuleInput,
  type RuleSource,
  type RuleStep,
  type RuleVerdict,
  ruleInputOfStep,
  ruleSameKey,
  ruleVerdict,
  SECRET_METHODS,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { realOf } from "./realPath.ts"

export interface RuleFilter {
  /** One workflow, or `null` for the rules that are for all workflows. Left out: every rule. */
  readonly workflowId?: string | null
  readonly decision?: RuleDecision
}

export interface RulesService {
  /** The rules of this computer, newest first. */
  list(filter?: RuleFilter): Effect.Effect<readonly PermissionRule[]>
  get(id: string): PermissionRule | null
  /** Adds a rule from the rules list. Refused when it equals a rule that exists, or at 500 rules. */
  add(input: RuleInput): Effect.Effect<PermissionRule, AppError>
  update(id: string, input: RuleInput): Effect.Effect<PermissionRule, AppError>
  remove(id: string): Effect.Effect<void>
  /**
   * What the rules say about a step of a workflow (spec 007, "Permission rules"): a Deny rule, a rule
   * that cannot be read, an Allow rule, or nothing. The rules of the workflow and the rules for all
   * workflows count.
   */
  verdict(workflowId: string, step: RuleStep): RuleVerdict
  /**
   * "Always allow for this workflow": saves an Allow rule that is not wider than the step. Returns
   * the rule, or null when none could be saved: the text is over the limit, or the server holds
   * 500 rules. A rule that exists already is returned and not made again.
   */
  saveFromCard(workflowId: string, step: RuleStep): PermissionRule | null
  /** True when a card for this step can offer "Always allow": the rule would fit. */
  canSave(workflowId: string, step: RuleStep): boolean
  /**
   * Deletes the rules for the tools of a connection, when the connection is removed (spec 018).
   * The names of connections match with case ignored, as a rule does.
   */
  removeForConnection(name: string): void
  /** The rules for the tools of a connection follow its new name (spec 018, "Edit"). */
  renameConnection(from: string, to: string): void
  /**
   * The permission rules of 007 that name a saved secret or login follow its new name
   * (spec 020, "Rename"): a Deny rule still stops the renamed row, and the old name keeps no
   * rule. Only the rules of this workflow move. The names match with case ignored, as a rule
   * does.
   */
  renameSecret(workflowId: string, from: string, to: string): void
}

interface Row {
  id: string
  server_id: string
  workflow_id: string | null
  kind: string
  match_text: string
  detail: string | null
  decision: string
  source: string
  created_at: number
}

const SELECT = "SELECT * FROM permission_rule"

/**
 * Reads a row. A rule that the app cannot read keeps its text and date, and shows no kind or
 * decision that is not known. It allows and denies nothing (spec 007).
 */
export const readRule = (r: Row): PermissionRule => {
  const kind = isRuleKind(r.kind) ? r.kind : null
  const decision = isRuleDecision(r.decision) ? r.decision : null
  const source = (RULE_SOURCES as readonly string[]).includes(r.source)
    ? (r.source as RuleSource)
    : null
  const textOk = r.match_text.length > 0 && [...r.match_text].length <= RULE_TEXT_MAX
  let shape = false
  if (kind && textOk) {
    switch (kind) {
      case "file":
        shape = isAbsoluteRulePath(r.match_text) && !r.match_text.startsWith("~")
        break
      case "web":
        shape = normalizeHost(r.match_text) === r.match_text && !/[\s/]/.test(r.match_text)
        break
      case "secret":
        shape = r.detail === null || (SECRET_METHODS as readonly string[]).includes(r.detail)
        break
      default:
        shape = true
    }
  }
  return {
    id: r.id,
    workflowId: r.workflow_id,
    kind,
    text: r.match_text,
    detail: r.detail,
    decision,
    source,
    createdAt: r.created_at,
    readable: kind !== null && decision !== null && source !== null && shape,
  }
}

/** The rules of the app. They stay on this computer and do not sync (spec 019). */
export class Rules extends Context.Service<Rules, RulesService>()("robot/main/Rules") {
  static readonly layer = Layer.effect(
    Rules,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform
      const env: MatchEnv = {
        real: realOf,
        // macOS and Windows disks do not tell a capital letter from a small one: a Deny rule must
        // not miss a path because of the case of a letter.
        fold: process.platform !== "linux",
      }
      const changed = () => bus.emit("rules.changed", {})
      const serverId = () =>
        db.get<{ id: string }>("SELECT id FROM server WHERE kind = 'local'")?.id ?? ""

      const all = () => db.all<Row>(`${SELECT} ORDER BY created_at DESC, rowid DESC`).map(readRule)

      /** Checks and keeps one rule. `id` is the rule that an edit replaces. */
      const keep = (
        input: RuleInput,
        source: RuleSource,
        id?: string,
      ): { rule: PermissionRule } | { code: string } => {
        const checked = checkRuleInput(input, platform.homeDir)
        if (!checked.ok) return { code: checked.code }
        const value = checked.value
        if (
          value.workflowId !== null &&
          !db.get("SELECT 1 AS x FROM workflow WHERE id = ?", value.workflowId)
        )
          return { code: "rule_workflow_gone" }
        const key = ruleSameKey(value)
        for (const rule of all()) {
          if (
            rule.id !== id &&
            rule.readable &&
            rule.kind !== null &&
            rule.decision !== null &&
            ruleSameKey({ ...rule, kind: rule.kind, decision: rule.decision }) === key
          )
            return { code: "rule_duplicate" }
        }
        if (id === undefined) {
          const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permission_rule")?.n ?? 0
          if (count >= RULES_MAX) return { code: "rules_full" }
          const made = randomUUID()
          db.run(
            `INSERT INTO permission_rule (id, server_id, workflow_id, kind, match_text, detail, decision, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            made,
            serverId(),
            value.workflowId,
            value.kind,
            value.text,
            value.detail,
            value.decision,
            source,
            Date.now(),
          )
          changed()
          return { rule: readRule(db.get<Row>(`${SELECT} WHERE id = ?`, made) as Row) }
        }
        if (!db.get("SELECT 1 AS x FROM permission_rule WHERE id = ?", id))
          return { code: "rule_not_found" }
        db.run(
          `UPDATE permission_rule SET workflow_id = ?, kind = ?, match_text = ?, detail = ?, decision = ?
           WHERE id = ?`,
          value.workflowId,
          value.kind,
          value.text,
          value.detail,
          value.decision,
          id,
        )
        changed()
        return { rule: readRule(db.get<Row>(`${SELECT} WHERE id = ?`, id) as Row) }
      }

      const get = (id: string) => {
        const row = db.get<Row>(`${SELECT} WHERE id = ?`, id)
        return row ? readRule(row) : null
      }

      const verdict = (workflowId: string, step: RuleStep): RuleVerdict => {
        const rows = db.all<Row>(
          `${SELECT} WHERE workflow_id = ?1
              OR (workflow_id IS NULL AND server_id = (SELECT server_id FROM workflow WHERE id = ?1))
           ORDER BY created_at DESC, rowid DESC`,
          workflowId,
        )
        return ruleVerdict(rows.map(readRule), workflowId, step, env)
      }

      /** The rule that equals this input, or null. */
      const sameAs = (input: RuleInput): PermissionRule | null => {
        const checked = checkRuleInput(input, platform.homeDir)
        if (!checked.ok) return null
        const key = ruleSameKey(checked.value)
        return (
          all().find(
            (r) =>
              r.readable &&
              r.kind !== null &&
              r.decision !== null &&
              ruleSameKey({ ...r, kind: r.kind, decision: r.decision }) === key,
          ) ?? null
        )
      }

      const canSave = (workflowId: string, step: RuleStep): boolean => {
        const input = ruleInputOfStep(workflowId, step)
        if (!input) return false
        const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permission_rule")?.n ?? 0
        // At the limit, a rule that exists already still counts as saved.
        return count < RULES_MAX || sameAs(input) !== null
      }

      /** The rules of kind connection that name this connection. */
      const connectionRules = (name: string) =>
        db
          .all<Row>(`${SELECT} WHERE kind = 'connection'`)
          .filter((r) => r.match_text.trim().toLowerCase() === name.trim().toLowerCase())

      /** The secret rules of one workflow that name this secret or login. */
      const secretRules = (workflowId: string, name: string) =>
        db
          .all<Row>(`${SELECT} WHERE kind = 'secret' AND workflow_id = ?`, workflowId)
          .filter((r) => r.match_text.trim().toLowerCase() === name.trim().toLowerCase())
      return Rules.of({
        get,
        verdict,
        canSave,
        removeForConnection: (name) => {
          const found = connectionRules(name)
          for (const rule of found) db.run("DELETE FROM permission_rule WHERE id = ?", rule.id)
          if (found.length > 0) changed()
        },
        renameConnection: (from, to) => {
          const found = connectionRules(from)
          for (const rule of found)
            db.run("UPDATE permission_rule SET match_text = ? WHERE id = ?", to, rule.id)
          if (found.length > 0) changed()
        },
        renameSecret: (workflowId, from, to) => {
          const found = secretRules(workflowId, from)
          for (const rule of found)
            db.run("UPDATE permission_rule SET match_text = ? WHERE id = ?", to, rule.id)
          if (found.length > 0) changed()
        },
        list: (filter = {}) =>
          Effect.sync(() =>
            all().filter(
              (r) =>
                (filter.workflowId === undefined || r.workflowId === filter.workflowId) &&
                (filter.decision === undefined || r.decision === filter.decision),
            ),
          ),
        add: (input) =>
          Effect.gen(function* () {
            const made = keep(input, "list")
            if ("code" in made) return yield* new AppError({ code: made.code })
            return made.rule
          }),
        update: (id, input) =>
          Effect.gen(function* () {
            const made = keep(input, "list", id)
            if ("code" in made) return yield* new AppError({ code: made.code })
            return made.rule
          }),
        remove: (id) =>
          Effect.sync(() => {
            db.run("DELETE FROM permission_rule WHERE id = ?", id)
            changed()
          }),
        saveFromCard: (workflowId, step) => {
          const input = ruleInputOfStep(workflowId, step)
          if (!input) return null
          const made = keep(input, "card")
          if ("rule" in made) return made.rule
          if (made.code !== "rule_duplicate") return null
          return sameAs(input)
        },
      })
    }),
  )
}
