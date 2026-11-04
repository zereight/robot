import {
  type AgentState,
  type ChartAgent,
  type ChartChannel,
  type ChartModel,
  type Face,
  ORG_CHANNEL_NODES_MAX,
  ORG_HANDOFF_LINES_MAX,
  ORG_STATES,
} from "@robot/shared"

// The list of the screen "Org chart" (spec 029, "Phone"; spec 011). The server sends a ready model
// of the chart. This file turns it into the rows of a list: the root, one block for each channel
// node, and the block of hand-offs. It holds no text of the interface and draws nothing. The
// screen translates the marks and draws the rows.

/** One agent row: a node that the page would draw. */
export interface OrgAgentRow {
  /** Unique in the list. A copy of an agent in a second channel has its own key. */
  readonly key: string
  readonly agentId: string
  readonly name: string
  /** The role line. It may be empty. */
  readonly role: string
  readonly face: Face
  readonly state: AgentState
  /** The label of the task, for an agent that works or waits for the user. Else null. */
  readonly label: string | null
  readonly isLead: boolean
}

/** A member that the block does not show at first. The row "+<n> more" lists them. */
export interface OrgMoreRow {
  readonly key: string
  readonly agentId: string
  readonly name: string
  readonly face: Face
  readonly state: AgentState
}

export interface OrgCount {
  readonly state: AgentState
  readonly count: number
}

export interface OrgBlock {
  /** `c:<channel id>`, or `c:none` for the block "No channel". */
  readonly key: string
  /** The channel that a tap on the header opens. Null for "No channel": the header opens nothing. */
  readonly channelId: string | null
  /** The name of the channel. Empty for "No channel": the screen writes it from the catalogue. */
  readonly name: string
  readonly memberCount: number
  /** The states that at least one member has, in the order working, waiting, idle, offline. */
  readonly counts: readonly OrgCount[]
  /** The lead first, then the others by name. At most 12. */
  readonly rows: readonly OrgAgentRow[]
  /** The members behind the row "+<n> more". Empty when every member has a row. */
  readonly more: readonly OrgMoreRow[]
  /**
   * 1 for a top channel and for "No channel". A sub-channel (030) is one more than its parent:
   * the screen indents its block one step for each level under the top.
   */
  readonly level: number
}

/** One hand-off line: "<sender> → <receiver>" and the number. */
export interface OrgHandoffRow {
  readonly key: string
  readonly from: string
  readonly to: string
  readonly count: number
}

/** The first row. */
export type OrgRoot =
  /** No main agent (or an archived one): the row "You". */
  | { readonly kind: "you" }
  /** The main agent: its row carries the mark "Main agent". */
  | { readonly kind: "main"; readonly agent: OrgAgentRow }

export interface OrgList {
  /** True when no agent exists: the screen shows the line "No agents yet." and nothing else. */
  readonly empty: boolean
  readonly root: OrgRoot
  readonly blocks: readonly OrgBlock[]
  /** The busiest first, at most 40. */
  readonly handoffs: readonly OrgHandoffRow[]
  /** True when the list was cut at 40: the screen adds the line "Showing the 40 busiest hand-offs." */
  readonly handoffsCapped: boolean
}

const agentRow = (node: ChartAgent): OrgAgentRow => ({
  key: node.key,
  agentId: node.agentId,
  name: node.name,
  role: node.role,
  face: node.face,
  state: node.state,
  // Only an agent that works or waits for the user shows a task. The label is the cut text that
  // the server sent, never more than the server decided to share.
  label: (node.state === "working" || node.state === "waiting") && node.label ? node.label : null,
  isLead: node.isLead,
})

const moreRow = (key: string, node: ChartAgent): OrgMoreRow => ({
  key,
  agentId: node.agentId,
  name: node.name,
  face: node.face,
  state: node.state,
})

const block = (channel: ChartChannel): OrgBlock => {
  // The server sends the lead first. A stable sort keeps the order of the others as sent.
  const nodes = [...channel.nodes].sort((a, b) => Number(b.isLead) - Number(a.isLead))
  // A server sends at most 12 nodes; a longer list is cut here too, and the rest goes behind the
  // row "+<n> more" before the members that the server did not send as nodes.
  const shown = nodes.slice(0, ORG_CHANNEL_NODES_MAX)
  const cut = nodes.slice(ORG_CHANNEL_NODES_MAX)
  return {
    key: channel.key,
    channelId: channel.channelId,
    name: channel.name,
    memberCount: channel.memberCount,
    counts: ORG_STATES.flatMap((state) =>
      channel.counts[state] > 0 ? [{ state, count: channel.counts[state] }] : [],
    ),
    rows: shown.map(agentRow),
    more: [
      ...cut.map((node) => moreRow(`${channel.key}/more/${node.agentId}`, node)),
      ...channel.more.map((m) => ({
        key: `${channel.key}/more/${m.agentId}`,
        agentId: m.agentId,
        name: m.name,
        face: m.face,
        state: m.state,
      })),
    ],
    // A server of an older build sends no level: every block is a top block.
    level: Math.max(1, Math.min(3, Math.floor(channel.level ?? 1))),
  }
}

/** Turns the ready model of a server into the rows of the list. */
export const buildOrgList = (model: ChartModel): OrgList => {
  const lines = model.lines.filter((line) => line.kind === "handoff")
  // The busiest first. A line with the same number keeps the place that the server gave it: the
  // server put the newest hand-off first. At most 40 rows, as on the page.
  const busiest = lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => (b.line.count ?? 0) - (a.line.count ?? 0) || a.index - b.index)
  return {
    empty: model.empty,
    root: model.root ? { kind: "main", agent: agentRow(model.root) } : { kind: "you" },
    blocks: model.empty ? [] : model.channels.map(block),
    handoffs: model.empty
      ? []
      : busiest.slice(0, ORG_HANDOFF_LINES_MAX).map(({ line }) => ({
          key: line.id,
          from: line.fromName ?? "",
          to: line.toName ?? "",
          count: line.count ?? 0,
        })),
    handoffsCapped: !model.empty && (model.handoffsCapped || lines.length > ORG_HANDOFF_LINES_MAX),
  }
}
