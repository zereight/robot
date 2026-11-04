import { realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * The real path of a path, or of its nearest folder that exists with the rest after it, so that
 * a link counts at its target also for a file that is not there yet (spec 007).
 */
export const realOf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realOf(parent), basename(path))
  }
}
