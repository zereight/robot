import type { DatabaseService } from "./Database.ts"

/**
 * The main agent (spec 002, flow 7): the agent with the switch on that is not archived, or null.
 * An archived main agent counts as none, so this is the one place that says it. `serverId` limits
 * the look to one server. The sync check keeps one flag at most; if two are on for a moment, the
 * agent that was made first answers, so every reader gets the same one.
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
