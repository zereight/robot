import type { AgentState, Face } from "./agents.ts"
import { DEFAULT_HAND_OFF_RULE, type HandOffRule } from "./organization.ts"
import { orgParents } from "./orgTree.ts"

// The org chart (spec 029). The chart stores nothing. A snapshot is read from the agents, the
// organizations (spec 030) and the tasks of a server. The functions below turn a snapshot into the nodes and lines
// of the chart. They hold no layout: the window computes the positions.

/** An organization node draws at most this many agent nodes. More members go behind the tile "+<n> more". */
export const ORG_NODES_MAX = 12
/** The chart draws at most this many hand-off lines. */
export const ORG_HANDOFF_LINES_MAX = 40
/** A hand-off counts for this many days after its task was made. The window is not a setting. */
export const ORG_HANDOFF_DAYS = 7
export const ORG_HANDOFF_WINDOW_MS = ORG_HANDOFF_DAYS * 24 * 60 * 60 * 1000
/** The label of a running task is cut at this many characters. */
export const ORG_LABEL_MAX = 90
/** The goal of an organization is cut at this many characters on its node (spec 029). */
export const ORG_GOAL_LINE_MAX = 120
/** A state of an agent, in the order that the counts of an organization node use. */
export const ORG_STATES = [
  "working",
  "waiting",
  "idle",
  "offline",
] as const satisfies readonly AgentState[]

/**
 * What a task that an agent runs now shows on its node. A task that waits for the user has the
 * state `waiting`; every other running task has `running`.
 */
export interface OrgTask {
  readonly label: string
  readonly state: "running" | "waiting"
}

/** One agent that is not archived. */
export interface OrgAgent {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly face: Face
  readonly state: AgentState
  /** The task that runs now (`working` or `waiting`), or null. */
  readonly task: OrgTask | null
}

/** One organization. Its members are the members that are not archived. */
export interface OrgChartOrg {
  readonly id: string
  readonly name: string
  /** Why the organization exists, in the words of the user (spec 030, "Goal"). Empty at the start. */
  readonly goal?: string
  readonly createdAt: number
  /** The lead, or null. A lead that is archived or not a member counts as no lead. */
  readonly leadId: string | null
  readonly memberIds: readonly string[]
  /** The parent organization as stored (spec 030), or null. One that is not in the snapshot counts as none. */
  readonly parentId: string | null
}

/** The tasks that one agent handed to another with the tool "send message" in the window. */
export interface OrgHandoff {
  readonly from: string
  readonly to: string
  readonly count: number
  /** When the newest of these tasks was made. It orders lines of the same count. */
  readonly newest: number
}

/**
 * The work of one agent that ended in the window of 7 days (spec 029, "Organization node"). The
 * chart adds these up for the members that an organization node draws.
 */
export interface OrgOutcome {
  readonly agentId: string
  /** Tasks that ended as done. */
  readonly done: number
  /** Tasks that ended as blocked. */
  readonly blocked: number
  /** Verdicts "Met" of parts of a channel (spec 004, 005). */
  readonly met: number
  /** Verdicts "Not met" of parts of a channel. */
  readonly notMet: number
}

/** The counts of an organization node's outcome line, in the order of the words. */
export interface OutcomeCounts {
  readonly done: number
  readonly blocked: number
  readonly met: number
  readonly notMet: number
}

export const NO_OUTCOME: OutcomeCounts = { done: 0, blocked: 0, met: 0, notMet: 0 }

/** The four words of the outcome line, in the order that the node shows them (spec 029). */
export const OUTCOME_WORDS = ["done", "blocked", "met", "not_met"] as const
export type OutcomeWord = (typeof OUTCOME_WORDS)[number]

const OUTCOME_OF_WORD: Readonly<Record<OutcomeWord, keyof OutcomeCounts>> = {
  done: "done",
  blocked: "blocked",
  met: "met",
  not_met: "notMet",
}

/** The outcome counts as pairs, without zeros, in the order done, blocked, met, not met. */
export const outcomeList = (counts: OutcomeCounts) =>
  OUTCOME_WORDS.flatMap((word) => {
    const count = counts[OUTCOME_OF_WORD[word]]
    return count > 0 ? [{ word, count }] : []
  })

/** What the server reads for the chart. */
export interface OrgSnapshot {
  /** The main agent, or null. With none (or an archived one) the root is "You". */
  readonly mainAgentId: string | null
  readonly agents: readonly OrgAgent[]
  readonly orgs: readonly OrgChartOrg[]
  readonly handoffs: readonly OrgHandoff[]
  /**
   * The work that ended in the window of 7 days, for each agent (spec 029, "Organization node").
   * Absent counts as none, so a snapshot of an older step reads as it did.
   */
  readonly outcomes?: readonly OrgOutcome[]
  /** The hand-off rule (spec 030). Absent counts as "Any agent", as for a server of an older step. */
  readonly handOffRule?: HandOffRule
}

/** The empty snapshot: a profile with no agent. */
export const EMPTY_ORG_SNAPSHOT: OrgSnapshot = {
  mainAgentId: null,
  agents: [],
  orgs: [],
  handoffs: [],
  handOffRule: DEFAULT_HAND_OFF_RULE,
}

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

export type StateCounts = Readonly<Record<AgentState, number>>

export const NO_ORG_KEY = "o:none"
export const ROOT_KEY = "root"

/** The node of an agent: the root, or one copy in an organization node. */
export interface ChartAgent {
  /** The key of this node. A copy in each organization node has its own key. */
  readonly key: string
  readonly agentId: string
  /** The key of the organization node that holds it, or `root`. */
  readonly parent: string
  readonly name: string
  readonly role: string
  readonly face: Face
  readonly state: AgentState
  /** The label of the running task, cut at 90 characters. Null when the agent does not work. */
  readonly label: string | null
  readonly isLead: boolean
  /** The names of the organizations of the other copies of this agent, in the order of the page. */
  readonly alsoIn: readonly string[]
  /** How many agents this agent handed work to, and how many handed work to it. */
  readonly handedTo: number
  readonly gotFrom: number
}

/** A member that an organization node does not draw. A click on the tile "+<n> more" lists them. */
export interface ChartOverflow {
  readonly agentId: string
  readonly name: string
  readonly face: Face
  readonly state: AgentState
}

export interface ChartOrg {
  /** `o:<organization id>`, or `o:none` for the organization node "No organization". */
  readonly key: string
  /** Null for the organization node "No organization": the window writes its name from the catalogue. */
  readonly orgId: string | null
  readonly name: string
  /** The goal of the organization, cut with "…" for the node, or null when it has none (spec 030). */
  readonly goal: string | null
  /** The whole goal, for the note and the accessible name of the node. Null when there is none. */
  readonly goalFull: string | null
  readonly memberCount: number
  readonly counts: StateCounts
  /** The agent nodes that are drawn: the lead first, then the others by name. At most 12. */
  readonly nodes: readonly ChartAgent[]
  /** The key of the lead node, or null. */
  readonly leadKey: string | null
  /** The members that are not drawn. Empty when all are drawn. */
  readonly more: readonly ChartOverflow[]
  /**
   * The work of the drawn members that ended in the last 7 days (spec 029, "Organization node").
   * The node shows one line of counts, or none when every count is 0.
   */
  readonly outcome: OutcomeCounts
  /**
   * The key of the organization node of the parent organization (spec 030), or null for a top
   * organization node and for "No organization": those hang from the root.
   */
  readonly parentKey: string | null
  /** 1 for a top organization node and for "No organization", 2 for a sub-organization, 3 for the next level. */
  readonly level: number
}

export type ChartLineKind = "lead" | "handoff" | "structure"

export interface ChartLine {
  /** Unique in the model. */
  readonly id: string
  readonly kind: ChartLineKind
  /** The keys of the nodes at the ends. An organization node has a key too. */
  readonly from: string
  readonly to: string
  /** The number of hand-offs, for a hand-off line. */
  readonly count?: number
  /** The agent names at the ends of a hand-off line. */
  readonly fromName?: string
  readonly toName?: string
}

export interface ChartModel {
  /** The root: the main agent, or null for "You". */
  readonly root: ChartAgent | null
  readonly orgs: readonly ChartOrg[]
  readonly lines: readonly ChartLine[]
  /** True when more than 40 hand-off lines were possible and the chart draws the 40 busiest. */
  readonly handoffsCapped: boolean
  /** True when no agent exists: the page shows no canvas. */
  readonly empty: boolean
  /**
   * The hand-off rule (spec 030). With "Along the organizations" the legend ends with the muted
   * line "Hand-offs follow the organizations." Absent counts as "Any agent".
   */
  readonly handOffRule?: HandOffRule
}

/** Cuts a label at `max` characters (the sign for a cut counts) and joins the white space. */
export const cutLabel = (text: string, max = ORG_LABEL_MAX): string => {
  const line = text.replace(/\s+/g, " ").trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line
}

/** The goal of an organization as one line for its node, or null when it has none (spec 029). */
export const goalLine = (goal: string): string | null => {
  const line = cutLabel(goal, ORG_GOAL_LINE_MAX)
  return line === "" ? null : line
}

const lower = (text: string) => text.toLowerCase()
/** Order by text without case, then by id. It does not depend on the language of the computer. */
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => {
  const x = lower(a.name)
  const y = lower(b.name)
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The order of the organization nodes: by name without case, the older first on a tie, then by id. */
export const compareOrgs = (a: OrgChartOrg, b: OrgChartOrg) => {
  const x = lower(a.name)
  const y = lower(b.name)
  if (x !== y) return x < y ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const emptyCounts = (): Record<AgentState, number> => ({
  working: 0,
  waiting: 0,
  idle: 0,
  offline: 0,
})

/**
 * The organization nodes that a snapshot has, in the order of the page (spec 029, 030): every
 * organization, also one with no member. Each top organization node comes by name, and under it its
 * sub-organization nodes by name, and so on. A parent that breaks the rules of the tree counts as
 * none (`orgParents`), so the page stays safe before the repair of 030.
 */
const orgsOf = (snapshot: OrgSnapshot) => {
  const known = new Set(snapshot.agents.map((a) => a.id))
  const parents = orgParents(snapshot.orgs)
  const cleaned = snapshot.orgs.map((o) => {
    const seen = new Set<string>()
    const memberIds = o.memberIds.filter((id) => {
      if (!known.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    return {
      ...o,
      memberIds,
      leadId: o.leadId && seen.has(o.leadId) ? o.leadId : null,
      parentId: parents.get(o.id) ?? null,
    }
  })
  const children = new Map<string | null, typeof cleaned>()
  for (const o of cleaned) children.set(o.parentId, [...(children.get(o.parentId) ?? []), o])
  for (const list of children.values()) list.sort(compareOrgs)
  const out: ((typeof cleaned)[number] & { level: number })[] = []
  const walk = (parent: string | null, level: number) => {
    for (const o of children.get(parent) ?? []) {
      out.push({ ...o, level })
      walk(o.id, level + 1)
    }
  }
  walk(null, 1)
  return out
}

/** The key of the node of an agent copy. */
export const copyKey = (orgKey: string, agentId: string) => `${orgKey}/${agentId}`

/** The rule goes into the model only when it is "Along the organizations"; "Any agent" is the absence. */
const ruleOf = (snapshot: OrgSnapshot): { handOffRule?: HandOffRule } =>
  snapshot.handOffRule === "organizations" ? { handOffRule: "organizations" } : {}

/**
 * Turns a snapshot into the nodes and lines of the chart (spec 029): the root, the organization
 * nodes with their copies of agents, the caps of 12 nodes and 40 hand-off lines, and the lines.
 */
export const buildChart = (snapshot: OrgSnapshot): ChartModel => {
  if (snapshot.agents.length === 0 && snapshot.orgs.length === 0) {
    return {
      root: null,
      orgs: [],
      lines: [],
      handoffsCapped: false,
      empty: true,
      ...ruleOf(snapshot),
    }
  }
  const agents = new Map(snapshot.agents.map((a) => [a.id, a]))
  const main = snapshot.mainAgentId ? agents.get(snapshot.mainAgentId) : undefined
  const orgs = orgsOf(snapshot)

  // The outcome of each agent, for the line under the header of an organization node (spec 029).
  const outcomeByAgent = new Map((snapshot.outcomes ?? []).map((o) => [o.agentId, o] as const))
  const outcomeOf = (members: readonly OrgAgent[]): OutcomeCounts => {
    const out = { done: 0, blocked: 0, met: 0, notMet: 0 }
    for (const m of members) {
      const o = outcomeByAgent.get(m.id)
      if (!o) continue
      out.done += o.done
      out.blocked += o.blocked
      out.met += o.met
      out.notMet += o.notMet
    }
    return out
  }

  // Which agents are in an organization node. The others go to "No organization".
  const inOrg = new Set(orgs.flatMap((o) => o.memberIds))
  const loose = snapshot.agents.filter((a) => !inOrg.has(a.id)).sort(byName)

  // The groups of the page, in order: each organization node, then "No organization".
  interface Group {
    readonly key: string
    readonly orgId: string | null
    readonly name: string
    readonly goal: string
    readonly leadId: string | null
    readonly members: readonly OrgAgent[]
    readonly parentKey: string | null
    readonly level: number
  }
  const groups: Group[] = orgs.map((o) => {
    const members = o.memberIds.flatMap((id) => agents.get(id) ?? [])
    // The lead first, then the other members by name without case.
    const lead = o.leadId ? members.find((m) => m.id === o.leadId) : undefined
    const rest = members.filter((m) => m !== lead).sort(byName)
    return {
      key: `o:${o.id}`,
      orgId: o.id,
      name: o.name,
      goal: o.goal ?? "",
      leadId: lead?.id ?? null,
      members: lead ? [lead, ...rest] : rest,
      parentKey: o.parentId ? `o:${o.parentId}` : null,
      level: o.level,
    }
  })
  if (loose.length > 0) {
    groups.push({
      key: NO_ORG_KEY,
      orgId: null,
      name: "",
      goal: "",
      leadId: null,
      members: loose,
      parentKey: null,
      level: 1,
    })
  }

  // The hand-offs between agents that exist. Each agent counts the agents on its two sides.
  const handoffs = snapshot.handoffs.filter(
    (h) => h.count > 0 && h.from !== h.to && agents.has(h.from) && agents.has(h.to),
  )
  const gave = new Map<string, Set<string>>()
  const got = new Map<string, Set<string>>()
  for (const h of handoffs) {
    gave.set(h.from, (gave.get(h.from) ?? new Set()).add(h.to))
    got.set(h.to, (got.get(h.to) ?? new Set()).add(h.from))
  }

  // The names of the organizations of every copy of an agent, for the line "Also in <organization>".
  const orgsOfAgent = new Map<string, { key: string; name: string }[]>()
  for (const g of groups) {
    if (g.orgId === null) continue
    for (const m of g.members) {
      orgsOfAgent.set(m.id, [...(orgsOfAgent.get(m.id) ?? []), { key: g.key, name: g.name }])
    }
  }

  const node = (a: OrgAgent, parent: string, key: string, isLead: boolean): ChartAgent => ({
    key,
    agentId: a.id,
    parent,
    name: a.name,
    role: a.role,
    face: a.face,
    state: a.state,
    label: a.task ? cutLabel(a.task.label) || null : null,
    isLead,
    alsoIn: (orgsOfAgent.get(a.id) ?? []).filter((o) => o.key !== parent).map((o) => o.name),
    handedTo: gave.get(a.id)?.size ?? 0,
    gotFrom: got.get(a.id)?.size ?? 0,
  })

  const orgNodes: ChartOrg[] = groups.map((g) => {
    const counts = emptyCounts()
    for (const m of g.members) counts[m.state]++
    const drawn = g.members.slice(0, ORG_NODES_MAX)
    const nodes = drawn.map((m) => node(m, g.key, copyKey(g.key, m.id), m.id === g.leadId))
    return {
      key: g.key,
      orgId: g.orgId,
      name: g.name,
      // The node shows one line, and the note and the accessible name hold the whole goal.
      goal: goalLine(g.goal),
      goalFull: g.goal.trim() === "" ? null : g.goal,
      memberCount: g.members.length,
      counts,
      nodes,
      leadKey: g.leadId ? copyKey(g.key, g.leadId) : null,
      more: g.members.slice(ORG_NODES_MAX).map((m) => ({
        agentId: m.id,
        name: m.name,
        face: m.face,
        state: m.state,
      })),
      // The outcome covers the members that the node draws, as the spec says (spec 029).
      outcome: outcomeOf(drawn),
      parentKey: g.parentKey,
      level: g.level,
    }
  })

  const root = main ? node(main, ROOT_KEY, ROOT_KEY, false) : null

  // The home node of an agent: the root for the main agent, else its copy in the first organization
  // node. A copy that is not drawn leaves the agent without a home node on the chart.
  const home = new Map<string, string>()
  if (root) home.set(root.agentId, ROOT_KEY)
  const firstCopy = new Map<string, { key: string; drawn: boolean }>()
  for (const g of groups) {
    g.members.forEach((m, i) => {
      if (firstCopy.has(m.id)) return
      firstCopy.set(m.id, {
        key: copyKey(g.key, m.id),
        drawn: i < ORG_NODES_MAX,
      })
    })
  }
  for (const [id, copy] of firstCopy) {
    if (!home.has(id) && copy.drawn) home.set(id, copy.key)
  }

  const lines: ChartLine[] = []
  // Structure lines: the root to each top organization node, an organization node to the
  // organization nodes of its sub-organizations, and an organization node to its lead, or to its
  // members.
  for (const c of orgNodes) {
    const up = c.parentKey ?? ROOT_KEY
    lines.push({ id: `s:${up}>${c.key}`, kind: "structure", from: up, to: c.key })
    if (c.leadKey) {
      lines.push({ id: `s:${c.key}>${c.leadKey}`, kind: "structure", from: c.key, to: c.leadKey })
    } else {
      for (const n of c.nodes) {
        lines.push({ id: `s:${c.key}>${n.key}`, kind: "structure", from: c.key, to: n.key })
      }
    }
  }
  // Lead lines: the lead to each other member that is drawn.
  for (const c of orgNodes) {
    if (!c.leadKey) continue
    for (const n of c.nodes) {
      if (n.key === c.leadKey) continue
      lines.push({ id: `l:${c.leadKey}>${n.key}`, kind: "lead", from: c.leadKey, to: n.key })
    }
  }

  // Hand-off lines between home nodes that are drawn: the busiest 40, the newest first on a tie.
  const names = new Map(snapshot.agents.map((a) => [a.id, a.name]))
  const drawable = handoffs
    .filter((h) => home.has(h.from) && home.has(h.to) && home.get(h.from) !== home.get(h.to))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.newest - a.newest ||
        (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
        (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
    )
  for (const h of drawable.slice(0, ORG_HANDOFF_LINES_MAX)) {
    lines.push({
      id: `h:${h.from}>${h.to}`,
      kind: "handoff",
      from: home.get(h.from) as string,
      to: home.get(h.to) as string,
      count: h.count,
      fromName: names.get(h.from) ?? "",
      toName: names.get(h.to) ?? "",
    })
  }

  return {
    root,
    orgs: orgNodes,
    lines,
    handoffsCapped: drawable.length > ORG_HANDOFF_LINES_MAX,
    empty: false,
    ...ruleOf(snapshot),
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the chart
// ---------------------------------------------------------------------------------------------

/**
 * Every key of a node of the model, in the order of the page: the root, then each organization node
 * followed by its agents and then the organization nodes of its sub-organizations (the
 * organizations of the model are in that order).
 */
export const chartOrder = (model: ChartModel): string[] => [
  ROOT_KEY,
  ...model.orgs.flatMap((o) => [o.key, ...o.nodes.map((n) => n.key)]),
]

/** The agent node (or the root) with this key. */
export const findAgent = (model: ChartModel, key: string): ChartAgent | undefined =>
  key === ROOT_KEY
    ? (model.root ?? undefined)
    : model.orgs.flatMap((o) => o.nodes).find((n) => n.key === key)

/**
 * What stays lit when the user points at a node (spec 029, "The page"): the lines of the node, the
 * nodes at the other end of them, and its copies. Everything else dims.
 */
export const litBy = (model: ChartModel, key: string) => {
  const nodes = new Set<string>([key])
  const lines = new Set<string>()
  for (const line of model.lines) {
    if (line.from !== key && line.to !== key) continue
    lines.add(line.id)
    nodes.add(line.from)
    nodes.add(line.to)
  }
  const self = findAgent(model, key)
  if (self) {
    // The copies of the same agent, also the root when the main agent has one.
    if (model.root?.agentId === self.agentId) nodes.add(ROOT_KEY)
    for (const o of model.orgs) {
      for (const n of o.nodes) if (n.agentId === self.agentId) nodes.add(n.key)
    }
  }
  return { nodes, lines }
}

/** The state counts of an organization node as pairs, in the order working, waiting, idle, offline, without zeros. */
export const countList = (counts: StateCounts) =>
  ORG_STATES.flatMap((state) => (counts[state] > 0 ? [{ state, count: counts[state] }] : []))

/**
 * True when a model from a linked server draws organizations. A server of an older step sends a
 * model of channels (no `orgs`); the client then shows "Open this on <server name>." as for a
 * server that does not know the request (spec 012, "Messages").
 */
export const isOrgModel = (model: unknown): model is ChartModel =>
  typeof model === "object" && model !== null && Array.isArray((model as ChartModel).orgs)
