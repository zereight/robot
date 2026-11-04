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
