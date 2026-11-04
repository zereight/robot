import type { AgentChannelTool, ChannelToolRow } from "@robot/shared"

// The pure parts of "Tools of this channel" and of the lines "From <channel>" (spec 030).

/** The rows of one kind, in the order that the service gave them (by name). */
export const toolsOfKind = (
  rows: readonly ChannelToolRow[],
  kind: ChannelToolRow["kind"],
): ChannelToolRow[] => rows.filter((row) => row.kind === kind)

/**
 * The state of the switch of a row. A tool for "All agents" shows on and cannot change, and a
 * linked computer reads the rows and changes none of them (spec 012).
 */
export const switchOf = (
  row: ChannelToolRow,
  linked: boolean,
): { readonly checked: boolean; readonly disabled: boolean } => ({
  checked: row.on,
  disabled: linked || row.all,
})

/** The channels that give a tool to an agent, as the line "From <channel>" names them. */
export const fromChannels = (tool: AgentChannelTool): string =>
  tool.channels.map((channel) => channel.name).join(", ")
