// The channel tree (spec 030, "Concepts" and "Channel tree"). A channel can have a parent channel.
// These functions hold the rules of the tree: at most 3 levels, no loop, and an archived or missing
// parent counts as no parent. They read the channels as stored and say what the tree is now.

/** A tree has at most this many levels: a top channel, its sub-channels, and theirs. */
export const CHANNEL_TREE_LEVELS = 3

/** What the tree needs of a channel. */
export interface TreeChannel {
  readonly id: string
  /** The parent channel as stored, or null. */
  readonly parentId: string | null
  /** True while the channel is archived. Absent counts as not archived. */
  readonly archived?: boolean
}

/** Why a channel cannot be the parent of another. */
export type ParentRefusal =
  /** The channel itself, or one of its lower channels: the tree would have a loop. */
  | "loop"
  /** The tree would have more than 3 levels. */
  | "levels"
  /** The channel is archived, or it does not exist. */
  | "gone"

/**
 * The parent of each channel in the tree as it is now. A parent is null when the channel has none,
 * when the parent does not exist or is archived, or when the stored data breaks the rules of the
 * tree: a channel on a loop, and a channel that would be on a fourth level, count as top channels.
 * That reading only keeps a window safe for the moment before a repair. The app repairs a broken
 * tree at once and clears the field (`repairAfterSync`, `repairAfterRestore`, spec 030, "Repair"),
 * so the stored data does not stay in that state. The result is the same for the same data, in any
 * order.
 */
export const treeParents = (channels: readonly TreeChannel[]): Map<string, string | null> => {
  const byId = new Map(channels.map((c) => [c.id, c]))
  const stored = (id: string): string | null => {
    const c = byId.get(id)
    if (!c?.parentId || c.parentId === id) return null
    const parent = byId.get(c.parentId)
    return parent && !parent.archived ? parent.id : null
  }
  // A channel whose line up the tree comes back to itself is on a loop.
  const onLoop = new Set<string>()
  for (const c of channels) {
    const seen = new Set<string>([c.id])
    for (let at = stored(c.id); at !== null; at = stored(at)) {
      if (at === c.id) {
        onLoop.add(c.id)
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
    // The parent of a channel that is not on a loop is not on a loop either, or the line up from
    // it ends at a loop: both end, so the recursion ends.
    const level = parent === null ? 1 : levelOf(parent) + 1
    if (level > CHANNEL_TREE_LEVELS) {
      parents.set(id, null)
      levels.set(id, 1)
      return 1
    }
    parents.set(id, parent)
    levels.set(id, level)
    return level
  }
  for (const c of channels) levelOf(c.id)
  return parents
}

/** The level of each channel in the tree: 1 for a top channel. */
export const treeLevels = (parents: ReadonlyMap<string, string | null>): Map<string, number> => {
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

/** The sub-channels of each channel in the tree as it is now. */
const childrenOf = (parents: ReadonlyMap<string, string | null>) => {
  const children = new Map<string, string[]>()
  for (const [id, parent] of parents) {
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), id])
  }
  return children
}

/** The lower channels of a channel: its sub-channels, theirs, and so on. */
export const lowerChannels = (channels: readonly TreeChannel[], id: string): Set<string> => {
  const children = childrenOf(treeParents(channels))
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

/** The higher channels of a channel: its parent, the parent of that one, up to the top channel. */
export const higherChannels = (channels: readonly TreeChannel[], id: string): string[] => {
  const parents = treeParents(channels)
  const out: string[] = []
  for (let at = parents.get(id) ?? null; at !== null; at = parents.get(at) ?? null) out.push(at)
  return out
}

/**
 * Why `parentId` cannot be the parent of `id`, or undefined when it can. A null parent is always
 * allowed. `id` may be a channel that is not made yet: it has no lower channels.
 */
export const parentRefusal = (
  channels: readonly TreeChannel[],
  id: string,
  parentId: string | null,
): ParentRefusal | undefined => {
  if (parentId === null) return undefined
  if (parentId === id) return "loop"
  const parent = channels.find((c) => c.id === parentId)
  if (!parent || parent.archived) return "gone"
  // The tree as it would be with `id` taken out of its place: the levels above the new parent.
  const others = channels.map((c) => (c.id === id ? { ...c, parentId: null } : c))
  if (lowerChannels(others, id).has(parentId)) return "loop"
  const parents = treeParents(others)
  const levels = treeLevels(parents)
  // How many levels `id` and its lower channels take: 1 for a channel with no sub-channel.
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
  if (above + height(id, new Set([id])) > CHANNEL_TREE_LEVELS) return "levels"
  return undefined
}

/**
 * The choices of the field "Parent channel" of channel `id` (spec 030): every other channel that is
 * not archived, with the reason when the rules of the tree do not allow it. "None" is not in the
 * list: it is always allowed.
 */
export const parentChoices = (
  channels: readonly TreeChannel[],
  id: string,
): { id: string; refusal: ParentRefusal | undefined }[] =>
  channels
    .filter((c) => c.id !== id && !c.archived)
    .map((c) => ({ id: c.id, refusal: parentRefusal(channels, id, c.id) }))

/** The parent of channel `id` in the tree as it is now, or null for a top channel. */
export const channelParent = (channels: readonly TreeChannel[], id: string): string | null =>
  treeParents(channels).get(id) ?? null

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

/** What the repair needs of a channel, on top of what the tree needs. */
export interface RepairChannel extends TreeChannel {
  /** When the channel was made. */
  readonly createdAt: number
  /** When the parent field changed last. Absent counts as the oldest time. */
  readonly parentChanged?: ChangeTime
}

/** What the tree would have had: the words of the muted line differ. */
export type TreeRepairReason = "loop" | "levels"

/** The channel whose parent field the app clears, and why. */
export interface TreeRepair {
  readonly id: string
  readonly reason: TreeRepairReason
}

const NEVER: ChangeTime = { l: 0, c: 0, n: "" }

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * More than 0 when the parent change of `a` is the later one. Two changes with the same time: the
 * channel that was made later. Two channels made at the same time: the later id, so that the order
 * has no tie and both computers choose the same channel (spec 030, "Repair").
 */
const laterParentChange = (a: RepairChannel, b: RepairChannel): number => {
  const x = a.parentChanged ?? NEVER
  const y = b.parentChanged ?? NEVER
  return x.l - y.l || x.c - y.c || a.createdAt - b.createdAt || compareText(a.id, b.id)
}

/** The channels that the tree holds and the parent of each one, with a parent that is no channel here cut. */
const workingTree = (channels: readonly RepairChannel[]) => {
  const live = channels.filter((c) => !c.archived)
  const byId = new Map(live.map((c) => [c.id, c]))
  const parent = new Map<string, string | null>()
  for (const c of live)
    parent.set(c.id, c.parentId !== null && byId.has(c.parentId) ? c.parentId : null)
  const ids = [...byId.keys()].sort(compareText)
  return { byId, parent, ids }
}
type WorkingTree = ReturnType<typeof workingTree>

/** The channels of the loop that the line up from `start` ends in, or undefined when it ends at a top channel. */
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

/** The channel of the group that has the latest parent change. */
const latest = (tree: WorkingTree, ids: readonly string[]) =>
  ids
    .map((id) => tree.byId.get(id) as RepairChannel)
    .reduce((best, c) => (laterParentChange(c, best) > 0 ? c : best))

/** Clears the parent of one channel on each loop, the one with the latest parent change, until no loop is left. */
const breakLoops = (tree: WorkingTree, repairs: TreeRepair[]) => {
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

/** The level of each channel in a tree that has no loop: 1 for a top channel. */
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
 * The repair after a sync (spec 030, "Repair", case 2). Data that two computers each changed in
 * a way that is right alone can make a loop or a fourth level. For each break, the parent field of
 * the channel on the broken line whose parent change is the latest is cleared; when two changes
 * carry the same time, the channel that was made later. The result depends on the data only, not on
 * the order of the channels or of the changes, so two computers that hold the same data choose
 * the same channels. The loops go first, then each channel that is too deep, the one nearest to
 * the top first. Returns the channels to clear, in the order of the repairs. Nothing for a tree
 * that is right.
 */
export const repairAfterSync = (channels: readonly RepairChannel[]): TreeRepair[] => {
  const tree = workingTree(channels)
  const repairs: TreeRepair[] = []
  breakLoops(tree, repairs)
  for (;;) {
    const levels = levelsOfTree(tree.parent)
    const deepest = tree.ids
      .filter((id) => (levels.get(id) ?? 1) > CHANNEL_TREE_LEVELS)
      .sort((a, b) => (levels.get(a) ?? 1) - (levels.get(b) ?? 1) || compareText(a, b))[0]
    if (deepest === undefined) return repairs
    // The line from the channel up to its top channel. Each channel of it, but the top one, has a
    // parent change that put it there.
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
 * The repair after a restore (spec 030, "Repair", case 1). `channels` are the channels with the
 * restored channel no longer archived. A restore works also when it would put a channel below the
 * third level: the check goes from the top down, and the parent field of each channel that would
 * be on the fourth level is cleared. That channel becomes a top channel, and the channels under
 * it count from their new level. A loop that a restore closes is broken first, as after a sync
 * (the spec names the levels only). Returns the channels to clear, in the order of the check.
 */
export const repairAfterRestore = (channels: readonly RepairChannel[]): TreeRepair[] => {
  const tree = workingTree(channels)
  const repairs: TreeRepair[] = []
  breakLoops(tree, repairs)
  const children = new Map<string, string[]>()
  for (const id of tree.ids) {
    const up = tree.parent.get(id) ?? null
    if (up !== null) children.set(up, [...(children.get(up) ?? []), id])
  }
  const visit = (id: string, level: number) => {
    let own = level
    if (own > CHANNEL_TREE_LEVELS) {
      tree.parent.set(id, null)
      repairs.push({ id, reason: "levels" })
      own = 1
    }
    for (const child of children.get(id) ?? []) visit(child, own + 1)
  }
  // The top channels are those of the start: a channel that the check clears is visited once,
  // from its old parent, and its sub-channels count from level 1 under it.
  const tops = tree.ids.filter((id) => (tree.parent.get(id) ?? null) === null)
  for (const id of tops) visit(id, 1)
  return repairs
}
