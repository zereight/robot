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
 * tree (two computers can each make a change that is right alone, spec 019): a channel on a loop,
 * and a channel that would be on a fourth level, count as top channels. The result is the same for
 * the same data, in any order.
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
