import type { SpentUsage } from "@robot/shared"

/** The counts of a `usage` event. Every field can be absent. */
export interface UsageCounts {
  readonly input?: number
  readonly output?: number
  readonly cached?: number
  readonly costMicros?: number
}

/**
 * What a unit of work used since the last report (spec 005, "Usage of a task"). A task adds these
 * to its own numbers. The event comes right after the `usage` event that it follows.
 */
export interface SpentEvent extends SpentUsage {
  readonly type: "spent"
}

const FIELDS = ["input", "output", "cached", "costMicros"] as const

/**
 * Turns the running totals of one unit of work into what was spent since the last report. A unit is
 * one request to an API model, or one run of a program. Its `usage` events give totals so far, so
 * a later event never counts what an earlier one counted. A field that no event named stays absent
 * in the answer: the provider did not report it, and it is not 0 (spec 005). A field that an event
 * named as 0 comes back as 0.
 */
export const spendTracker = () => {
  const seen: Partial<Record<(typeof FIELDS)[number], number>> = {}
  return (counts: UsageCounts): SpentEvent | undefined => {
    const spent: { -readonly [K in (typeof FIELDS)[number]]?: number } = {}
    let any = false
    for (const field of FIELDS) {
      const total = counts[field]
      if (typeof total !== "number" || !Number.isFinite(total)) continue
      // A total that goes down is a new count of a proxy; it never takes tokens away.
      spent[field] = Math.max(0, total - (seen[field] ?? 0))
      seen[field] = Math.max(total, seen[field] ?? 0)
      any = true
    }
    return any ? { type: "spent", ...spent } : undefined
  }
}
