import { randomUUID } from "node:crypto"
import type { WorkflowInput } from "@robot/shared"
import type { DatabaseService } from "./Database.ts"
import type { EventBusService } from "./EventBus.ts"

/**
 * Stores a new workflow and tells the app (spec 010). It checks nothing: the caller has checked the
 * graph and the owner. It sits apart from the service because the tools of an agent make
 * workflows, and the service needs the tools.
 */
export const insertWorkflow = (
  db: DatabaseService,
  bus: Pick<EventBusService, "emit">,
  input: WorkflowInput,
  options?: { readonly enabled?: boolean },
): string => {
  const id = randomUUID()
  const now = Date.now()
  db.run(
    `INSERT INTO workflow (id, server_id, name, trigger, steps, edges, notes, enabled, last_checked_at, created_at, updated_at, owner_kind, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.serverId,
    input.name.trim(),
    JSON.stringify(input.trigger),
    JSON.stringify(input.steps),
    JSON.stringify(input.edges),
    JSON.stringify(input.notes ?? []),
    options?.enabled === false ? 0 : 1,
    now,
    now,
    now,
    input.owner?.kind ?? null,
    input.owner?.id ?? null,
  )
  bus.emit("workflows.changed", { serverId: input.serverId })
  return id
}
