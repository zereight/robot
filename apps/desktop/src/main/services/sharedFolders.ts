import { sharesFolder } from "@robot/shared"
import type { DatabaseService } from "./Database.ts"
import { realOf } from "./realPath.ts"

/**
 * The shared folders of workflows (spec 025, "Shared folder"). A name of a file compares in the way
 * of the file system of the folder: a system that ignores case (macOS, Windows) folds it. Linux
 * keeps it. This is the same choice as for the permission rules (spec 007).
 */
export const foldCase = process.platform !== "linux"

/** The key of a path: its real path, folded as above. A link counts at its target (spec 025). */
export const pathKey = (path: string): string => {
  const real = realOf(path)
  return foldCase ? real.toLowerCase() : real
}

/**
 * The other workflows of the profile whose folder is the folder of this workflow, is inside it, or
 * holds it. A workflow of another profile takes no part (spec 025). Each folder is compared after
 * its links are resolved. Sorted by name, so the line in the editor and the note are stable.
 */
export const sharingWorkflows = (
  db: DatabaseService,
  workflowId: string,
): readonly { id: string; name: string }[] => {
  const me = db.get<{ server_id: string; folder: string }>(
    "SELECT server_id, folder FROM workflow WHERE id = ?",
    workflowId,
  )
  if (!me) return []
  const mine = realOf(me.folder)
  return db
    .all<{ id: string; name: string; folder: string }>(
      "SELECT id, name, folder FROM workflow WHERE server_id = ? AND id != ? ORDER BY name_key, id",
      me.server_id,
      workflowId,
    )
    .filter((other) => sharesFolder(mine, realOf(other.folder), foldCase))
    .map(({ id, name }) => ({ id, name }))
}
