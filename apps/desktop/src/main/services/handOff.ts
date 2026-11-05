import {
  DEFAULT_HAND_OFF_RULE,
  type HandOffModel,
  type HandOffRule,
  isHandOffRule,
} from "@robot/shared"
import type { DatabaseService } from "./Database.ts"

/** The hand-off rule of this profile (spec 030). A row that is not there counts as "Any agent". */
export const readHandOffRule = (db: DatabaseService): HandOffRule => {
  const row = db.get<{ hand_off: string }>(
    "SELECT hand_off FROM organization WHERE id = 'organization'",
  )
  return isHandOffRule(row?.hand_off) ? row.hand_off : DEFAULT_HAND_OFF_RULE
}

/** The switch "Ask up the line" of this profile (spec 030). A row that is not there counts as off. */
export const readAskUpTheLine = (db: DatabaseService): boolean =>
  db.get<{ ask_up_the_line: number }>(
    "SELECT ask_up_the_line FROM organization WHERE id = 'organization'",
  )?.ask_up_the_line === 1

/**
 * The main agent (spec 002, flow 7): the agent with the switch on that is not archived, or null.
 * An archived main agent counts as none (spec 029, 030), so this is the one place that says it.
 * `serverId` limits the look to one server. The sync check keeps one flag at most; if two are on
 * for a moment, the agent that was made first answers, so every reader gets the same one.
 */
export const readMainAgent = (db: DatabaseService, serverId?: string): string | null =>
  (serverId === undefined
    ? db.get<{ id: string }>(
        "SELECT id FROM agent WHERE is_main = 1 AND archived_at IS NULL ORDER BY created_at, id LIMIT 1",
      )
    : db.get<{ id: string }>(
        "SELECT id FROM agent WHERE server_id = ? AND is_main = 1 AND archived_at IS NULL ORDER BY created_at, id LIMIT 1",
        serverId,
      )
  )?.id ?? null

/**
 * The agents and channels of one server as the hand-off rule reads them (spec 030). It reads the
 * database at the time of the send, so a change of a member, of a lead or of a parent channel
 * counts from the next send. The app has no archived channel yet, so no channel is archived here;
 * the rule already ignores an archived channel when one is marked.
 */
export const loadHandOffModel = (
  db: DatabaseService,
  serverId: string,
  mainAgentId: string | null,
): HandOffModel => {
  const members = new Map<string, string[]>()
  for (const m of db.all<{ channel_id: string; agent_id: string }>(
    `SELECT m.channel_id, m.agent_id FROM channel_member m
     JOIN channel c ON c.id = m.channel_id WHERE c.server_id = ?
     ORDER BY m.channel_id, m.position`,
    serverId,
  )) {
    members.set(m.channel_id, [...(members.get(m.channel_id) ?? []), m.agent_id])
  }
  return {
    agents: db
      .all<{ id: string; name: string; archived_at: number | null }>(
        "SELECT id, name, archived_at FROM agent WHERE server_id = ?",
        serverId,
      )
      .map((a) => ({ id: a.id, name: a.name, archived: a.archived_at !== null })),
    channels: db
      .all<{
        id: string
        name: string
        lead_agent_id: string | null
        parent_channel_id: string | null
      }>(
        "SELECT id, name, lead_agent_id, parent_channel_id FROM channel WHERE server_id = ?",
        serverId,
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        parentId: c.parent_channel_id,
        leadId: c.lead_agent_id,
        memberIds: members.get(c.id) ?? [],
      })),
    mainAgentId,
  }
}
