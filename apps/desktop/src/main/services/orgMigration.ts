import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import {
  type MigrationChannel,
  nameKey,
  orgToolEntries,
  planOrgMigration,
  withOrgSwitch,
} from "@robot/shared"
import { repairOrgLines } from "./orgRepair.ts"

// The first start of this version makes an organization from each channel that has a parent
// channel, a sub-channel, a tool or a daily token limit (spec 030, "Migration"). The channel keeps
// its fields: the steps that move each rule clear them later. The id of an organization comes from
// the id of its channel, so two computers that migrate before they sync end with the same
// organizations. Running it again changes nothing.

interface ChannelRow {
  id: string
  server_id: string
  name: string
  parent_channel_id: string | null
  lead_agent_id: string | null
  daily_token_limit: number | null
  created_at: number
  updated_at: number
}

/** The ids in a JSON list of ids. A text that holds no list gives none. */
const idsIn = (text: string): string[] => {
  try {
    const list: unknown = JSON.parse(text)
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

/** Runs inside the transaction of the migration step: the tables of the step exist already. */
export const migrateChannelsToOrganizations = (db: DatabaseSync): void => {
  const all = <T>(sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).all(...params) as T[]
  const run = (sql: string, ...params: (string | number | null)[]) =>
    void db.prepare(sql).run(...params)

  const rows = all<ChannelRow>(
    `SELECT id, server_id, name, parent_channel_id, lead_agent_id, daily_token_limit, created_at, updated_at
     FROM channel`,
  )
  if (rows.length === 0) return
  const members = new Map<string, string[]>()
  for (const m of all<{ channel_id: string; agent_id: string }>(
    "SELECT channel_id, agent_id FROM channel_member ORDER BY channel_id, position",
  ))
    members.set(m.channel_id, [...(members.get(m.channel_id) ?? []), m.agent_id])

  // A tool of a channel: the channel is in the list of a skill or a connection.
  const withTools = new Set<string>()
  const toolRows = {
    skill: all<{ id: string; channels: string }>("SELECT id, channels FROM skill"),
    tool_connection: all<{ id: string; channels: string }>(
      "SELECT id, channels FROM tool_connection",
    ),
  }
  for (const list of Object.values(toolRows))
    for (const row of list) for (const id of idsIn(row.channels)) withTools.add(id)

  const rule = all<{ hand_off: string }>("SELECT hand_off FROM organization LIMIT 1")[0]
  const existing = new Set(
    all<{ server_id: string; name_key: string }>("SELECT server_id, name_key FROM org_unit").map(
      (o) => `${o.server_id}|${o.name_key}`,
    ),
  )
  const plan = planOrgMigration(
    rows.map(
      (c): MigrationChannel => ({
        id: c.id,
        serverId: c.server_id,
        name: c.name,
        parentId: c.parent_channel_id,
        leadId: c.lead_agent_id,
        memberIds: members.get(c.id) ?? [],
        dailyTokenLimit: c.daily_token_limit,
        hasTools: withTools.has(c.id),
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      }),
    ),
    {
      alongChannels: rule?.hand_off === "channels",
      taken: (serverId, key) => existing.has(`${serverId}|${key}`),
    },
  )

  const made = new Set(all<{ id: string }>("SELECT id FROM org_unit").map((o) => o.id))
  for (const org of plan) {
    if (made.has(org.id)) continue
    run(
      `INSERT INTO org_unit (id, server_id, name, name_key, lead_agent_id, parent_id, hand_off_range,
        daily_token_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'inherit', ?, ?, ?)`,
      org.id,
      org.serverId,
      org.name,
      nameKey(org.name),
      org.leadId,
      org.parentId,
      org.dailyTokenLimit,
      org.createdAt,
      org.updatedAt,
    )
    for (const [position, agentId] of org.memberIds.entries())
      run(
        "INSERT OR IGNORE INTO org_member (org_id, agent_id, position) VALUES (?, ?, ?)",
        org.id,
        agentId,
        position,
      )
  }

  // A channel in the list of a skill or a connection becomes its organization with the value "On".
  const orgOf = new Map(plan.map((o) => [o.channelId, o.id]))
  for (const [table, list] of Object.entries(toolRows)) {
    for (const row of list) {
      const wanted = idsIn(row.channels).flatMap((id) => orgOf.get(id) ?? [])
      if (wanted.length === 0) continue
      const stored = all<{ organizations: string }>(
        `SELECT organizations FROM ${table} WHERE id = ?`,
        row.id,
      )[0]
      const before = orgToolEntries(stored?.organizations)
      const after = wanted.reduce(
        (entries, id) =>
          entries.some((e) => e.id === id) ? entries : withOrgSwitch(entries, id, "on"),
        before,
      )
      if (after.length !== before.length)
        run(`UPDATE ${table} SET organizations = ? WHERE id = ?`, JSON.stringify(after), row.id)
    }
  }
}

/**
 * The repair of a line after the migration (spec 030, "Migration", "Agents in channels that do not
 * make one line"). The organizations that the step above made can hold an agent in organizations
 * that are not on one line: the agent was in two channels with no parent between them. Each such
 * agent leaves the organization that it joined last, and the channel that was made first counts as
 * the one that it joined first: a migration has no time of change, so the tie order decides (the
 * organization that was made later, then the later id; an organization takes the time and the id
 * of its channel). The agent stays a member of the channel. Each removal waits in `org_line_note`
 * for the line of the organization log. It runs in the transaction of its step, and it changes
 * nothing when the lines are right.
 */
export const repairLinesAfterMigration = (db: DatabaseSync): void => {
  const repairs = repairOrgLines(
    {
      all: <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[],
      run: (sql, ...params) => void db.prepare(sql).run(...params),
    },
    { changed: new Map() },
  )
  for (const r of repairs)
    db.prepare(
      "INSERT INTO org_line_note (org_id, org_name, agent_id, agent_name) VALUES (?, ?, ?, ?)",
    ).run(r.orgId, r.orgName, r.agentId, r.agentName)
}
