import { readlinkSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

/** A chain of links longer than this counts as a loop. The system stops at about 40 as well. */
const LINKS_MAX = 40

const resolveLinks = (path: string, depth: number, seen: Set<string>): string => {
  try {
    return realpathSync(path)
  } catch {
    // The path or its target is not there. A link that points at nothing still names the file
    // that a write through it would make, so follow it by hand (spec 025: the app resolves links).
  }
  let target: string | null = null
  try {
    target = readlinkSync(path)
  } catch {
    // Not a link: the file is not there yet.
  }
  if (target !== null) {
    // A loop has no target: the path stays as it is, and a write through it fails.
    if (depth >= LINKS_MAX || seen.has(path)) return path
    seen.add(path)
    const next = isAbsolute(target)
      ? target
      : resolve(resolveLinks(dirname(path), depth, seen), target)
    return resolveLinks(next, depth + 1, seen)
  }
  const parent = dirname(path)
  return parent === path ? path : join(resolveLinks(parent, depth, seen), basename(path))
}

/**
 * The real path of a path, or of its nearest folder that exists with the rest after it, so that
 * a link counts at its target also for a file that is not there yet (spec 007). A link whose
 * target is not there yet is followed to that target, also through a chain of links; a loop of
 * links stops at the link (spec 025).
 */
export const realOf = (path: string): string => resolveLinks(path, 0, new Set())
