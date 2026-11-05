import { channelParent, type TreeChannel } from "@robot/shared"

/** A channel the phone already holds, enough to name its parent (spec 030, 011). */
export interface NamedChannel extends TreeChannel {
  readonly name: string
}

/**
 * The parent in the header, or null when the channel is a top channel. A parent that is gone or
 * archived counts as none, as on the computer (spec 030).
 */
export function parentChannelOf(
  channels: readonly NamedChannel[],
  id: string,
): NamedChannel | null {
  const parentId = channelParent(channels, id)
  if (parentId === null) return null
  return channels.find((channel) => channel.id === parentId) ?? null
}
