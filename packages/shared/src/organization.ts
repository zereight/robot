// The hand-off rule (spec 030, "Who can send to whom"). With the rule "Along the organizations", an
// agent can send a message only to some agents. These functions hold the six allow rules, the range
// of an organization, the list of the agents that a sender may send to, and the agent that a
// refused sender is told to use. They read the agents and the organizations as stored and say what
// is allowed now. A channel gives no right to send, so a channel is not in the model.

import { activeMembers, effectiveLead, type HandOffRange } from "./organizations.ts"
import { lowerOrgs, orgParents, type TreeOrg } from "./orgTree.ts"

/** The two values of the hand-off rule (spec 030). "Any agent" is the default. */
export const HAND_OFF_RULES = ["any", "organizations"] as const
export type HandOffRule = (typeof HAND_OFF_RULES)[number]
export const DEFAULT_HAND_OFF_RULE: HandOffRule = "any"

export const isHandOffRule = (value: unknown): value is HandOffRule =>
  typeof value === "string" && (HAND_OFF_RULES as readonly string[]).includes(value)

/**
 * The part "Hand-off rules" of the settings (spec 013, 030): data of the agents of a server. It
 * holds the hand-off rule and the switch "Ask up the line" (off at first).
 */
export interface Organization {
  readonly handOff: HandOffRule
  /** "Ask up the line": a question that the lead passes can go to higher agents (spec 030). */
  readonly askUpTheLine: boolean
}

export const DEFAULT_ASK_UP_THE_LINE = false

export const DEFAULT_ORGANIZATION: Organization = {
  handOff: DEFAULT_HAND_OFF_RULE,
  askUpTheLine: DEFAULT_ASK_UP_THE_LINE,
}

// ---------------------------------------------------------------------------------------------
// The range of an organization
// ---------------------------------------------------------------------------------------------

/** The range as it holds: never "Inherit". */
export type ResolvedRange = Exclude<HandOffRange, "inherit">

/** What the range rules need of an organization. */
export interface RangeOrg extends TreeOrg {
  readonly handOffRange: HandOffRange
}

/**
 * The range of an organization (spec 030, "Access"): its own value when it is not "Inherit",
 * otherwise the value of its parent, and so on up the tree. A top organization with "Inherit" has
 * "Own organization". `from` is the organization that holds the value, or null for that last case.
 */
export const handOffRange = (
  orgs: readonly RangeOrg[],
  id: string,
): { readonly value: ResolvedRange; readonly from: string | null } => {
  const byId = new Map(orgs.map((o) => [o.id, o]))
  const parents = orgParents(orgs)
  for (let at: string | null = id; at !== null; at = parents.get(at) ?? null) {
    const value = byId.get(at)?.handOffRange
    if (value !== undefined && value !== "inherit") return { value, from: at }
  }
  return { value: "own", from: null }
}

/**
 * The range that an organization under `parentId` takes when its own value is "Inherit": the range
 * of the parent. No parent, or a parent that does not exist: "Own organization", from no
 * organization. The form reads it for the parent that is chosen in the form.
 */
export const handOffRangeUnder = (
  orgs: readonly RangeOrg[],
  parentId: string | null,
): { readonly value: ResolvedRange; readonly from: string | null } =>
  parentId === null || !orgs.some((o) => o.id === parentId)
    ? { value: "own", from: null }
    : handOffRange(orgs, parentId)

/**
 * What the muted line "Now: <value> from <organization>" under "Inherit" shows (spec 030,
 * "Access"): the range that the higher organizations give. The value of the organization itself
 * does not count, because the line shows only when that value is "Inherit".
 */
export const handOffRangeNow = (
  orgs: readonly RangeOrg[],
  id: string,
): { readonly value: ResolvedRange; readonly from: string | null } =>
  handOffRangeUnder(orgs, orgParents(orgs).get(id) ?? null)

// ---------------------------------------------------------------------------------------------
// Who may send to whom
// ---------------------------------------------------------------------------------------------

export interface HandOffAgent {
  readonly id: string
  readonly name: string
  /** True while the agent is archived. Absent counts as not archived. */
  readonly archived?: boolean
}

export interface HandOffOrg extends RangeOrg {
  readonly name: string
  /** The lead as stored. An archived lead, and a lead that is not a member, count as no lead. */
  readonly leadId: string | null
  /** The members as stored. An archived member stays in the list and is skipped by every rule. */
  readonly memberIds: readonly string[]
}

/** What the rule reads: the agents of one server, its organizations, and its main agent (spec 002). */
export interface HandOffModel {
  readonly agents: readonly HandOffAgent[]
  readonly orgs: readonly HandOffOrg[]
  /** The main agent, or null. An archived main agent counts as none. */
  readonly mainAgentId: string | null
}

/** An agent that the sender may send to, and what links them. */
export interface SendTarget {
  readonly agentId: string
  readonly name: string
  /**
   * The names of the organizations that give the right (a shared one, the one that the sender
   * leads, or the one that holds the range), in order of name. Empty when none gives it.
   */
  readonly orgs: readonly string[]
  /** True when the receiver is the main agent (rule 2). */
  readonly main: boolean
}

const lower = (text: string) => text.toLowerCase()
const byName = (a: { name: string; id?: string }, b: { name: string; id?: string }) => {
  const x = lower(a.name)
  const y = lower(b.name)
  return x < y
    ? -1
    : x > y
      ? 1
      : (a.id ?? "") < (b.id ?? "")
        ? -1
        : (a.id ?? "") > (b.id ?? "")
          ? 1
          : 0
}

/** The facts that all the questions below read: who is alive, the leads, the members, the tree. */
const prepare = (model: HandOffModel) => {
  const agents = new Map(model.agents.map((a) => [a.id, a]))
  const archived = new Set(model.agents.filter((a) => a.archived === true).map((a) => a.id))
  const alive = (id: string | null | undefined): id is string =>
    !!id && agents.has(id) && !archived.has(id)
  const mainId = alive(model.mainAgentId) ? model.mainAgentId : null
  // The tree as it is now: a broken tree never counts (`orgParents`).
  const parents = orgParents(model.orgs)
  const byId = new Map(model.orgs.map((o) => [o.id, o]))
  /** The lead of an organization, or null: an archived lead counts as no lead (spec 030). */
  const leadOf = (org: HandOffOrg) => effectiveLead(org, archived)
  /** The members that are not archived and that exist. The lead is one of them. */
  const membersOf = (org: HandOffOrg) => activeMembers(org, archived).filter(alive)
  const parentOf = (org: HandOffOrg) => {
    const id = parents.get(org.id) ?? null
    return id === null ? undefined : byId.get(id)
  }
  /** The sub-organizations of an organization: its direct children in the tree. */
  const childrenOf = (org: HandOffOrg) =>
    model.orgs.filter((o) => parents.get(o.id) === org.id && o.id !== org.id)
  const lowerOf = (org: HandOffOrg) =>
    [...lowerOrgs(model.orgs, org.id)].flatMap((id) => byId.get(id) ?? [])
  return {
    agents,
    alive,
    mainId,
    orgs: model.orgs,
    leadOf,
    membersOf,
    parentOf,
    childrenOf,
    lowerOf,
  }
}

type Prepared = ReturnType<typeof prepare>

/**
 * The links of the rules 1, 4, 5 and 6: from an agent to the agents it may send to without the
 * main agent, with the organizations that give each right.
 * Rule 1: both are members of one organization.
 * Rule 4: the sender leads an organization C, and the receiver leads the parent organization of C
 * or a sub-organization of C.
 * Rule 5: the sender is a member of an organization with the range "Own and lower organizations",
 * and the receiver is a member of it or of a lower organization.
 * Rule 6: the sender is a member of an organization with the range "All agents".
 */
const orgLinks = (p: Prepared, from: string) => {
  const links = new Map<string, Set<string>>()
  const add = (to: string | null, org: string) => {
    if (to === null || to === from || to === p.mainId) return
    const set = links.get(to) ?? new Set<string>()
    set.add(org)
    links.set(to, set)
  }
  for (const org of p.orgs) {
    const mine = p.membersOf(org).includes(from)
    if (mine) {
      for (const member of p.membersOf(org)) add(member, org.name)
      const { value } = handOffRange(p.orgs, org.id)
      if (value === "own_lower") {
        for (const lowerOrg of p.lowerOf(org))
          for (const member of p.membersOf(lowerOrg)) add(member, org.name)
      }
      if (value === "all") {
        for (const agent of p.agents.keys()) add(p.alive(agent) ? agent : null, org.name)
      }
    }
    if (p.leadOf(org) === from) {
      const parent = p.parentOf(org)
      if (parent) add(p.leadOf(parent), org.name)
      for (const child of p.childrenOf(org)) add(p.leadOf(child), org.name)
    }
  }
  return links
}

/**
 * The agents that `from` may send to, by the six allow rules (spec 030), as a map from the id of
 * the receiver. The sender itself and archived agents are not in it.
 */
const sendsFrom = (p: Prepared, from: string): Map<string, SendTarget> => {
  const links = orgLinks(p, from)
  const out = new Map<string, SendTarget>()
  const put = (id: string, main: boolean) => {
    const agent = p.agents.get(id)
    if (!agent || id === from || !p.alive(id)) return
    out.set(id, {
      agentId: id,
      name: agent.name,
      orgs: [...(links.get(id) ?? [])].sort((a, b) => (lower(a) < lower(b) ? -1 : 1)),
      main,
    })
  }
  if (p.mainId === from) {
    // Rule 3: the main agent may send to every agent that is not archived.
    for (const agent of p.agents.values()) put(agent.id, false)
  } else {
    for (const id of links.keys()) put(id, false)
    // Rule 2: every agent may send to the main agent.
    if (p.mainId !== null) put(p.mainId, true)
  }
  return out
}

/**
 * The agents that `from` may send to under the rule "Along the organizations" (spec 030), in order
 * of name. The sender itself, archived agents and agents of another server are not in the list. The
 * main agent may send to every agent, and every agent may send to the main agent.
 */
export const allowedSends = (model: HandOffModel, from: string): SendTarget[] =>
  [...sendsFrom(prepare(model), from).values()].sort((a, b) =>
    byName({ name: a.name, id: a.agentId }, { name: b.name, id: b.agentId }),
  )

/** True when the rule "Along the organizations" lets `from` send a message to `to`. */
export const handOffAllowed = (model: HandOffModel, from: string, to: string): boolean =>
  allowedSends(model, from).some((t) => t.agentId === to)

/**
 * The agent that a refused sender is told to use (spec 030): the second agent of the shortest
 * chain from the sender to the receiver. A chain is a row of agents in which each agent may send to
 * the next one by the six allow rules, so a chain may pass the main agent. Among the first agents
 * that give a chain of the same length, the lead of an organization of the sender comes first, then the
 * main agent, then the other agents in the order of their names, ignoring case. Null when the
 * sender has no chain to the receiver: no agent can pass the work on, and the sender must tell the
 * user.
 */
export const firstOnPath = (
  model: HandOffModel,
  from: string,
  to: string,
): { id: string; name: string } | null => {
  const p = prepare(model)
  const nameOf = (id: string) => (p.agents.get(id) as HandOffAgent).name
  // Who may send to whom, for every agent that is not archived. A sender and a receiver that is
  // archived (or unknown) have no link, so no chain reaches them.
  const out = new Map<string, readonly string[]>()
  const into = new Map<string, string[]>()
  for (const agent of p.agents.values()) {
    if (!p.alive(agent.id)) continue
    const next = [...sendsFrom(p, agent.id).keys()]
    out.set(agent.id, next)
    for (const id of next) into.set(id, [...(into.get(id) ?? []), agent.id])
  }
  // The number of sends from each agent to the receiver, by a search from the receiver backwards.
  const dist = new Map<string, number>([[to, 0]])
  const queue = [to]
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as string
    for (const before of into.get(at) ?? []) {
      if (dist.has(before)) continue
      dist.set(before, (dist.get(at) as number) + 1)
      queue.push(before)
    }
  }
  const mine = dist.get(from)
  // No chain, or the sender is the receiver.
  if (mine === undefined || mine === 0) return null
  // Every agent that the sender may send to and that is one send closer to the receiver.
  const firsts = (out.get(from) ?? []).filter((id) => dist.get(id) === mine - 1)
  // The leads of the organizations of the sender (an organization of the sender is one that it is a
  // member of). A lead that the sender reaches only by rule 4 is not in this set.
  const leadsOfMine = new Set<string>()
  for (const org of p.orgs) {
    if (!p.membersOf(org).includes(from)) continue
    const lead = p.leadOf(org)
    if (lead !== null && lead !== from) leadsOfMine.add(lead)
  }
  const tier = (id: string) => (leadsOfMine.has(id) ? 0 : id === p.mainId ? 1 : 2)
  const named = firsts.map((id) => ({ id, name: nameOf(id) }))
  named.sort((a, b) => tier(a.id) - tier(b.id) || byName(a, b))
  return named[0] ?? null
}

/** What a refused send tells the sender (spec 030). */
export interface HandOffRefusal {
  /** The agent to send to instead, or null when no agent can pass the work on. */
  readonly next: { id: string; name: string } | null
}

/**
 * Checks one send under the rule "Along the organizations". Returns undefined when the send may go, and
 * the refusal when it may not.
 */
export const checkHandOff = (
  model: HandOffModel,
  from: string,
  to: string,
): HandOffRefusal | undefined =>
  handOffAllowed(model, from, to) ? undefined : { next: firstOnPath(model, from, to) }

// ---------------------------------------------------------------------------------------------
// Words that the agent reads (spec 030). They are English, like the other texts for the model.
// ---------------------------------------------------------------------------------------------

/** The reason that a refused sender gets as a failed step (spec 030). */
export const handOffRefusalText = (receiver: string, next: string | null) =>
  next === null
    ? `${receiver} is not on your path, and no agent can pass it on. Tell the user.`
    : `${receiver} is not on your path. Send it to ${next}.`

/** The first line of the answer of "list agents" while the rule is on (spec 030). */
export const HAND_OFF_LIST_RULE =
  "The hand-off rule is on: you can send a message only to the agents on this list. Work for other agents goes through the agents on this list."

/** The answer of "list agents" while the rule is on and the sender may send to no agent. */
export const HAND_OFF_LIST_EMPTY =
  "The hand-off rule is on, and you can send a message to no agent. If work needs another agent, tell the user."

/**
 * The link of one row of "list agents": the organizations that give the right, or "main agent" when
 * the receiver is the main agent or no organization gives the right (the main agent sends to every
 * agent).
 */
export const handOffLink = (target: SendTarget): string =>
  target.main || target.orgs.length === 0 ? "main agent" : `organization: ${target.orgs.join(", ")}`

/**
 * Told to the main agent while the rule is on (spec 030): every agent can bring work to it, and it
 * passes the work on along the organizations, to the lead of an organization when the organization
 * has one.
 */
export const MAIN_AGENT_HAND_OFF_RULE =
  "The hand-off rule is on. Every agent can send work to you. Pass work on along the organizations: send it to the lead of an organization when the organization has one."
