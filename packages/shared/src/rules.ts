import { SECRET_METHODS, secretNameKey } from "./secrets.ts"
import { insideWorkspace, needsApproval, type PermissionLevel } from "./tools.ts"

/**
 * Permission rules (spec 007, "Permission rules"). A rule is a decision that the user keeps: an
 * agent (or all agents), a kind of step, a match text, and Allow or Deny. This file holds the
 * words of a rule, how a rule matches a step, and the order in which the decisions come. The
 * database and the window use it; it has no code of Node, so it also runs in the window.
 */

/** The steps that have rules. Browser steps, computer use and changes of own settings have none. */
export const RULE_KINDS = ["file", "shell", "web", "connection", "secret"] as const
export type RuleKind = (typeof RULE_KINDS)[number]

export const RULE_DECISIONS = ["allow", "deny"] as const
export type RuleDecision = (typeof RULE_DECISIONS)[number]

/** Where a rule came from: an approval card, or the rules list. */
export const RULE_SOURCES = ["card", "list"] as const
export type RuleSource = (typeof RULE_SOURCES)[number]

/** The match text holds 1 to 500 characters. */
export const RULE_TEXT_MAX = 500
/** A server holds at most this many rules. */
export const RULES_MAX = 500

export const isRuleKind = (v: unknown): v is RuleKind =>
  typeof v === "string" && (RULE_KINDS as readonly string[]).includes(v)
export const isRuleDecision = (v: unknown): v is RuleDecision => v === "allow" || v === "deny"

/**
 * One rule as the window sees it. Two kinds have a second part, `detail`: a tool of a connection
 * has the name of the tool, and a request with a saved secret has the method. `null` means "any
 * tool" or "any method". Every other kind has `null`.
 *
 * A rule that the app cannot read has `readable: false`. It allows and denies nothing, and the
 * fields that could not be read are `null`.
 */
export interface PermissionRule {
  readonly id: string
  /** The agent the rule is for, or `null` for all agents. */
  readonly workflowId: string | null
  readonly kind: RuleKind | null
  readonly text: string
  readonly detail: string | null
  readonly decision: RuleDecision | null
  readonly source: RuleSource | null
  readonly createdAt: number
  readonly readable: boolean
}

/** What a rule needs to match: the same fields as a rule, whether or not it is stored. */
export type RuleBody = Pick<PermissionRule, "kind" | "text" | "detail">

/** What the log keeps of the rule that decided a step. It outlives the rule. */
export interface RuleRef {
  readonly id: string
  readonly kind: RuleKind
  readonly text: string
  readonly detail: string | null
}

/** A rule that the user adds or edits in the rules list. */
export interface RuleInput {
  /** The agent the rule is for, or `null` for all agents. */
  readonly workflowId: string | null
  readonly kind: RuleKind
  readonly text: string
  /** The tool or the method. `null` is any tool or any method. Left out for other kinds. */
  readonly detail?: string | null
  readonly decision: RuleDecision
}

/** The step that rules look at. A path is absolute. */
export type RuleStep =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "web"; readonly host: string }
  | { readonly kind: "connection"; readonly connection: string; readonly tool: string }
  | { readonly kind: "secret"; readonly name: string; readonly method: string }

// ---------------------------------------------------------------------------------------------
// The words of a rule
// ---------------------------------------------------------------------------------------------

/** Folds `.` and `..` away. The result has no trailing slash, and "/" is the root. */
const cleanPath = (path: string): string => {
  const out: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return `/${out.join("/")}`
}

/** True when the text starts a path that does not depend on the folder of the agent. */
export const isAbsoluteRulePath = (text: string) =>
  text.startsWith("/") || text === "~" || text.startsWith("~/")

/** The host of a rule or of a step: lower case, no brackets of an IPv6 address, no final dot. */
export const normalizeHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")

const IPV6 = /^[0-9a-f:.]+$/

/**
 * A host that a rule can hold: a name or an address with no port, path or space. An address in a
 * web link is cut to its host.
 */
const hostOfRule = (text: string): string | null => {
  let value = text.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname
    } catch {
      return null
    }
  }
  const host = normalizeHost(value)
  if (!host || /[\s/?#@\\]/.test(host)) return null
  if (host.includes(":") && !(host.split(":").length > 2 && IPV6.test(host))) return null
  return host
}

export type RuleProblem =
  | "rule_text_invalid"
  | "rule_path_relative"
  | "rule_host_invalid"
  | "rule_method_invalid"

export type RuleCheck =
  | { readonly ok: true; readonly value: Required<RuleInput> }
  | { readonly ok: false; readonly code: RuleProblem }

/**
 * Checks a rule that the user typed, and writes it the way it is kept. `home` is the home folder,
 * for a path that starts with `~`. A rule holds 1 to 500 characters of match text.
 */
export const checkRuleInput = (input: RuleInput, home = ""): RuleCheck => {
  let text = input.text.trim()
  if (!text || [...text].length > RULE_TEXT_MAX) return { ok: false, code: "rule_text_invalid" }
  let detail: string | null = null
  switch (input.kind) {
    case "file": {
      if (!isAbsoluteRulePath(text)) return { ok: false, code: "rule_path_relative" }
      if (text === "~" || text.startsWith("~/")) {
        if (!home) return { ok: false, code: "rule_path_relative" }
        text = `${home.replace(/\/+$/, "")}${text.slice(1)}`
      }
      text = cleanPath(text)
      break
    }
    case "shell":
      break
    case "web": {
      const host = hostOfRule(text)
      if (!host) return { ok: false, code: "rule_host_invalid" }
      text = host
      break
    }
    case "connection": {
      const tool = input.detail?.trim() ?? null
      if (tool !== null && (!tool || [...tool].length > RULE_TEXT_MAX))
        return { ok: false, code: "rule_text_invalid" }
      detail = tool
      break
    }
    case "secret": {
      const method = input.detail?.trim().toUpperCase() ?? null
      if (method !== null && !(SECRET_METHODS as readonly string[]).includes(method))
        return { ok: false, code: "rule_method_invalid" }
      detail = method
      break
    }
  }
  if ([...text].length > RULE_TEXT_MAX) return { ok: false, code: "rule_text_invalid" }
  return {
    ok: true,
    value: {
      workflowId: input.workflowId,
      kind: input.kind,
      text,
      detail,
      decision: input.decision,
    },
  }
}

/**
 * The key that makes two rules the same (spec 007): the agent, the kind, the match text and the
 * decision. Names of connections and of secrets and hosts do not depend on the case of letters.
 */
export const ruleSameKey = (rule: {
  workflowId: string | null
  kind: RuleKind
  text: string
  detail: string | null
  decision: RuleDecision
}): string => {
  const folded = rule.kind === "connection" || rule.kind === "secret"
  return [
    rule.workflowId ?? "*",
    rule.kind,
    folded ? secretNameKey(rule.text) : rule.kind === "web" ? normalizeHost(rule.text) : rule.text,
    rule.detail ?? "*",
    rule.decision,
  ].join("\u0000")
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

export interface MatchEnv {
  /** The real path of a path, so that a link cannot reach a place that no rule names. */
  readonly real: (path: string) => string
  /** True when the disk does not tell "A" from "a" (macOS and Windows). */
  readonly fold: boolean
}

/** True when `step` is at `rule`, or inside it. */
const pathMatches = (rule: string, step: string, env: MatchEnv): boolean => {
  const fold = (x: string) => (env.fold ? x.toLowerCase() : x)
  return insideWorkspace(fold(cleanPath(env.real(step))), fold(cleanPath(env.real(rule))))
}

/**
 * True when the text of a rule matches a command: the two are equal, or the command begins with
 * the rule text and a space (spec 007).
 */
export const commandMatches = (rule: string, command: string): boolean => {
  const text = rule.trim()
  const line = command.trim()
  if (!text) return false
  return line === text || (line.startsWith(text) && /[ \t]/.test(line.charAt(text.length)))
}

/**
 * True when a command can start another command or write to a file: `;`, `&`, `|`, a redirect, a
 * new line, a backtick, or `$(`. A quote does not hide them here, so the check is stricter than a
 * shell.
 */
export const chainsCommands = (command: string): boolean => /[;&|<>`\n\r]|\$[({]/.test(command)

/**
 * Whether the text of a rule matches a step, as spec 007 says:
 * - files: real paths; a folder matches itself and everything inside it,
 * - shell command: equal, or the command begins with the rule text and a space,
 * - web page: the host only (`example.com` is not `www.example.com`),
 * - tool of a connection: the connection and the tool, or the connection and any tool,
 * - request with a saved secret: the secret and the method, or the secret and any method.
 */
export const ruleMatches = (rule: RuleBody, step: RuleStep, env: MatchEnv): boolean => {
  if (rule.kind !== step.kind) return false
  switch (step.kind) {
    case "file":
      return pathMatches(rule.text, step.path, env)
    case "shell":
      return commandMatches(rule.text, step.command)
    case "web":
      return normalizeHost(rule.text) === normalizeHost(step.host)
    case "connection":
      return (
        secretNameKey(rule.text.trim()) === secretNameKey(step.connection.trim()) &&
        (rule.detail === null || rule.detail === step.tool)
      )
    case "secret":
      return (
        secretNameKey(rule.text.trim()) === secretNameKey(step.name.trim()) &&
        (rule.detail === null || rule.detail.toUpperCase() === step.method.toUpperCase())
      )
  }
}

/**
 * Whether an Allow rule lets the step run. It matches as `ruleMatches` says, with one more
 * limit: a rule that only begins the command does not cover a command that goes on to start
 * another command or to write a file. `ls` allows `ls -la`, and does not allow `ls; rm -rf ~`.
 * A Deny rule has no such limit: it matches every command that it names.
 */
export const allowApplies = (rule: RuleBody, step: RuleStep, env: MatchEnv): boolean => {
  if (!ruleMatches(rule, step, env)) return false
  if (step.kind === "shell" && step.command.trim() !== rule.text.trim())
    return !chainsCommands(step.command)
  return true
}

// ---------------------------------------------------------------------------------------------
// The order of the decisions
// ---------------------------------------------------------------------------------------------

/**
 * What the rules say about a step:
 * - `deny`: a Deny rule matches,
 * - `unreadable`: a rule that the app cannot read meets the step,
 * - `allow`: an Allow rule matches,
 * - `none`: no rule meets the step.
 * When several rules meet the step, the first of these wins, in this order.
 */
export type RuleVerdict =
  | { readonly kind: "deny"; readonly rule: RuleRef }
  | { readonly kind: "unreadable"; readonly rule: RuleRef }
  | { readonly kind: "allow"; readonly rule: RuleRef }
  | { readonly kind: "none" }

const refOf = (rule: PermissionRule, kind: RuleKind): RuleRef => ({
  id: rule.id,
  kind,
  text: rule.text,
  detail: rule.detail,
})

/**
 * The verdict of the rules for one step of one agent (spec 007). `rules` are the rules that can
 * apply to the agent: its own and those for all agents. A Deny rule wins over everything. A rule
 * that cannot be read does not allow or deny, but a step that meets it asks the user; it comes
 * before an Allow rule, because the rule might have been a Deny rule.
 *
 * A rule whose kind cannot be read meets no step: the app cannot tell what it names. A rule with
 * a kind and a text but no readable decision meets the steps that its text names.
 */
export const ruleVerdict = (
  rules: readonly PermissionRule[],
  workflowId: string,
  step: RuleStep,
  env: MatchEnv,
): RuleVerdict => {
  let allow: RuleRef | null = null
  let unreadable: RuleRef | null = null
  for (const rule of rules) {
    if (rule.workflowId !== null && rule.workflowId !== workflowId) continue
    if (!rule.readable) {
      if (isRuleKind(rule.kind) && ruleMatches(rule as RuleBody, step, env) && !unreadable)
        unreadable = refOf(rule, rule.kind)
      continue
    }
    if (!isRuleKind(rule.kind) || !isRuleDecision(rule.decision)) continue
    if (rule.decision === "deny") {
      if (ruleMatches(rule, step, env)) return { kind: "deny", rule: refOf(rule, rule.kind) }
    } else if (!allow && allowApplies(rule, step, env)) allow = refOf(rule, rule.kind)
  }
  if (unreadable) return { kind: "unreadable", rule: unreadable }
  return allow ? { kind: "allow", rule: allow } : { kind: "none" }
}

/** What a step does after the level "Read only" let it pass (spec 007, "Permission rules"). */
export type RuleOutcome = "refuse_rule" | "ask_unreadable" | "allow_rule" | "run" | "ask"

/**
 * The order of the decisions for a step that "Read only" let pass:
 * 1. a matching Deny rule refuses it, at every level,
 * 2. a rule that cannot be read asks the user, also at "Full access",
 * 3. a matching Allow rule lets it run with no question,
 * 4. the permission level decides.
 * A guarded step in a turn that holds outside content, and a step that sends data out in a turn
 * that holds a sensitive read, ask first and do not come here for an Allow rule (spec 007).
 */
export const ruleOutcome = (input: {
  readonly level: PermissionLevel
  readonly risky: boolean
  readonly verdict: RuleVerdict
}): RuleOutcome => {
  switch (input.verdict.kind) {
    case "deny":
      return "refuse_rule"
    case "unreadable":
      return "ask_unreadable"
    case "allow":
      return "allow_rule"
    case "none":
      return needsApproval(input.level, input.risky) ? "ask" : "run"
  }
}

/**
 * The step that "Always allow for this agent" turns into a rule, or null when the rule would not
 * fit: the text is longer than the limit. The rule is not wider than the step: the same command
 * text, the same path, the same host, the same tool.
 */
export const ruleInputOfStep = (workflowId: string, step: RuleStep): RuleInput | null => {
  const base = { workflowId, decision: "allow" } as const
  let input: RuleInput
  switch (step.kind) {
    case "file":
      input = { ...base, kind: "file", text: step.path }
      break
    case "shell":
      input = { ...base, kind: "shell", text: step.command }
      break
    case "web":
      input = { ...base, kind: "web", text: step.host }
      break
    case "connection":
      input = { ...base, kind: "connection", text: step.connection, detail: step.tool }
      break
    case "secret":
      input = { ...base, kind: "secret", text: step.name, detail: step.method.toUpperCase() }
      break
  }
  const checked = checkRuleInput(input)
  return checked.ok ? checked.value : null
}

/** The kind of a step in the action log: the log calls a secret request by its own name. */
export const ruleKindOfLogKind = (kind: string): RuleKind | null =>
  kind === "secret_request" ? "secret" : isRuleKind(kind) ? kind : null
