import {
  type OrgParentOption,
  type OrgPatch,
  orgParent,
  orgParentOptions,
  orgParentRefusal,
  type TreeOrg,
} from "@robot/shared"

// Edit on the org chart (spec 029, "Edit on the chart"). The chart changes the members, the lead and
// the parent organization (030) of an organization with the same change as the form of an
// organization, so the server keeps its rules: the tree has no loop and at most 3 levels. An agent
// that works can change its organizations, because membership holds no running work. This file holds
// no interface: it says which organizations a menu lists, where a drop is allowed, which patches a
// change sends, and how Undo puts the organizations back.

/** What the chart needs of an organization: the members as stored, archived ones too. */
export interface EditOrg {
  readonly id: string
  readonly name: string
  readonly leadId: string | null
  readonly memberIds: readonly string[]
  /** The parent organization as stored (spec 030). Absent counts as none. */
  readonly parentId?: string | null
}

/** What the chart needs of an agent that is not archived. */
export interface EditAgent {
  readonly id: string
  readonly name: string
}

/** One change of the chart. `from` is null for the node in "No organization". */
export type Edit =
  | { readonly kind: "add"; readonly agentId: string; readonly to: string }
  | { readonly kind: "move"; readonly agentId: string; readonly from: string; readonly to: string }
  | { readonly kind: "remove"; readonly agentId: string; readonly from: string }
  | { readonly kind: "lead"; readonly agentId: string; readonly orgId: string }
  | { readonly kind: "unlead"; readonly agentId: string; readonly orgId: string }
  /** "Put under…" (a parent) or "Move to the top" (null), also by a drag of an organization node. */
  | { readonly kind: "parent"; readonly orgId: string; readonly parentId: string | null }

/** One patch for one organization, in the order to send. */
export interface Step {
  readonly orgId: string
  readonly patch: OrgPatch
}

/**
 * The members and the lead of an organization, or its parent organization, before a change. Undo
 * puts them back. The names are for the line that says why an Undo is refused.
 */
export type Before =
  | {
      readonly kind?: "members"
      readonly orgId: string
      readonly name: string
      readonly memberIds: readonly string[]
      readonly leadId: string | null
    }
  | {
      readonly kind: "parent"
      readonly orgId: string
      readonly name: string
      readonly parentId: string | null
      /** The name of the parent before, for the same reason. Null when there was none. */
      readonly parentName: string | null
    }

export interface Plan {
  readonly steps: readonly Step[]
  readonly before: readonly Before[]
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

/** The organizations that "Add to organization…" and "Move to organization…" list: the agent is no member. */
export const orgsFor = (agentId: string, orgs: readonly EditOrg[]) =>
  orgs.filter((o) => !o.memberIds.includes(agentId)).sort(byName)

/** The agents that "Add member…" lists: not archived and not members. */
export const agentsFor = (org: EditOrg, agents: readonly EditAgent[]) =>
  agents.filter((a) => !org.memberIds.includes(a.id)).sort(byName)

/** The tree of the organizations as the chart edits it. */
const treeOf = (orgs: readonly EditOrg[]): (TreeOrg & { name: string })[] =>
  orgs.map((o) => ({ id: o.id, name: o.name, parentId: o.parentId ?? null }))

/** The parent organization of an organization in the tree as it is now, or null for a top one. */
export const parentOf = (orgId: string, orgs: readonly EditOrg[]) => orgParent(treeOf(orgs), orgId)

/**
 * The organizations that "Put under…" lists for an organization (spec 029, 030): the same as the
 * field "Parent organization" of the form, without "None" and without the parent now. One that the
 * rules of the tree refuse stays in the list, with the reason, so the menu can show it muted.
 */
export const parentChoices = (orgId: string, orgs: readonly EditOrg[]): OrgParentOption[] => {
  const now = parentOf(orgId, orgs)
  return orgParentOptions(treeOf(orgs), orgId).filter((o) => o.id !== now)
}

/**
 * The change that the drop of an organization node makes, or undefined when a drop there is not
 * allowed (no ring, no change). `to` is the organization under the pointer, or null for the root:
 * the organization moves to the top.
 */
export const orgDropEdit = (
  orgId: string,
  to: string | null,
  orgs: readonly EditOrg[],
): Edit | undefined => {
  if (!orgs.some((o) => o.id === orgId)) return undefined
  const now = parentOf(orgId, orgs)
  if (to === null) return now === null ? undefined : { kind: "parent", orgId, parentId: null }
  if (to === now || to === orgId || !orgs.some((o) => o.id === to)) return undefined
  if (orgParentRefusal(treeOf(orgs), orgId, to)) return undefined
  return { kind: "parent", orgId, parentId: to }
}

/** Where a dragged agent node came from, and the organization node under the pointer. */
export interface Drop {
  readonly agentId: string
  /** The organization of the dragged copy, or null for "No organization". */
  readonly from: string | null
  /** The organization node under the pointer, or null for "No organization". */
  readonly to: string | null
  /** Option is held: the agent is added and stays where it was. */
  readonly add: boolean
}

/**
 * The change that a drop makes, or undefined when a drop there is not allowed: the node shows no
 * ring, and the drop changes nothing.
 */
export const dropEdit = (drop: Drop, orgs: readonly EditOrg[]): Edit | undefined => {
  if (drop.to === null) {
    // Dropped on "No organization": the agent leaves the organization it came from. There is nothing to add.
    if (drop.from === null || drop.add) return undefined
    return { kind: "remove", agentId: drop.agentId, from: drop.from }
  }
  const target = orgs.find((o) => o.id === drop.to)
  if (!target || target.memberIds.includes(drop.agentId)) return undefined
  if (drop.from === null || drop.add) return { kind: "add", agentId: drop.agentId, to: target.id }
  return { kind: "move", agentId: drop.agentId, from: drop.from, to: target.id }
}

const without = (ids: readonly string[], id: string) => ids.filter((m) => m !== id)

/**
 * The patches of a change, or undefined when the organizations it names are gone. A move first
 * takes the agent out of its organization. A move of the lead leaves its organization with no lead.
 */
export const planEdit = (edit: Edit, orgs: readonly EditOrg[]): Plan | undefined => {
  const find = (id: string) => orgs.find((o) => o.id === id)
  const agentId = "agentId" in edit ? edit.agentId : ""
  const keep = (o: EditOrg): Before => ({
    orgId: o.id,
    name: o.name,
    memberIds: [...o.memberIds],
    leadId: o.leadId,
  })
  const leave = (o: EditOrg): Step => ({
    orgId: o.id,
    patch: {
      memberIds: without(o.memberIds, agentId),
      ...(o.leadId === agentId ? { leadId: null } : {}),
    },
  })
  const join = (o: EditOrg): Step => ({
    orgId: o.id,
    patch: { memberIds: [...without(o.memberIds, agentId), agentId] },
  })
  switch (edit.kind) {
    case "parent": {
      const o = find(edit.orgId)
      if (!o) return undefined
      const was = parentOf(o.id, orgs)
      return {
        steps: [{ orgId: o.id, patch: { parentId: edit.parentId } }],
        before: [
          {
            kind: "parent",
            orgId: o.id,
            name: o.name,
            parentId: was,
            parentName: was ? (find(was)?.name ?? null) : null,
          },
        ],
      }
    }
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
      const o = find(edit.orgId)
      return o
        ? { steps: [{ orgId: o.id, patch: { leadId: edit.agentId } }], before: [keep(o)] }
        : undefined
    }
    case "unlead": {
      const o = find(edit.orgId)
      return o
        ? { steps: [{ orgId: o.id, patch: { leadId: null } }], before: [keep(o)] }
        : undefined
    }
  }
}

/**
 * The patches of Undo: each organization gets back its members and its lead, or its parent. When
 * the change cannot go back, because an organization of it (or the parent it had) was deleted in
 * the meantime, the result names the first one that is gone, and Undo is refused (spec 029).
 */
export const undoSteps = (
  before: readonly Before[],
  orgs: readonly EditOrg[],
): { readonly steps: Step[] } | { readonly gone: string } => {
  const steps: Step[] = []
  for (const b of before) {
    if (!orgs.some((o) => o.id === b.orgId)) return { gone: b.name }
    if (b.kind === "parent") {
      if (b.parentId !== null && !orgs.some((o) => o.id === b.parentId))
        return { gone: b.parentName ?? b.name }
      steps.push({ orgId: b.orgId, patch: { parentId: b.parentId } })
    } else {
      steps.push({ orgId: b.orgId, patch: { memberIds: [...b.memberIds], leadId: b.leadId } })
    }
  }
  return { steps }
}

/** The width of the strip along each edge of the canvas where a drag moves the view (spec 029). */
export const EDGE_PX = 40
/** How fast the view moves when the pointer is at the very edge, in pixels per second. */
export const EDGE_SPEED = 720

/**
 * How far the view moves in `ms` milliseconds while a drag holds the pointer at `point`: the
 * view moves toward the edge that the pointer is near, faster nearer the edge (a quarter of the speed at the inner side of the strip). The pointer must be
 * on the canvas and within EDGE_PX of an edge; elsewhere the view does not move. On the drop area
 * "No organization" (`onDropArea`) the view does not move either, so that a drop there is easy.
 */
export const edgeStep = (
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  ms: number,
  onDropArea = false,
): { dx: number; dy: number } => {
  if (onDropArea) return { dx: 0, dy: 0 }
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
