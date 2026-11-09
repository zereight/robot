import { rmSync } from "node:fs"
import { basename } from "node:path"
import { RUN_ROOT, RUN_ROOT_PREFIX } from "./global-setup.ts"

/** Removes the folder that `global-setup.ts` made for this run, and only that folder. */
export default function globalTeardown() {
  const root = process.env[RUN_ROOT]
  // A name that is not ours is never removed, whatever the variable says.
  if (!root || !basename(root).startsWith(RUN_ROOT_PREFIX)) return
  rmSync(root, { recursive: true, force: true })
}
