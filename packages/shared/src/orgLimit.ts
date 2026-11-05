// The daily token limit of an organization (spec 030, "Daily token limit"). These are plain
// functions. The app reads the tokens of the tasks of the day and the organizations, and these
// functions decide what counts and what stops a new task.

import { higherOrgs, lowerOrgs, type TreeOrg } from "./orgTree.ts"
import type { TaskSource } from "./task.ts"
import { limitState } from "./taskUsage.ts"

/**
 * The error code of a task that the daily token limit of an organization stops (spec 005,
 * "Blocked"). Its detail is the name of the organization whose limit is used.
 */
export const ORG_LIMIT_CODE = "org_limit"

/** The daily token limit takes a whole number in this range. It is off by default (spec 030). */
export const DAILY_LIMIT_MIN = 10_000
export const DAILY_LIMIT_MAX = 100_000_000

export const validDailyLimit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= DAILY_LIMIT_MIN &&
  value <= DAILY_LIMIT_MAX

/** An organization with its members and its daily token limit, for the functions below. */
export interface LimitOrg extends TreeOrg {
  readonly name: string
  /** The members that count: the agents that are not archived (spec 030, "Member"). */
  readonly memberIds: readonly string[]
  /** The daily token limit, or null when it is off. */
  readonly dailyLimit: number | null
}

/**
 * The tokens that each organization used on the day (spec 030, "What counts"): the tokens of the
 * tasks of each agent that is a member of the organization or of one of its lower organizations.
 * `byAgent` holds the tokens of the day for each agent, from every source. An agent counts once in
 * an organization, also when it is a member of that organization and of a lower one. An agent in
 * two organizations counts in both.
 */
export const orgUsedToday = (
  orgs: readonly LimitOrg[],
  byAgent: ReadonlyMap<string, number>,
): Map<string, number> => {
  const out = new Map<string, number>()
  for (const org of orgs) {
    const agents = new Set(org.memberIds)
    for (const lowerId of lowerOrgs(orgs, org.id))
      for (const id of orgs.find((o) => o.id === lowerId)?.memberIds ?? []) agents.add(id)
    let sum = 0
    for (const id of agents) sum += byAgent.get(id) ?? 0
    out.set(org.id, sum)
  }
  return out
}

/** The names in the order that the lists use: ignoring case, then by id. */
const byName = (a: LimitOrg, b: LimitOrg): number => {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The organization whose daily limit is used and so stops a new task of an agent that is a member
 * of the organizations `memberOf` (spec 030, "At the limit", "More than one limit"): each of those
 * organizations and each higher organization of them. When more than one limit is used, the
 * organization that comes first in the order of names, ignoring case. `used` is what
 * `orgUsedToday` gave. Null when no limit stops the agent.
 */
export const stoppingOrg = (
  orgs: readonly LimitOrg[],
  used: ReadonlyMap<string, number>,
  memberOf: readonly string[],
): { readonly id: string; readonly name: string } | null => {
  const byId = new Map(orgs.map((o) => [o.id, o]))
  const chain = new Set<string>()
  for (const id of memberOf) {
    if (!byId.has(id)) continue
    chain.add(id)
    for (const higher of higherOrgs(orgs, id)) chain.add(higher)
  }
  const stopping = [...chain]
    .map((id) => byId.get(id) as LimitOrg)
    .filter(
      (o) => o.dailyLimit !== null && limitState(used.get(o.id) ?? 0, o.dailyLimit) === "over",
    )
    .sort(byName)[0]
  return stopping ? { id: stopping.id, name: stopping.name } : null
}

/**
 * Whether the limit can stop a task of this source. A task of a direct chat is never stopped, but it
 * counts (spec 030, "At the limit"). A message from Teams and a handover go to a direct chat, and
 * the short turn that finds facts after a turn of the chat belongs to it.
 */
export const limitStopsSource = (source: TaskSource): boolean =>
  source !== "chat" && source !== "handover" && source !== "teams" && source !== "memory_check"

/** What the form shows of the limit of an organization: the limit, the tokens used today, and where it stands. */
export interface OrgLimitView {
  readonly limit: number | null
  readonly used: number
  /** `near` from 80 percent, `over` at the limit. `ok` when the limit is off. */
  readonly state: "ok" | "near" | "over"
}

export const orgLimitView = (limit: number | null, used: number): OrgLimitView => ({
  limit,
  used,
  state: limit === null ? "ok" : limitState(used, limit),
})

/** A row of the usage page for an organization with a daily token limit (spec 006, 030). */
export interface OrgUsageRow {
  readonly orgId: string
  readonly name: string
  readonly used: number
  readonly limit: number
}

/** The rows of the usage page: each organization with a limit, in the order of names. */
export const orgUsageRows = (
  orgs: readonly LimitOrg[],
  used: ReadonlyMap<string, number>,
): OrgUsageRow[] =>
  orgs
    .filter((o) => o.dailyLimit !== null)
    .sort(byName)
    .map((o) => ({
      orgId: o.id,
      name: o.name,
      used: used.get(o.id) ?? 0,
      limit: o.dailyLimit as number,
    }))
