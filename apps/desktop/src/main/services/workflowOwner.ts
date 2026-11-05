import type { WorkflowOwner } from "@robot/shared"
import type { DatabaseService } from "./Database.ts"

/**
 * The owner of a workflow as the app reads it (spec 010, "When the owner is gone"): the stored
 * organization or agent, or null when none is stored or the stored one does not exist any more. A
 * delete of an organization or of an agent, here or by sync, so needs no step that finds its
 * workflows.
 */
export const readWorkflowOwner = (
  db: DatabaseService,
  kind: string | null,
  id: string | null,
): WorkflowOwner | null => {
  if (id === null) return null
  if (kind === "organization")
    return db.get("SELECT 1 AS x FROM org_unit WHERE id = ?", id) ? { kind, id } : null
  if (kind === "agent")
    return db.get("SELECT 1 AS x FROM agent WHERE id = ?", id) ? { kind, id } : null
  return null
}
