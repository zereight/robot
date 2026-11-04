// The tools of a channel and its daily token limit (spec 030, "Channel tools" and "Daily token
// limit"). These are plain functions. The skills (017) and the connections (018) hold a list of
// agents and channels that may use them. A channel limit counts the tokens of the tasks of a day.

import { higherChannels, type TreeChannel } from "./channelTree.ts"
import { limitState } from "./taskUsage.ts"

// ---------------------------------------------------------------------------------------------
// Who may use a skill or a connection
// ---------------------------------------------------------------------------------------------

/**
 * The agents and channels that may use a skill or a connection. `agentIds` is `null` for "All
 * agents". Else the list holds the agents in `agentIds` and the channels in `channelIds`. A list
 * has at least one entry in all (spec 017, 018).
 */
export interface ToolAudience {
  readonly agentIds: readonly string[] | null
  readonly channelIds: readonly string[]
}

/** "All agents". */
export const ALL_AGENTS: ToolAudience = { agentIds: null, channelIds: [] }

/**
 * The channels that give their tools to an agent that is a member of the channels `memberOf`: each
 * of those channels that is not archived, and each higher channel of it (spec 030, "Channel
 * tools"). An archived channel gives nothing: not as a member channel, and not as a higher channel
 * (an archived parent counts as no parent, so the tree already leaves it out). The nearest channels
 * come first.
 */
export const givingChannels = (
  channels: readonly TreeChannel[],
  memberOf: readonly string[],
): string[] => {
  const live = new Set(channels.filter((c) => !c.archived).map((c) => c.id))
  const out: string[] = []
  const add = (id: string) => {
    if (live.has(id) && !out.includes(id)) out.push(id)
  }
  for (const id of memberOf) add(id)
  for (const id of memberOf) {
    if (!live.has(id)) continue
    for (const higher of higherChannels(channels, id)) add(higher)
  }
  return out
}

/**
 * The channels of the list that give the tool to this agent, nearest first. `giving` is what
 * `givingChannels` gave for the agent.
 */
export const channelsThatGive = (audience: ToolAudience, giving: readonly string[]): string[] =>
  giving.filter((id) => audience.channelIds.includes(id))

/**
 * Whether an agent may use a skill or a connection (spec 030): "All agents" is on, or the list holds
 * the agent, or a channel that gives it. The skill or connection must also be on: the callers check
 * that.
 */
export const mayUseTool = (
  audience: ToolAudience,
  agentId: string,
  giving: readonly string[],
): boolean =>
  audience.agentIds === null ||
  audience.agentIds.includes(agentId) ||
  channelsThatGive(audience, giving).length > 0

/**
 * The list of a skill or a connection after the channel `channelId` is switched on or off in
 * "Tools of this channel" (spec 030). A skill for "All agents" is not a list: the switch of a
 * channel has no effect on it, and the row shows it as on, read only. A list with the channel and
 * no other entry loses its last entry when the switch goes off: the caller must refuse that, or
 * keep the skill for no one. The agents of the list stay in place.
 */
export const withChannelSwitch = (
  audience: ToolAudience,
  channelId: string,
  on: boolean,
): ToolAudience => {
  if (audience.agentIds === null) return audience
  const rest = audience.channelIds.filter((id) => id !== channelId)
  return { agentIds: audience.agentIds, channelIds: on ? [...rest, channelId] : rest }
}

/** True when the list names no agent and no channel. Such a list gives the tool to no one. */
export const emptyAudience = (audience: ToolAudience): boolean =>
  audience.agentIds !== null && audience.agentIds.length === 0 && audience.channelIds.length === 0

// ---------------------------------------------------------------------------------------------
// The daily token limit of a channel
// ---------------------------------------------------------------------------------------------

/** The daily token limit takes a whole number in this range. It is off by default (spec 030). */
export const DAILY_LIMIT_MIN = 10_000
export const DAILY_LIMIT_MAX = 100_000_000

export const validDailyLimit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= DAILY_LIMIT_MIN &&
  value <= DAILY_LIMIT_MAX

/** A channel with its daily token limit, for the functions below. */
export interface LimitChannel extends TreeChannel {
  /** The daily token limit, or null when it is off. */
  readonly dailyLimit: number | null
}

/**
 * The tokens that each channel used on the day, with its lower channels (spec 030, "What counts").
 * `own` holds the tokens of the tasks of each channel itself. A channel that is not in `own` used
 * none.
 */
export const usedWithLower = (
  channels: readonly TreeChannel[],
  own: ReadonlyMap<string, number>,
): Map<string, number> => {
  const out = new Map<string, number>()
  for (const channel of channels)
    out.set(channel.id, (out.get(channel.id) ?? 0) + (own.get(channel.id) ?? 0))
  // A task of a channel counts for the channel and for each of its higher channels.
  for (const channel of channels) {
    const tokens = own.get(channel.id) ?? 0
    if (tokens === 0) continue
    for (const higher of higherChannels(channels, channel.id))
      out.set(higher, (out.get(higher) ?? 0) + tokens)
  }
  return out
}

/**
 * The channel whose daily limit is used and so stops a new task of channel `id`: the channel itself
 * or one of its higher channels (spec 030, "At the limit"). The nearest one wins when several are
 * used. `used` is what `usedWithLower` gave. Null when no limit stops the task.
 */
export const stoppingChannel = (
  channels: readonly LimitChannel[],
  used: ReadonlyMap<string, number>,
  id: string,
): string | null => {
  const byId = new Map(channels.map((c) => [c.id, c]))
  const chain = [id, ...higherChannels(channels, id)]
  for (const at of chain) {
    const limit = byId.get(at)?.dailyLimit ?? null
    if (limit !== null && limitState(used.get(at) ?? 0, limit) === "over") return at
  }
  return null
}

/** What a channel shows of its limit: the limit, the tokens used today, and where it stands. */
export interface ChannelLimitView {
  readonly limit: number | null
  readonly used: number
  /** `near` from 80 percent, `over` at the limit. `ok` when the limit is off. */
  readonly state: "ok" | "near" | "over"
}

export const limitViewOf = (limit: number | null, used: number): ChannelLimitView => ({
  limit,
  used,
  state: limit === null ? "ok" : limitState(used, limit),
})
