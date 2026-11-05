// The organization tree (spec 030, "Concepts" and "Organization tree"). An organization can have a
// parent organization. These functions hold the rules of the tree: at most 3 levels, no loop, and a
// missing parent counts as no parent. An organization has no archive state, so there is no
// archived case. They read the organizations as stored and say what the tree is now.

/** A tree has at most this many levels: a top organization, its sub-organizations, and theirs. */
export const ORG_TREE_LEVELS = 3

/** What the tree needs of an organization. */
export interface TreeOrg {
  readonly id: string
  /** The parent organization as stored, or null. */
  readonly parentId: string | null
}

/** Why an organization cannot be the parent of another. */
export type OrgParentRefusal =
  /** The organization itself, or one of its lower organizations: the tree would have a loop. */
  | "loop"
  /** The tree would have more than 3 levels. */
  | "levels"
  /** The organization does not exist. */
  | "gone"

/**
 * The parent of each organization in the tree as it is now. A parent is null when the organization
 * has none, when the parent does not exist, or when the stored data breaks the rules of the tree:
 * an organization on a loop, and an organization that would be on a fourth level, count as top
 * organizations. That reading only keeps a window safe for the moment before a repair. The app
 * repairs a broken tree at once and clears the field (`orgRepairAfterSync`, `orgRepairAfterImport`,
 * spec 030, "Repair"), so the stored data does not stay in that state. The result is the same for
 * the same data, in any order.
 */
export const orgParents = (orgs: readonly TreeOrg[]): Map<string, string | null> => {
  const byId = new Map(orgs.map((o) => [o.id, o]))
  const stored = (id: string): string | null => {
    const o = byId.get(id)
    if (!o?.parentId || o.parentId === id) return null
    return byId.has(o.parentId) ? o.parentId : null
  }
  // An organization whose line up the tree comes back to itself is on a loop.
  const onLoop = new Set<string>()
  for (const o of orgs) {
    const seen = new Set<string>([o.id])
    for (let at = stored(o.id); at !== null; at = stored(at)) {
      if (at === o.id) {
        onLoop.add(o.id)
        break
      }
      if (seen.has(at)) break
      seen.add(at)
    }
  }
  const parents = new Map<string, string | null>()
  const levels = new Map<string, number>()
  const levelOf = (id: string): number => {
    const known = levels.get(id)
    if (known !== undefined) return known
    const parent = onLoop.has(id) ? null : stored(id)
    // The parent of an organization that is not on a loop is not on a loop either, or the line up
    // from it ends at a loop: both end, so the recursion ends.
    const level = parent === null ? 1 : levelOf(parent) + 1
    if (level > ORG_TREE_LEVELS) {
      parents.set(id, null)
      levels.set(id, 1)
      return 1
    }
    parents.set(id, parent)
    levels.set(id, level)
    return level
  }
  for (const o of orgs) levelOf(o.id)
  return parents
}

/** The level of each organization in the tree: 1 for a top organization. */
export const orgLevels = (parents: ReadonlyMap<string, string | null>): Map<string, number> => {
  const levels = new Map<string, number>()
  const levelOf = (id: string): number => {
    const known = levels.get(id)
    if (known !== undefined) return known
    const parent = parents.get(id) ?? null
    const level = parent === null ? 1 : levelOf(parent) + 1
    levels.set(id, level)
    return level
  }
  for (const id of parents.keys()) levelOf(id)
  return levels
}

/** The sub-organizations of each organization in the tree as it is now. */
const childrenOf = (parents: ReadonlyMap<string, string | null>) => {
  const children = new Map<string, string[]>()
  for (const [id, parent] of parents) {
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), id])
  }
  return children
}

/** The lower organizations of an organization: its sub-organizations, theirs, and so on. */
export const lowerOrgs = (orgs: readonly TreeOrg[], id: string): Set<string> => {
  const children = childrenOf(orgParents(orgs))
  const out = new Set<string>()
  const walk = (at: string) => {
    for (const child of children.get(at) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      walk(child)
    }
  }
  walk(id)
  return out
}

/** The higher organizations of an organization: its parent, the parent of that one, up to the top. */
export const higherOrgs = (orgs: readonly TreeOrg[], id: string): string[] => {
  const parents = orgParents(orgs)
  const out: string[] = []
  for (let at = parents.get(id) ?? null; at !== null; at = parents.get(at) ?? null) out.push(at)
  return out
}

/**
 * Why `parentId` cannot be the parent of `id`, or undefined when it can. A null parent is always
 * allowed. `id` may be an organization that is not made yet: it has no lower organizations.
 */
export const orgParentRefusal = (
  orgs: readonly TreeOrg[],
  id: string,
  parentId: string | null,
): OrgParentRefusal | undefined => {
  if (parentId === null) return undefined
  if (parentId === id) return "loop"
  if (!orgs.some((o) => o.id === parentId)) return "gone"
  // The tree as it would be with `id` taken out of its place: the levels above the new parent.
  const others = orgs.map((o) => (o.id === id ? { ...o, parentId: null } : o))
  if (lowerOrgs(others, id).has(parentId)) return "loop"
  const parents = orgParents(others)
  const levels = orgLevels(parents)
  // How many levels `id` and its lower organizations take: 1 for one with no sub-organization.
  const children = childrenOf(parents)
  const height = (at: string, seen: Set<string>): number => {
    let most = 0
    for (const child of children.get(at) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      most = Math.max(most, height(child, seen))
    }
    return most + 1
  }
  const above = levels.get(parentId) ?? 1
  if (above + height(id, new Set([id])) > ORG_TREE_LEVELS) return "levels"
  return undefined
}

/**
 * The choices of the field "Parent organization" of organization `id` (spec 030): every other
 * organization, with the reason when the rules of the tree do not allow it. "None" is not in the
 * list: it is always allowed.
 */
export const orgParentChoices = (
  orgs: readonly TreeOrg[],
  id: string,
): { id: string; refusal: OrgParentRefusal | undefined }[] =>
  orgs
    .filter((o) => o.id !== id)
    .map((o) => ({ id: o.id, refusal: orgParentRefusal(orgs, id, o.id) }))

/** The parent of organization `id` in the tree as it is now, or null for a top organization. */
export const orgParent = (orgs: readonly TreeOrg[], id: string): string | null =>
  orgParents(orgs).get(id) ?? null

// ------------------------------------------------------------------------------ repair

/**
 * The time of a change, in the order that both computers share (spec 019): a larger `l`, then a
 * larger `c` is later. It is the stamp that sync keeps for each field. `n` is the computer that
 * made the change: it names the change, but it does not make one change later than another.
 */
export interface ChangeTime {
  readonly l: number
  readonly c: number
  readonly n: string
}

/** What the tree would have had: the words of the muted line differ. */
export type TreeRepairReason = "loop" | "levels"

/** What the repair needs of an organization, on top of what the tree needs. */
export interface RepairOrg extends TreeOrg {
  /** When the organization was made. */
  readonly createdAt: number
  /** When the parent field changed last. Absent counts as the oldest time. */
  readonly parentChanged?: ChangeTime
}

/** The organization whose parent field the app clears, and why. */
export interface OrgRepair {
  readonly id: string
  readonly reason: TreeRepairReason
}

const NEVER: ChangeTime = { l: 0, c: 0, n: "" }

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * More than 0 when the parent change of `a` is the later one. Two changes with the same time: the
 * organization that was made later. Two organizations made at the same time: the later id, so
 * that the order has no tie and both computers choose the same organization (spec 030, "Repair").
 */
const laterParentChange = (a: RepairOrg, b: RepairOrg): number => {
  const x = a.parentChanged ?? NEVER
  const y = b.parentChanged ?? NEVER
  return x.l - y.l || x.c - y.c || a.createdAt - b.createdAt || compareText(a.id, b.id)
}

/** The organizations and the parent of each one, with a parent that is no organization here cut. */
const workingTree = (orgs: readonly RepairOrg[]) => {
  const byId = new Map(orgs.map((o) => [o.id, o]))
  const parent = new Map<string, string | null>()
  for (const o of orgs)
    parent.set(o.id, o.parentId !== null && byId.has(o.parentId) ? o.parentId : null)
  const ids = [...byId.keys()].sort(compareText)
  return { byId, parent, ids }
}
type WorkingTree = ReturnType<typeof workingTree>

/** The organizations of the loop that the line up from `start` ends in, or undefined when it ends at a top one. */
const loopFrom = (parent: ReadonlyMap<string, string | null>, start: string) => {
  const seen = new Set<string>()
  let at: string | null = start
  while (at !== null && !seen.has(at)) {
    seen.add(at)
    at = parent.get(at) ?? null
  }
  if (at === null) return undefined
  const loop = [at]
  for (
    let next = parent.get(at) ?? null;
    next !== null && next !== at;
    next = parent.get(next) ?? null
  )
    loop.push(next)
  return loop
}

/** The organization of the group that has the latest parent change. */
const latest = (tree: WorkingTree, ids: readonly string[]) =>
  ids
    .map((id) => tree.byId.get(id) as RepairOrg)
    .reduce((best, o) => (laterParentChange(o, best) > 0 ? o : best))

/** Clears the parent of one organization on each loop, the one with the latest parent change, until no loop is left. */
const breakLoops = (tree: WorkingTree, repairs: OrgRepair[]) => {
  for (;;) {
    let loop: string[] | undefined
    for (const id of tree.ids) {
      loop = loopFrom(tree.parent, id)
      if (loop) break
    }
    if (!loop) return
    const pick = latest(tree, loop)
    tree.parent.set(pick.id, null)
    repairs.push({ id: pick.id, reason: "loop" })
  }
}

/** The level of each organization in a tree that has no loop: 1 for a top organization. */
const levelsOfTree = (parent: ReadonlyMap<string, string | null>) => {
  const levels = new Map<string, number>()
  const levelOf = (id: string): number => {
    const known = levels.get(id)
    if (known !== undefined) return known
    const up = parent.get(id) ?? null
    const level = up === null ? 1 : levelOf(up) + 1
    levels.set(id, level)
    return level
  }
  for (const id of parent.keys()) levelOf(id)
  return levels
}

/**
 * The repair after a sync (spec 030, "Repair"). Data that two computers each changed in a way that
 * is right alone can make a loop or a fourth level. For each break, the parent field of the
 * organization on the broken line whose parent change is the latest is cleared; when two changes
 * carry the same time, the organization that was made later, then the later id. The result depends
 * on the data only, not on the order of the organizations or of the changes, so two computers that
 * hold the same data choose the same organizations. The loops go first, then each organization
 * that is too deep, the one nearest to the top first. Returns the organizations to clear, in the
 * order of the repairs. Nothing for a tree that is right.
 */
export const orgRepairAfterSync = (orgs: readonly RepairOrg[]): OrgRepair[] => {
  const tree = workingTree(orgs)
  const repairs: OrgRepair[] = []
  breakLoops(tree, repairs)
  for (;;) {
    const levels = levelsOfTree(tree.parent)
    const deepest = tree.ids
      .filter((id) => (levels.get(id) ?? 1) > ORG_TREE_LEVELS)
      .sort((a, b) => (levels.get(a) ?? 1) - (levels.get(b) ?? 1) || compareText(a, b))[0]
    if (deepest === undefined) return repairs
    // The line from the organization up to its top organization. Each organization of it, but the
    // top one, has a parent change that put it there.
    const line: string[] = []
    for (
      let at: string | null = deepest;
      at !== null && tree.parent.get(at);
      at = tree.parent.get(at) ?? null
    )
      line.push(at)
    const pick = latest(tree, line)
    tree.parent.set(pick.id, null)
    repairs.push({ id: pick.id, reason: "levels" })
  }
}

/**
 * The repair after an import, a first copy and at the start of the app (spec 030, "Repair"). The
 * check goes from the top down: the parent field of each organization that would be on the fourth
 * level is cleared. That organization becomes a top organization, and the organizations under it
 * count from their new level. A loop is broken first, as after a sync; an import carries no time
 * of change, so the tie order decides. Returns the organizations to clear, in the order of the
 * check.
 */
export const orgRepairAfterImport = (orgs: readonly RepairOrg[]): OrgRepair[] => {
  const tree = workingTree(orgs)
  const repairs: OrgRepair[] = []
  breakLoops(tree, repairs)
  const children = new Map<string, string[]>()
  for (const id of tree.ids) {
    const up = tree.parent.get(id) ?? null
    if (up !== null) children.set(up, [...(children.get(up) ?? []), id])
  }
  const visit = (id: string, level: number) => {
    let own = level
    if (own > ORG_TREE_LEVELS) {
      tree.parent.set(id, null)
      repairs.push({ id, reason: "levels" })
      own = 1
    }
    for (const child of children.get(id) ?? []) visit(child, own + 1)
  }
  // The top organizations are those of the start: an organization that the check clears is
  // visited once, from its old parent, and the organizations under it count from level 1.
  const tops = tree.ids.filter((id) => (tree.parent.get(id) ?? null) === null)
  for (const id of tops) visit(id, 1)
  return repairs
}
