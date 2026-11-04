import type { ChannelPatch } from "@robot/shared"

// Edit on the org chart (spec 029, "Edit on the chart"). The chart changes the members and the lead
// of a channel with the same change as the channel settings (004), so the server keeps its rules:
// a member that works cannot leave its channel. This file holds no interface: it says which
// channels a menu lists, where a drop is allowed, which patches a change sends, and how Undo puts
// the channels back.

/** What the chart needs of a channel: the members as stored, archived ones too. */
export interface EditChannel {
  readonly id: string
  readonly name: string
  readonly leadId: string | null
  readonly memberIds: readonly string[]
}

/** What the chart needs of an agent that is not archived. */
export interface EditAgent {
  readonly id: string
  readonly name: string
}

/** One change of the chart. `from` is null for the node in "No channel". */
export type Edit =
  | { readonly kind: "add"; readonly agentId: string; readonly to: string }
  | { readonly kind: "move"; readonly agentId: string; readonly from: string; readonly to: string }
  | { readonly kind: "remove"; readonly agentId: string; readonly from: string }
  | { readonly kind: "lead"; readonly agentId: string; readonly channelId: string }
  | { readonly kind: "unlead"; readonly agentId: string; readonly channelId: string }

/** One patch for one channel, in the order to send. */
export interface Step {
  readonly channelId: string
  readonly patch: ChannelPatch
}

/** The members and the lead of a channel before a change. Undo puts them back. */
export interface Before {
  readonly channelId: string
  readonly memberIds: readonly string[]
  readonly leadId: string | null
}

export interface Plan {
  readonly steps: readonly Step[]
  readonly before: readonly Before[]
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

/** The channels that "Add to channel…" and "Move to channel…" list: the agent is no member. */
export const channelsFor = (agentId: string, channels: readonly EditChannel[]) =>
  channels.filter((c) => !c.memberIds.includes(agentId)).sort(byName)

/** The agents that "Add member…" lists: not archived and not members. */
export const agentsFor = (channel: EditChannel, agents: readonly EditAgent[]) =>
  agents.filter((a) => !channel.memberIds.includes(a.id)).sort(byName)

/** Where a dragged agent node came from, and the channel node under the pointer. */
export interface Drop {
  readonly agentId: string
  /** The channel of the dragged copy, or null for "No channel". */
  readonly from: string | null
  /** The channel node under the pointer, or null for "No channel". */
  readonly to: string | null
  /** Option is held: the agent is added and stays where it was. */
  readonly add: boolean
}

/**
 * The change that a drop makes, or undefined when a drop there is not allowed: the node shows no
 * ring, and the drop changes nothing.
 */
export const dropEdit = (drop: Drop, channels: readonly EditChannel[]): Edit | undefined => {
  if (drop.to === null) {
    // Dropped on "No channel": the agent leaves the channel it came from. There is nothing to add.
    if (drop.from === null || drop.add) return undefined
    return { kind: "remove", agentId: drop.agentId, from: drop.from }
  }
  const target = channels.find((c) => c.id === drop.to)
  if (!target || target.memberIds.includes(drop.agentId)) return undefined
  if (drop.from === null || drop.add) return { kind: "add", agentId: drop.agentId, to: target.id }
  return { kind: "move", agentId: drop.agentId, from: drop.from, to: target.id }
}

const without = (ids: readonly string[], id: string) => ids.filter((m) => m !== id)

/**
 * The patches of a change, or undefined when the channels it names are gone. A move first takes
 * the agent out of its channel: when the server refuses that (the agent works there), nothing has
 * changed. A move of the lead leaves its channel with no lead.
 */
export const planEdit = (edit: Edit, channels: readonly EditChannel[]): Plan | undefined => {
  const find = (id: string) => channels.find((c) => c.id === id)
  const keep = (c: EditChannel): Before => ({
    channelId: c.id,
    memberIds: [...c.memberIds],
    leadId: c.leadId,
  })
  const leave = (c: EditChannel): Step => ({
    channelId: c.id,
    patch: {
      memberIds: without(c.memberIds, edit.agentId),
      ...(c.leadId === edit.agentId ? { leadId: null } : {}),
    },
  })
  const join = (c: EditChannel): Step => ({
    channelId: c.id,
    patch: { memberIds: [...without(c.memberIds, edit.agentId), edit.agentId] },
  })
  switch (edit.kind) {
    case "add": {
      const to = find(edit.to)
      return to ? { steps: [join(to)], before: [keep(to)] } : undefined
    }
    case "remove": {
      const from = find(edit.from)
      return from ? { steps: [leave(from)], before: [keep(from)] } : undefined
    }
    case "move": {
      const from = find(edit.from)
      const to = find(edit.to)
      return from && to
        ? { steps: [leave(from), join(to)], before: [keep(from), keep(to)] }
        : undefined
    }
    case "lead": {
      const c = find(edit.channelId)
      return c
        ? { steps: [{ channelId: c.id, patch: { leadId: edit.agentId } }], before: [keep(c)] }
        : undefined
    }
    case "unlead": {
      const c = find(edit.channelId)
      return c
        ? { steps: [{ channelId: c.id, patch: { leadId: null } }], before: [keep(c)] }
        : undefined
    }
  }
}

/**
 * The patches of Undo: each channel gets back its members and its lead. A channel that loses a
 * member goes first, so that a refusal (the member works there now) leaves everything as it is.
 * A channel that is gone is left out.
 */
export const undoSteps = (before: readonly Before[], channels: readonly EditChannel[]): Step[] => {
  const steps = before.flatMap((b) => {
    const now = channels.find((c) => c.id === b.channelId)
    if (!now) return []
    const loses = now.memberIds.some((m) => !b.memberIds.includes(m))
    return [
      {
        loses,
        step: { channelId: b.channelId, patch: { memberIds: [...b.memberIds], leadId: b.leadId } },
      },
    ]
  })
  return [...steps.filter((s) => s.loses), ...steps.filter((s) => !s.loses)].map((s) => s.step)
}

/**
 * The channel and the agent of a refusal "<agent> works in <channel>": the first step that takes
 * a member out of its channel.
 */
export const leavingOf = (
  step: Step,
  channels: readonly EditChannel[],
): { channelId: string; agentIds: string[] } | undefined => {
  const now = channels.find((c) => c.id === step.channelId)
  const next = step.patch.memberIds
  if (!now || !next) return undefined
  const gone = now.memberIds.filter((m) => !next.includes(m))
  return gone.length > 0 ? { channelId: now.id, agentIds: gone } : undefined
}

/** The width of the strip along each edge of the canvas where a drag moves the view (spec 029). */
export const EDGE_PX = 40
/** How fast the view moves when the pointer is at the very edge, in pixels per second. */
export const EDGE_SPEED = 720

/**
 * How far the view moves in `ms` milliseconds while a drag holds the pointer at `point`: the
 * view moves toward the edge that the pointer is near, faster nearer the edge (a quarter of the speed at the inner side of the strip). The pointer must be
 * on the canvas and within EDGE_PX of an edge; elsewhere the view does not move.
 */
export const edgeStep = (
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  ms: number,
): { dx: number; dy: number } => {
  const x = point.x - rect.left
  const y = point.y - rect.top
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return { dx: 0, dy: 0 }
  const speed = (gap: number) =>
    gap < EDGE_PX ? (EDGE_SPEED * Math.max(0.25, 1 - gap / EDGE_PX) * ms) / 1000 : 0
  // Near the left edge the view shows more of the left: the chart moves right.
  const dx = speed(x) - speed(rect.width - x)
  const dy = speed(y) - speed(rect.height - y)
  return { dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy }
}

/** How long a line "<what changed>." with "Undo" shows, and a refusal line (spec 029). */
export const NOTICE_MS = 10_000
/** How long the line "Undone." shows after an Undo. */
export const UNDONE_MS = 3_000

/** The kinds of line at the bottom of the canvas. One shows at a time: a new one replaces it. */
export type NoticeKind = "done" | "refused" | "undone"

/** How long a line of that kind shows. */
export const noticeMs = (kind: NoticeKind) => (kind === "undone" ? UNDONE_MS : NOTICE_MS)
