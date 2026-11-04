// The hand-off rule (spec 030, "Who can send to whom"). With the rule "Along the channels", an agent
// can send a message only to some agents. These functions hold the four allow rules, the list of
// the agents that a sender may send to, and the agent that a refused sender is told to use. They
// read the agents and the channels as stored and say what is allowed now.

import { type TreeChannel, treeParents } from "./channelTree.ts"

/** The two values of the hand-off rule (spec 030). "Any agent" is the default. */
export const HAND_OFF_RULES = ["any", "channels"] as const
export type HandOffRule = (typeof HAND_OFF_RULES)[number]
export const DEFAULT_HAND_OFF_RULE: HandOffRule = "any"

export const isHandOffRule = (value: unknown): value is HandOffRule =>
  typeof value === "string" && (HAND_OFF_RULES as readonly string[]).includes(value)

/**
 * The part "Organization" of the settings (spec 013, 030): data of the agents of a server. The
 * switch "Ask up the line" joins it in a later slice.
 */
export interface Organization {
  readonly handOff: HandOffRule
}

export const DEFAULT_ORGANIZATION: Organization = { handOff: DEFAULT_HAND_OFF_RULE }

// ---------------------------------------------------------------------------------------------
// Who may send to whom
// ---------------------------------------------------------------------------------------------

export interface HandOffAgent {
  readonly id: string
  readonly name: string
  /** True while the agent is archived. Absent counts as not archived. */
  readonly archived?: boolean
}

export interface HandOffChannel {
  readonly id: string
  readonly name: string
  /** True while the channel is archived. An archived channel gives no right (spec 030). */
  readonly archived?: boolean
  /** The parent channel as stored (spec 030). The tree rules decide what counts. */
  readonly parentId: string | null
  readonly leadId: string | null
  readonly memberIds: readonly string[]
}

/** What the rule reads: the agents of one server, its channels, and its main agent (spec 002). */
export interface HandOffModel {
  readonly agents: readonly HandOffAgent[]
  readonly channels: readonly HandOffChannel[]
  /** The main agent, or null. An archived main agent counts as none. */
  readonly mainAgentId: string | null
}

/** An agent that the sender may send to, and what links them. */
export interface SendTarget {
  readonly agentId: string
  readonly name: string
  /** The names of the channels that link the two, in order of name. Empty when none links them. */
  readonly channels: readonly string[]
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

/** The facts that all the questions below read: who is alive, the open channels, the tree. */
const prepare = (model: HandOffModel) => {
  const agents = new Map(model.agents.map((a) => [a.id, a]))
  const alive = (id: string | null | undefined): id is string => {
    if (!id) return false
    const agent = agents.get(id)
    return agent !== undefined && agent.archived !== true
  }
  const mainId = alive(model.mainAgentId) ? model.mainAgentId : null
  const open = model.channels.filter((c) => !c.archived)
  const byId = new Map(open.map((c) => [c.id, c]))
  // The tree as it is now: an archived parent counts as none, and a broken tree never counts.
  const parents = treeParents(model.channels as readonly TreeChannel[])
  /** The lead of a channel, or null: an archived lead counts as no lead (spec 004). */
  const leadOf = (channel: HandOffChannel) => (alive(channel.leadId) ? channel.leadId : null)
  /** The members that are not archived. The lead is a member. */
  const membersOf = (channel: HandOffChannel) => {
    const ids = new Set(channel.memberIds)
    if (channel.leadId) ids.add(channel.leadId)
    return [...ids].filter(alive)
  }
  /** The open sub-channels of a channel: its direct children in the tree. */
  const childrenOf = (channelId: string) =>
    open.filter((c) => parents.get(c.id) === channelId && c.id !== channelId)
  const parentOf = (channel: HandOffChannel) => {
    const id = parents.get(channel.id) ?? null
    return id === null ? undefined : byId.get(id)
  }
  return { agents, alive, mainId, open, leadOf, membersOf, childrenOf, parentOf }
}

type Prepared = ReturnType<typeof prepare>

/**
 * The links of rules 1 and 4: from an agent to the agents it may send to without the main agent.
 * Rule 1: both are members of one channel that is not archived. Rule 4: the sender leads a channel
 * C, and the receiver leads the parent channel of C or a sub-channel of C.
 */
const channelLinks = (p: Prepared, from: string) => {
  const links = new Map<string, Set<string>>()
  const add = (to: string | null, channel: string) => {
    if (to === null || to === from || to === p.mainId) return
    const set = links.get(to) ?? new Set<string>()
    set.add(channel)
    links.set(to, set)
  }
  for (const channel of p.open) {
    if (p.membersOf(channel).includes(from)) {
      for (const member of p.membersOf(channel)) add(member, channel.name)
    }
    if (p.leadOf(channel) === from) {
      const parent = p.parentOf(channel)
      if (parent) add(p.leadOf(parent), channel.name)
      for (const child of p.childrenOf(channel.id)) add(p.leadOf(child), channel.name)
    }
  }
  return links
}

/**
 * The agents that `from` may send to under the rule "Along the channels" (spec 030), in order of
 * name. The sender itself, archived agents and agents of another server are not in the list. The
 * main agent may send to every agent, and every agent may send to the main agent.
 */
export const allowedSends = (model: HandOffModel, from: string): SendTarget[] => {
  const p = prepare(model)
  const links = channelLinks(p, from)
  const out = new Map<string, SendTarget>()
  const put = (id: string, main: boolean) => {
    const agent = p.agents.get(id)
    if (!agent || id === from || !p.alive(id)) return
    out.set(id, {
      agentId: id,
      name: agent.name,
      channels: [...(links.get(id) ?? [])].sort((a, b) => (lower(a) < lower(b) ? -1 : 1)),
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
  return [...out.values()].sort((a, b) =>
    byName({ name: a.name, id: a.agentId }, { name: b.name, id: b.agentId }),
  )
}

/** True when the rule "Along the channels" lets `from` send a message to `to`. */
export const handOffAllowed = (model: HandOffModel, from: string, to: string): boolean =>
  allowedSends(model, from).some((t) => t.agentId === to)

/**
 * The agent that a refused sender is told to use: the first agent on the path to the receiver.
 * The path is the shortest chain of allowed sends that goes along the channels, with no stop at
 * the main agent. Its first agent is the lead of a channel of the sender when the chain starts
 * with one. When no chain exists, the first agent is the main agent. Null when there is none: the
 * sender must tell the user.
 */
export const firstOnPath = (
  model: HandOffModel,
  from: string,
  to: string,
): { id: string; name: string } | null => {
  const p = prepare(model)
  // Rules 1 and 4 link two agents both ways, so a search from the receiver gives every distance.
  const dist = new Map<string, number>([[to, 0]])
  const queue = [to]
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as string
    for (const next of channelLinks(p, at).keys()) {
      if (dist.has(next)) continue
      dist.set(next, (dist.get(at) as number) + 1)
      queue.push(next)
    }
  }
  const mine = dist.get(from)
  const asMain = () => {
    if (p.mainId === null || p.mainId === from) return null
    return { id: p.mainId, name: (p.agents.get(p.mainId) as HandOffAgent).name }
  }
  if (mine === undefined || mine === 0) return asMain()
  // Every agent next to the sender that is one step closer to the receiver.
  const firsts = [...channelLinks(p, from).keys()].filter((id) => dist.get(id) === mine - 1)
  if (firsts.length === 0) return asMain()
  // A lead of a channel of the sender comes first. Then the order of name.
  const leadsOfMine = new Set<string>()
  for (const channel of p.open) {
    if (!p.membersOf(channel).includes(from)) continue
    const lead = p.leadOf(channel)
    if (lead !== null && lead !== from) leadsOfMine.add(lead)
  }
  const named = firsts.map((id) => ({ id, name: (p.agents.get(id) as HandOffAgent).name }))
  named.sort((a, b) => {
    const x = leadsOfMine.has(a.id) ? 0 : 1
    const y = leadsOfMine.has(b.id) ? 0 : 1
    return x - y || byName(a, b)
  })
  return named[0] as { id: string; name: string }
}

/** What a refused send tells the sender (spec 030). */
export interface HandOffRefusal {
  /** The agent to send to instead, or null when no agent can pass the work on. */
  readonly next: { id: string; name: string } | null
}

/**
 * Checks one send under the rule "Along the channels". Returns undefined when the send may go, and
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
 * The link of one row of "list agents": the channel that links the agents, or "main agent" when the
 * receiver is the main agent or no channel links them (the main agent sends to every agent).
 */
export const handOffLink = (target: SendTarget): string =>
  target.main || target.channels.length === 0
    ? "main agent"
    : `channel: ${target.channels.join(", ")}`

/**
 * Told to the main agent while the rule is on (spec 030): every agent can bring work to it, and it
 * passes the work on along the channels, to the lead of a channel when the channel has one.
 */
export const MAIN_AGENT_HAND_OFF_RULE =
  "The hand-off rule is on. Every agent can send work to you. Pass work on along the channels: send it to the lead of a channel when the channel has one."
