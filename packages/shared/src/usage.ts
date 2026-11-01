/** Day ranges that the usage page offers. */
export const USAGE_RANGES = [7, 30] as const
export type UsageRange = (typeof USAGE_RANGES)[number]

/** What one agent used on one local day. Only finished replies count. */
export interface UsageRow {
  /** Local calendar day, as YYYY-MM-DD. */
  readonly day: string
  readonly agentId: string
  readonly agentName: string
  readonly replies: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface UsageTotal {
  readonly replies: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface UsageByAgent extends UsageTotal {
  readonly agentId: string
  readonly agentName: string
}

export interface UsageByDay extends UsageTotal {
  readonly day: string
  readonly agents: readonly UsageRow[]
}

const emptyTotal = (): UsageTotal => ({ replies: 0, inputTokens: 0, outputTokens: 0 })

const add = (a: UsageTotal, b: UsageTotal): UsageTotal => ({
  replies: a.replies + b.replies,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
})

export const usageTotal = (rows: readonly UsageRow[]): UsageTotal => rows.reduce(add, emptyTotal())

/** Sums rows per agent. The agent that used the most tokens comes first. */
export const usageByAgent = (rows: readonly UsageRow[]): UsageByAgent[] => {
  const map = new Map<string, UsageByAgent>()
  for (const row of rows) {
    const previous = map.get(row.agentId)
    map.set(row.agentId, {
      agentId: row.agentId,
      agentName: row.agentName,
      ...add(previous ?? emptyTotal(), row),
    })
  }
  const tokens = (u: UsageTotal) => u.inputTokens + u.outputTokens
  return [...map.values()].sort(
    (a, b) => tokens(b) - tokens(a) || a.agentName.localeCompare(b.agentName),
  )
}

/** Groups rows per day, newest day first. */
export const usageByDay = (rows: readonly UsageRow[]): UsageByDay[] => {
  const map = new Map<string, UsageRow[]>()
  for (const row of rows) map.set(row.day, [...(map.get(row.day) ?? []), row])
  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, agents]) => ({ day, agents, ...usageTotal(agents) }))
}
