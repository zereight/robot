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
  /** One agent, or `null` for the rules that are for all agents. Left out: every rule. */
  readonly agentId?: string | null
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
   * What the rules say about a step of an agent (spec 007, "Permission rules"): a Deny rule, a rule
   * that cannot be read, an Allow rule, or nothing. The rules of the agent and the rules for all
   * agents count.
   */
  verdict(agentId: string, step: RuleStep): RuleVerdict
  /**
   * "Always allow for this agent": saves an Allow rule that is not wider than the step. Returns
   * the rule, or null when none could be saved: the text is over the limit, or the server holds
   * 500 rules. A rule that exists already is returned and not made again.
   */
  saveFromCard(agentId: string, step: RuleStep): PermissionRule | null
  /** True when a card for this step can offer "Always allow": the rule would fit. */
  canSave(agentId: string, step: RuleStep): boolean
}

interface Row {
  id: string
  server_id: string
  agent_id: string | null
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
    agentId: r.agent_id,
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
          value.agentId !== null &&
          !db.get("SELECT 1 AS x FROM agent WHERE id = ?", value.agentId)
        )
          return { code: "rule_agent_gone" }
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
            `INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            made,
            serverId(),
            value.agentId,
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
          `UPDATE permission_rule SET agent_id = ?, kind = ?, match_text = ?, detail = ?, decision = ?
           WHERE id = ?`,
          value.agentId,
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

      const verdict = (agentId: string, step: RuleStep): RuleVerdict => {
        const rows = db.all<Row>(
          `${SELECT} WHERE agent_id = ?1
              OR (agent_id IS NULL AND server_id = (SELECT server_id FROM agent WHERE id = ?1))
           ORDER BY created_at DESC, rowid DESC`,
          agentId,
        )
        return ruleVerdict(rows.map(readRule), agentId, step, env)
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

      const canSave = (agentId: string, step: RuleStep): boolean => {
        const input = ruleInputOfStep(agentId, step)
        if (!input) return false
        const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permission_rule")?.n ?? 0
        // At the limit, a rule that exists already still counts as saved.
        return count < RULES_MAX || sameAs(input) !== null
      }

      return Rules.of({
        get,
        verdict,
        canSave,
        list: (filter = {}) =>
          Effect.sync(() =>
            all().filter(
              (r) =>
                (filter.agentId === undefined || r.agentId === filter.agentId) &&
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
        saveFromCard: (agentId, step) => {
          const input = ruleInputOfStep(agentId, step)
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
