// The daily token limit of a channel (spec 030, "Daily token limit"). These are plain functions. A
// channel limit counts the tokens of the tasks of a day. The next step moves the limit to the
// organizations (`orgLimit.ts`), and this file goes with it. The tools are in `orgTools.ts`.

import { higherChannels, type TreeChannel } from "./channelTree.ts"
import { limitState } from "./taskUsage.ts"

// ---------------------------------------------------------------------------------------------
// The daily token limit of a channel
// ---------------------------------------------------------------------------------------------

/**
 * The error code of a task that the daily token limit of its channel stops (spec 030). Its detail
 * is the name of the channel whose limit is used.
 */
export const CHANNEL_LIMIT_CODE = "channel_limit"

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

// ---------------------------------------------------------------------------------------------
// What the window shows
// ---------------------------------------------------------------------------------------------

/** What a channel shows about its limit today. */
export interface ChannelLimitInfo extends ChannelLimitView {
  /**
   * The channel whose limit is used and so stops new tasks of this channel: this channel or a
   * higher one. Null when no limit stops it.
   */
  readonly stoppedBy: { readonly id: string; readonly name: string } | null
}

/** A row of the usage page for a channel with a daily token limit (spec 006, 030). */
export interface ChannelUsageRow {
  readonly channelId: string
  readonly name: string
  readonly used: number
  readonly limit: number
}
