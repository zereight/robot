import {
  dayBounds,
  type LimitOrg,
  limitStopsSource,
  ORG_LIMIT_CODE,
  type OrgLimitView,
  type OrgUsageRow,
  orgLimitView,
  orgUsageRows,
  orgUsedToday,
  stoppingOrg,
  type TaskSource,
  tokensOf,
} from "@robot/shared"
import type { DatabaseService } from "./Database.ts"
import { orgIdsOfAgent } from "./orgData.ts"

// The daily token limit of an organization as plain functions on the database (spec 030, "Daily
// token limit"). The service of organizations, the window and the one place where a task starts
// share them, so there is one reading of the tokens of the day.

/** The organizations of a server with their live members and limits, for the rules of `orgLimit`. */
export const limitOrgs = (db: DatabaseService, serverId: string): LimitOrg[] => {
  const members = new Map<string, string[]>()
  for (const m of db.all<{ org_id: string; agent_id: string }>(
    `SELECT m.org_id AS org_id, m.agent_id AS agent_id
     FROM org_member m JOIN org_unit o ON o.id = m.org_id JOIN agent a ON a.id = m.agent_id
     WHERE o.server_id = ? AND a.archived_at IS NULL
     ORDER BY m.position`,
    serverId,
  )) {
    const list = members.get(m.org_id) ?? []
    list.push(m.agent_id)
    members.set(m.org_id, list)
  }
  return db
    .all<{ id: string; name: string; parent_id: string | null; daily_token_limit: number | null }>(
      "SELECT id, name, parent_id, daily_token_limit FROM org_unit WHERE server_id = ?",
      serverId,
    )
    .map((o) => ({
      id: o.id,
      name: o.name,
      parentId: o.parent_id,
      memberIds: members.get(o.id) ?? [],
      dailyLimit: o.daily_token_limit,
    }))
}

/**
 * The tokens that each agent used on the day of `at`, from every source (spec 030, "What counts").
 * A task counts on the day it started (the day it was made, for a task that never started), and
 * the day is from midnight to midnight in the time of this computer. A task that came by sync
 * counts like one of this computer. Input and output count, and a number that the provider did not
 * report counts as 0.
 */
export const tokensByAgentToday = (db: DatabaseService, at: number): Map<string, number> => {
  const { start, end } = dayBounds(at)
  const byAgent = new Map<string, number>()
  for (const t of db.all<{
    agent_id: string
    input_tokens: number | null
    output_tokens: number | null
  }>(
    `SELECT agent_id, input_tokens, output_tokens FROM task
     WHERE COALESCE(started_at, created_at) >= ? AND COALESCE(started_at, created_at) < ?
       AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`,
    start,
    end,
  ))
    byAgent.set(
      t.agent_id,
      (byAgent.get(t.agent_id) ?? 0) + tokensOf({ input: t.input_tokens, output: t.output_tokens }),
    )
  return byAgent
}

/** The organizations of a server and the tokens each one used today. */
export const orgsUsedToday = (db: DatabaseService, serverId: string, at = Date.now()) => {
  const orgs = limitOrgs(db, serverId)
  // Nothing to count when no organization has a limit.
  if (!orgs.some((o) => o.dailyLimit !== null))
    return { orgs, used: new Map<string, number>() as ReadonlyMap<string, number> }
  return { orgs, used: orgUsedToday(orgs, tokensByAgentToday(db, at)) }
}

/**
 * The error of a task that would start now when the daily limit of an organization stops it (spec
 * 005, "Blocked"; spec 030): the organization of the agent, or a higher one, whose limit is used. A
 * task of a direct chat is never stopped. Else null.
 */
export const orgLimitStop = (
  db: DatabaseService,
  agentId: string,
  source: TaskSource,
  at = Date.now(),
): { readonly code: string; readonly detail: string } | null => {
  if (!limitStopsSource(source)) return null
  const memberOf = orgIdsOfAgent(db, agentId)
  if (memberOf.length === 0) return null
  const serverId = db.get<{ server_id: string }>(
    "SELECT server_id FROM agent WHERE id = ?",
    agentId,
  )?.server_id
  if (serverId === undefined) return null
  const { orgs, used } = orgsUsedToday(db, serverId, at)
  const stop = stoppingOrg(orgs, used, memberOf)
  return stop ? { code: ORG_LIMIT_CODE, detail: stop.name } : null
}

/** What the form of an organization shows of its limit today. Null when the organization is gone. */
export const orgLimitViewOf = (
  db: DatabaseService,
  orgId: string,
  at = Date.now(),
): OrgLimitView | null => {
  const serverId = db.get<{ server_id: string }>(
    "SELECT server_id FROM org_unit WHERE id = ?",
    orgId,
  )?.server_id
  if (serverId === undefined) return null
  const { orgs, used } = orgsUsedToday(db, serverId, at)
  const limit = orgs.find((o) => o.id === orgId)?.dailyLimit ?? null
  return orgLimitView(limit, used.get(orgId) ?? 0)
}

/** The rows of the usage page: each organization of the server with a limit (spec 006, 030). */
export const orgUsageOf = (
  db: DatabaseService,
  serverId: string,
  at = Date.now(),
): OrgUsageRow[] => {
  const { orgs, used } = orgsUsedToday(db, serverId, at)
  return orgUsageRows(orgs, used)
}
