import {
  type ChannelLimitView,
  dayBounds,
  type LimitChannel,
  limitViewOf,
  stoppingChannel,
  tokensOf,
  usedWithLower,
} from "@robot/shared"
import type { DatabaseService } from "./Database.ts"

// The channel side of the daily token limit (spec 030). These are plain functions on the database,
// so that the channels and the usage page share one reading of the tree. The tools of an
// organization are decided in `orgData.ts` (`mayUseRow`). A channel has no archive state in the
// data of today, so no channel counts as archived here; the functions of `@robot/shared` already
// leave an archived channel out when the data gets one.

interface ChannelLine {
  id: string
  parent_channel_id: string | null
  daily_token_limit: number | null
}

/** The channels of a server with their parents and limits. */
export const limitChannels = (db: DatabaseService, serverId: string): LimitChannel[] =>
  db
    .all<ChannelLine>(
      "SELECT id, parent_channel_id, daily_token_limit FROM channel WHERE server_id = ?",
      serverId,
    )
    .map((c) => ({ id: c.id, parentId: c.parent_channel_id, dailyLimit: c.daily_token_limit }))

// ---------------------------------------------------------------------------------------------
// The daily token limit
// ---------------------------------------------------------------------------------------------

/**
 * The tokens that the tasks of each channel of a server used on the day of `at` (spec 030, "What
 * counts"): the tasks whose source is the channel, which are the jobs of the lead, the parts, the
 * replies to a mention or to `@all`, and their retries. A hand-off to another agent is a task of
 * that agent, with another source, and does not count. A task counts on the day it started (the day
 * it was made, for a task that never started), in the time of this computer. Input and output
 * count, and a number that the provider did not report counts as 0.
 */
export const ownTokensToday = (
  db: DatabaseService,
  serverId: string,
  at: number,
): Map<string, number> => {
  const { start: from, end: to } = dayBounds(at)
  const own = new Map<string, number>()
  for (const t of db.all<{
    source_id: string
    input_tokens: number | null
    output_tokens: number | null
  }>(
    `SELECT t.source_id AS source_id, t.input_tokens AS input_tokens, t.output_tokens AS output_tokens
     FROM task t JOIN channel c ON c.id = t.source_id
     WHERE t.source = 'channel' AND c.server_id = ?
       AND COALESCE(t.started_at, t.created_at) >= ? AND COALESCE(t.started_at, t.created_at) < ?
       AND (t.input_tokens IS NOT NULL OR t.output_tokens IS NOT NULL)`,
    serverId,
    from,
    to,
  )) {
    own.set(
      t.source_id,
      (own.get(t.source_id) ?? 0) + tokensOf({ input: t.input_tokens, output: t.output_tokens }),
    )
  }
  return own
}

/** The tokens used today by each channel of a server, with its lower channels. */
export const usedToday = (
  db: DatabaseService,
  serverId: string,
  at = Date.now(),
): { readonly channels: LimitChannel[]; readonly used: Map<string, number> } => {
  const channels = limitChannels(db, serverId)
  return { channels, used: usedWithLower(channels, ownTokensToday(db, serverId, at)) }
}

/** The channel whose daily limit is used and so stops a new task of channel `channelId`, or null. */
export const limitStopping = (
  db: DatabaseService,
  channelId: string,
  at = Date.now(),
): { readonly id: string; readonly name: string } | null => {
  const serverId = db.get<{ server_id: string }>(
    "SELECT server_id FROM channel WHERE id = ?",
    channelId,
  )?.server_id
  if (serverId === undefined) return null
  const { channels, used } = usedToday(db, serverId, at)
  // Nothing to count when no channel on the chain has a limit.
  if (!channels.some((c) => c.dailyLimit !== null)) return null
  const stop = stoppingChannel(channels, used, channelId)
  if (stop === null) return null
  const name = db.get<{ name: string }>("SELECT name FROM channel WHERE id = ?", stop)?.name
  return { id: stop, name: name ?? "" }
}

/** What a channel shows of its limit today. */
export const limitView = (
  db: DatabaseService,
  channelId: string,
  at = Date.now(),
): ChannelLimitView => {
  const serverId = db.get<{ server_id: string }>(
    "SELECT server_id FROM channel WHERE id = ?",
    channelId,
  )?.server_id
  if (serverId === undefined) return limitViewOf(null, 0)
  const { channels, used } = usedToday(db, serverId, at)
  const limit = channels.find((c) => c.id === channelId)?.dailyLimit ?? null
  return limitViewOf(limit, used.get(channelId) ?? 0)
}
