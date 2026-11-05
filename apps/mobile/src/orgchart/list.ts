import {
  type AgentState,
  type ChartAgent,
  type ChartModel,
  type ChartOrg,
  type Face,
  NO_OUTCOME,
  ORG_HANDOFF_LINES_MAX,
  ORG_NODES_MAX,
  ORG_STATES,
  type OutcomeWord,
  outcomeList,
} from "@robot/shared"

// The list of the screen "Org chart" (spec 029, "Phone"; spec 011). The server sends a ready model
// of the chart. This file turns it into the rows of a list: the root, one block for each organization
// node, and the block of hand-offs. It holds no text of the interface and draws nothing. The
// screen translates the marks and draws the rows.

/** One agent row: a node that the page would draw. */
export interface OrgAgentRow {
  /** Unique in the list. A copy of an agent in a second organization has its own key. */
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

/** One count of the outcome line of a block: "done", "blocked", "met" or "not_met" (spec 029). */
export interface OrgOutcomeCount {
  readonly word: OutcomeWord
  readonly count: number
}

export interface OrgBlock {
  /** `o:<organization id>`, or `o:none` for the block "No organization". */
  readonly key: string
  /** The organization of the block. Null for "No organization". A tap on the header opens nothing (spec 029, "Phone"). */
  readonly orgId: string | null
  /** The name of the organization. Empty for "No organization": the screen writes it from the catalogue. */
  readonly name: string
  readonly memberCount: number
  /** The states that at least one member has, in the order working, waiting, idle, offline. */
  readonly counts: readonly OrgCount[]
  /**
   * The work of the drawn members in the last 7 days (spec 029, "Organization node"), without the
   * zeros, in the order done, blocked, met, not met. Empty when every count is 0.
   */
  readonly outcome: readonly OrgOutcomeCount[]
  /** The lead first, then the others by name. At most 12. */
  readonly rows: readonly OrgAgentRow[]
  /** The members behind the row "+<n> more". Empty when every member has a row. */
  readonly more: readonly OrgMoreRow[]
  /**
   * 1 for a top organization and for "No organization". A sub-organization (030) is one more than its parent:
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

const block = (org: ChartOrg): OrgBlock => {
  // The server sends the lead first. A stable sort keeps the order of the others as sent.
  const nodes = [...org.nodes].sort((a, b) => Number(b.isLead) - Number(a.isLead))
  // A server sends at most 12 nodes; a longer list is cut here too, and the rest goes behind the
  // row "+<n> more" before the members that the server did not send as nodes.
  const shown = nodes.slice(0, ORG_NODES_MAX)
  const cut = nodes.slice(ORG_NODES_MAX)
  return {
    key: org.key,
    orgId: org.orgId,
    name: org.name,
    memberCount: org.memberCount,
    counts: ORG_STATES.flatMap((state) =>
      org.counts[state] > 0 ? [{ state, count: org.counts[state] }] : [],
    ),
    // A server of an older build sends no outcome: the block shows no line.
    outcome: outcomeList(org.outcome ?? NO_OUTCOME),
    rows: shown.map(agentRow),
    more: [
      ...cut.map((node) => moreRow(`${org.key}/more/${node.agentId}`, node)),
      ...org.more.map((m) => ({
        key: `${org.key}/more/${m.agentId}`,
        agentId: m.agentId,
        name: m.name,
        face: m.face,
        state: m.state,
      })),
    ],
    // A server of an older build sends no level: every block is a top block.
    level: Math.max(1, Math.min(3, Math.floor(org.level ?? 1))),
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
    blocks: model.empty ? [] : model.orgs.map(block),
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
