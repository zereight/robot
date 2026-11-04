/**
 * The usage of a task (spec 005, "Usage of a task") and the token limit of a run of a routine
 * (spec 009, "Limits and safeguards").
 *
 * A number that the provider does not report is `null`, and the window shows "—". It is never 0.
 */

/** The tokens and the cost of a task, as the provider reports them. */
export interface TaskUsage {
  /** All input tokens. Cached input counts as input. */
  readonly input: number | null
  readonly output: number | null
  /** The part of `input` that the provider read from its cache. */
  readonly cached: number | null
  /**
   * The cost that the provider reports, in millionths of a US dollar. The app never works out a
   * cost: it has no prices (spec 005).
   */
  readonly costMicros: number | null
}

export const NO_USAGE: TaskUsage = { input: null, output: null, cached: null, costMicros: null }

/**
 * What a turn used since the last report. A field that is absent was not reported, so it changes
 * nothing. A field that is 0 was reported, and the task then shows 0.
 */
export interface SpentUsage {
  readonly input?: number
  readonly output?: number
  readonly cached?: number
  readonly costMicros?: number
}

const plus = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : a + b

/** Adds one report to the usage of a task. */
export const addSpent = (usage: TaskUsage, spent: SpentUsage): TaskUsage => ({
  input: plus(usage.input, spent.input ?? null),
  output: plus(usage.output, spent.output ?? null),
  cached: plus(usage.cached, spent.cached ?? null),
  costMicros: plus(usage.costMicros, spent.costMicros ?? null),
})

/** Adds two usages. A field that neither side reported stays `null`. */
export const addUsage = (a: TaskUsage, b: TaskUsage): TaskUsage => ({
  input: plus(a.input, b.input),
  output: plus(a.output, b.output),
  cached: plus(a.cached, b.cached),
  costMicros: plus(a.costMicros, b.costMicros),
})

/** True when the provider reported any number for the task. */
export const hasUsage = (usage: TaskUsage): boolean =>
  usage.input !== null ||
  usage.output !== null ||
  usage.cached !== null ||
  usage.costMicros !== null

/** The input and output tokens together. A field that is not reported counts as 0 here. */
export const tokensOf = (usage: Pick<TaskUsage, "input" | "output">): number =>
  (usage.input ?? 0) + (usage.output ?? 0)

/**
 * The cached share in percent: cached input divided by all input, rounded. `null` when the provider
 * reports no cached input, or no input, so the window shows no share (spec 005).
 */
export const cachedShare = (usage: Pick<TaskUsage, "input" | "cached">): number | null =>
  usage.cached === null || usage.input === null || usage.input <= 0
    ? null
    : Math.min(100, Math.round((usage.cached / usage.input) * 100))

/** One agent in the tree of a task: what its tasks used, and its share of the total. */
export interface AgentUsageLine {
  readonly agentId: string
  readonly agentName: string
  readonly usage: TaskUsage
  /** The input and output of this agent in percent of the total of the tree. Null for no total. */
  readonly share: number | null
}

/** The usage of a task and everything below it (spec 005). */
export interface TreeUsage {
  readonly total: TaskUsage
  /** One line for each agent in the tree, the largest total first. */
  readonly lines: readonly AgentUsageLine[]
}

/** The part of a task that the usage of a tree needs. */
export interface UsageOf {
  readonly agentId: string
  readonly agentName: string
  readonly usage: TaskUsage
}

/**
 * Whole percents of `whole` for each part. The parts add up to 100 when they add up to `whole`:
 * each part gets the rounded-down percent, and the parts with the largest remainders get one more.
 * A part that is null has no share.
 */
const sharesOf = (parts: readonly (number | null)[], whole: number): (number | null)[] => {
  const exact = parts.map((p) => (p === null || whole <= 0 ? null : (p / whole) * 100))
  const floors = exact.map((e) => (e === null ? null : Math.floor(e)))
  const given = floors.reduce<number>((sum, f) => sum + (f ?? 0), 0)
  const summed = parts.reduce<number>((sum, p) => sum + (p ?? 0), 0)
  let extra = summed === whole ? 100 - given : 0
  const order = exact
    .map((e, i) => ({ i, rest: e === null ? -1 : e - Math.floor(e) }))
    .filter((x) => x.rest >= 0)
    .sort((a, b) => b.rest - a.rest || a.i - b.i)
  const result = [...floors]
  for (const { i } of order) {
    if (extra <= 0) break
    result[i] = (result[i] ?? 0) + 1
    extra -= 1
  }
  return result
}

/**
 * The total of a set of tasks and one line for each agent. The lines go largest total first; an
 * agent that reported nothing comes last, and its line shows "—" (spec 005). The total counts the
 * agents that reported only.
 */
export const treeUsage = (tasks: readonly UsageOf[]): TreeUsage => {
  const byAgent = new Map<string, { name: string; usage: TaskUsage }>()
  let total = NO_USAGE
  for (const task of tasks) {
    total = addUsage(total, task.usage)
    const found = byAgent.get(task.agentId)
    byAgent.set(task.agentId, {
      name: task.agentName,
      usage: addUsage(found?.usage ?? NO_USAGE, task.usage),
    })
  }
  const whole = tokensOf(total)
  const entries = [...byAgent.entries()].map(([agentId, { name, usage }]) => ({
    agentId,
    name,
    usage,
  }))
  const shares = sharesOf(
    entries.map((e) => (whole > 0 && hasUsage(e.usage) ? tokensOf(e.usage) : null)),
    whole,
  )
  const lines = entries.map(
    ({ agentId, name, usage }, i): AgentUsageLine => ({
      agentId,
      agentName: name,
      usage,
      share: shares[i] ?? null,
    }),
  )
  // The largest total first. An agent with no report has no total and goes last.
  lines.sort(
    (a, b) =>
      Number(hasUsage(b.usage)) - Number(hasUsage(a.usage)) ||
      tokensOf(b.usage) - tokensOf(a.usage) ||
      a.agentName.localeCompare(b.agentName),
  )
  return { total, lines }
}

/** The task `rootId` and every task below it. A task is listed once. */
export const withDescendantsOf = <
  T extends { readonly id: string; readonly parentId: string | null },
>(
  tasks: readonly T[],
  rootId: string,
): T[] => {
  const out: T[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const self = tasks.find((t) => t.id === id)
    if (self) out.push(self)
    for (const task of tasks) if (task.parentId === id) visit(task.id)
  }
  visit(rootId)
  return out
}

// ---- the token limit of a run of a routine (spec 009) -------------------------------------------

/** The token limit of a routine is a whole number in this range. Off by default. */
export const TOKEN_LIMIT_MIN = 1000
export const TOKEN_LIMIT_MAX = 10_000_000

/** A run shows a muted line when it has used this share of its limit, in percent. */
export const TOKEN_LIMIT_WARN_PERCENT = 80

export const validTokenLimit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= TOKEN_LIMIT_MIN &&
  value <= TOKEN_LIMIT_MAX

/**
 * Where a run stands against its limit: `ok`, `near` at 80 percent or more, and `over` at the limit
 * or more. Cached input counts as input, so `used` is input plus output (spec 009).
 */
export const limitState = (used: number, limit: number): "ok" | "near" | "over" =>
  used >= limit ? "over" : used * 100 >= limit * TOKEN_LIMIT_WARN_PERCENT ? "near" : "ok"

/**
 * Whether a program reports its tokens. A program that reports none cannot use the token limit
 * (spec 009): the field is off for its agent. Every program that the app starts reports tokens at
 * the end of a turn; a program that does not is listed here when it joins.
 */
const SILENT_PROGRAMS: ReadonlySet<string> = new Set([])
export const programReportsTokens = (kind: string): boolean => !SILENT_PROGRAMS.has(kind)

/** The names of the programs, as the products call themselves. They are not translated. */
const PROGRAM_NAMES: Readonly<Record<string, string>> = {
  claude_code: "Claude Code",
  codex: "Codex",
  muse: "Muse Code",
  pi: "pi",
  opencode: "opencode",
}
export const programName = (kind: string): string => PROGRAM_NAMES[kind] ?? kind
