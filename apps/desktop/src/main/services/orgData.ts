import {
  agentMayUse,
  type HandOffRange,
  type Org,
  type OrgToolEntry,
  orgGivers,
  orgToolEntries,
  type TreeOrg,
} from "@robot/shared"
import type { DatabaseService } from "./Database.ts"

// Plain functions on the database that read organizations (spec 030). The service, the skills, the
// connections and the repair share them, so there is one reading of an organization.

export interface OrgRow {
  id: string
  server_id: string
  name: string
  lead_agent_id: string | null
  parent_id: string | null
  hand_off_range: HandOffRange
  daily_token_limit: number | null
  goal: string | null
  created_at: number
}

const membersOf = (db: DatabaseService, orgId: string): string[] =>
  db
    .all<{ agent_id: string }>(
      "SELECT agent_id FROM org_member WHERE org_id = ? ORDER BY position",
      orgId,
    )
    .map((m) => m.agent_id)

/** Turns a row into an organization. A lead that is no member reads as no lead. */
export const toOrg = (db: DatabaseService, row: OrgRow): Org => {
  const memberIds = membersOf(db, row.id)
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    memberIds,
    leadId:
      row.lead_agent_id !== null && memberIds.includes(row.lead_agent_id)
        ? row.lead_agent_id
        : null,
    parentId: row.parent_id,
    handOffRange: row.hand_off_range,
    dailyTokenLimit: row.daily_token_limit,
    goal: row.goal ?? "",
    createdAt: row.created_at,
  }
}

export const orgRow = (db: DatabaseService, id: string): OrgRow | undefined =>
  db.get<OrgRow>("SELECT * FROM org_unit WHERE id = ?", id)

/** The organizations of a server, in the order of their names (ignoring case). */
export const readOrgs = (db: DatabaseService, serverId: string): Org[] =>
  db
    .all<OrgRow>("SELECT * FROM org_unit WHERE server_id = ? ORDER BY name_key, id", serverId)
    .map((row) => toOrg(db, row))

/** The organizations of a server as the rules of the tree read them. */
export const orgTreeOf = (db: DatabaseService, serverId: string): TreeOrg[] =>
  db
    .all<{ id: string; parent_id: string | null }>(
      "SELECT id, parent_id FROM org_unit WHERE server_id = ?",
      serverId,
    )
    .map((o) => ({ id: o.id, parentId: o.parent_id }))

/** The organizations that an agent is a member of, in the order of their names. */
export const orgIdsOfAgent = (db: DatabaseService, agentId: string): string[] =>
  db
    .all<{ org_id: string }>(
      `SELECT m.org_id AS org_id FROM org_member m JOIN org_unit o ON o.id = m.org_id
       WHERE m.agent_id = ? ORDER BY o.name_key, o.id`,
      agentId,
    )
    .map((m) => m.org_id)

/** The organizations in the stored list of a skill or a connection. */
export const orgEntriesOf = (row: { readonly organizations?: string | null }): OrgToolEntry[] =>
  orgToolEntries(row.organizations)

/**
 * The organizations that give a skill or a connection to an agent now (spec 030, "Tools"): the
 * organizations that hold the value "On" for an organization of the agent, nearest first. Empty when
 * the agent is in no organization, or the list names none.
 */
export const orgGiversFor = (
  db: DatabaseService,
  row: { readonly organizations?: string | null },
  agentId: string,
): string[] => {
  const entries = orgEntriesOf(row)
  if (entries.length === 0) return []
  const serverId = db.get<{ server_id: string }>(
    "SELECT server_id FROM agent WHERE id = ?",
    agentId,
  )?.server_id
  if (serverId === undefined) return []
  const memberOf = orgIdsOfAgent(db, agentId)
  if (memberOf.length === 0) return []
  return orgGivers(orgTreeOf(db, serverId), entries, memberOf)
}

/** The entries of a list that are organizations of this server; each organization counts once. */
export const orgEntriesOnServer = (
  db: DatabaseService,
  serverId: string,
  entries: readonly OrgToolEntry[],
): OrgToolEntry[] => {
  const out: OrgToolEntry[] = []
  for (const entry of entries) {
    if (out.some((e) => e.id === entry.id)) continue
    if (db.get("SELECT 1 FROM org_unit WHERE id = ? AND server_id = ?", entry.id, serverId))
      out.push(entry)
  }
  return out
}

/** A JSON list of ids. A text that holds no list gives an empty one. */
export const idList = (text: string | null | undefined): string[] => {
  if (text === null || text === undefined) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

/**
 * Whether an agent may use the skill or the connection of a stored row (spec 030, "Tools"): "All
 * agents" is on, or the list holds the agent, or an organization of the agent has the value "On"
 * (its own, or the value of a higher organization). This is the one place that decides it: the
 * lists of skills and connections, a turn, and a direct chat all ask it. The caller checks that the
 * row is on.
 */
export const mayUseRow = (
  db: DatabaseService,
  row: { readonly agents: string | null; readonly organizations?: string | null },
  agentId: string,
): boolean => {
  if (row.agents === null) return true
  const agents = idList(row.agents)
  if (agents.includes(agentId)) return true
  const entries = orgEntriesOf(row)
  if (entries.length === 0) return false
  const serverId = db.get<{ server_id: string }>(
    "SELECT server_id FROM agent WHERE id = ?",
    agentId,
  )?.server_id
  if (serverId === undefined) return false
  return agentMayUse(
    { agentIds: agents, entries },
    agentId,
    orgTreeOf(db, serverId),
    orgIdsOfAgent(db, agentId),
  )
}
