import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { alive } from "./runtimes/programs.ts"

/**
 * Temporary folders of the app that a killed or crashed app does not leave for ever.
 *
 * The app makes some temporary folders for a short time: the upload folder of linked devices, the
 * files of a turn of a vendor program (they hold the address and the token of the tools of the
 * app, or the prompt), a copy of the database for an export. Each is removed when its work ends.
 * A kill or a crash skips that, and the folder stays with its content.
 *
 * So every such folder stands in ONE folder of the app (`robot-temp-<user>`, only the user can
 * enter it), and its name holds the number of the process that made it:
 * `<prefix><process number>-<6 random characters>`. The first time that a process makes a folder
 * of a prefix, it removes the folders of that prefix whose process is gone. It reads that one small
 * folder and never the temporary folder of the computer, which can hold a million entries (a read of
 * it takes seconds, and it would stop the main process).
 *
 * A folder is removed only when all of this holds:
 * - its name is exactly `<prefix><digits>-<6 letters or digits>`, and it is a folder (not a link);
 * - no process has that number. "No permission to look" counts as a process that runs;
 * - it is older than ten minutes. A number can also look free when its owner runs in another
 *   process space (a container) on the same temporary folder, or a young folder is still being
 *   made. A number that a later process took keeps the folder of the earlier one until that
 *   process ends: it is never removed while somebody could own it.
 */

/** A folder whose owner is gone is removed only when it is older than this. */
export const STALE_AFTER_MS = 10 * 60_000

/** The largest process number that `process.kill` takes. A name with a larger one is not ours. */
const MAX_PID = 0x7fffffff

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The folder of the app inside the temporary folder of the computer, made on first use. On a
 * system where many users share the temporary folder (Linux), another user can make a folder of the
 * same name first, or a link with it. So the folder is used only when it is a real folder, it is
 * ours, and nobody else can enter it. Null when it is not: the caller then makes its folder
 * directly in the temporary folder, as before, and no sweep happens for it.
 */
export const ownTempRoot = (): string | null => {
  const uid = process.getuid?.()
  const root = join(tmpdir(), uid === undefined ? "robot-temp" : `robot-temp-${uid}`)
  try {
    mkdirSync(root, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null
  }
  try {
    // `lstat` does not follow a link: a link is not a directory here.
    const info = lstatSync(root)
    if (!info.isDirectory()) return null
    if (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0)) return null
    return root
  } catch {
    return null
  }
}

export interface SweepOptions {
  /** The folder to read. The default is the folder of the app. Tests give their own. */
  readonly root?: string
  readonly now?: number
  readonly minAgeMs?: number
  /** True when a process with this number runs. */
  readonly alive?: (pid: number) => boolean
  readonly remove?: (path: string) => void
}

/**
 * Removes the folders of `prefix` that a gone process left (see the rules above). Returns the paths
 * that it removed. It never throws: a folder that cannot be removed stays, and the next start
 * tries again.
 */
export const sweepStaleFolders = (prefix: string, options: SweepOptions = {}): string[] => {
  const removed: string[] = []
  try {
    const root = options.root ?? ownTempRoot()
    if (!root) return removed
    const now = options.now ?? Date.now()
    const minAge = options.minAgeMs ?? STALE_AFTER_MS
    const runs = options.alive ?? alive
    const remove = options.remove ?? ((path) => rmSync(path, { recursive: true, force: true }))
    const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d{1,10})-[A-Za-z0-9]{6}$`)
    for (const name of readdirSync(root)) {
      const found = pattern.exec(name)
      if (!found) continue
      const pid = Number(found[1])
      if (!Number.isInteger(pid) || pid < 1 || pid > MAX_PID || runs(pid)) continue
      const path = join(root, name)
      try {
        const info = lstatSync(path)
        if (!info.isDirectory() || now - info.mtimeMs <= minAge) continue
        remove(path)
        removed.push(path)
      } catch {
        // This folder stays. The others still get their turn.
      }
    }
  } catch {
    // No folder to read: nothing to remove.
  }
  return removed
}

const swept = new Set<string>()

/** Lets every prefix be swept again at its next folder. For tests: the memory is module state. */
export const forgetSweeps = () => swept.clear()

/**
 * Makes a new folder `<prefix><this process number>-<random>` that only the user can enter. The
 * first call for a prefix in this process removes the folders of that prefix that a gone process
 * left, before it makes its own.
 */
export const makeOwnedFolder = (prefix: string): string => {
  if (!swept.has(prefix)) {
    swept.add(prefix)
    sweepStaleFolders(prefix)
  }
  return mkdtempSync(join(ownTempRoot() ?? tmpdir(), `${prefix}${process.pid}-`))
}
