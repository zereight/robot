import { randomUUID } from "node:crypto"
import type { ChecklistItem, ImportChecklist } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"

export interface ChecklistsService {
  /** Keeps the checklist of a new agent or workflow. An empty list makes no checklist. */
  create(
    owner: { agentId: string } | { workflowId: string },
    items: readonly ChecklistItem[],
  ): Effect.Effect<ImportChecklist | null>
  forAgent(agentId: string): Effect.Effect<ImportChecklist | null>
  forWorkflow(workflowId: string): Effect.Effect<ImportChecklist | null>
}

interface Row {
  id: string
  items: string
  created_at: number
}

const toChecklist = (row: Row | undefined): ImportChecklist | null =>
  row
    ? {
        id: row.id,
        items: JSON.parse(row.items) as ChecklistItem[],
        createdAt: row.created_at,
      }
    : null

/** The checklists that imports leave (spec 014, "Review before an import"). */
export class Checklists extends Context.Service<Checklists, ChecklistsService>()(
  "robot/main/Checklists",
) {
  static readonly layer = Layer.effect(
    Checklists,
    Effect.gen(function* () {
      const db = yield* Database
      return Checklists.of({
        create: (owner, items) =>
          Effect.sync(() => {
            if (items.length === 0) return null
            const checklist: ImportChecklist = {
              id: randomUUID(),
              items: [...items],
              createdAt: Date.now(),
            }
            db.run(
              "INSERT INTO import_checklist (id, agent_id, workflow_id, items, created_at) VALUES (?, ?, ?, ?, ?)",
              checklist.id,
              "agentId" in owner ? owner.agentId : null,
              "workflowId" in owner ? owner.workflowId : null,
              JSON.stringify(checklist.items),
              checklist.createdAt,
            )
            return checklist
          }),
        forAgent: (agentId) =>
          Effect.sync(() =>
            toChecklist(
              db.get<Row>(
                "SELECT id, items, created_at FROM import_checklist WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
                agentId,
              ),
            ),
          ),
        forWorkflow: (workflowId) =>
          Effect.sync(() =>
            toChecklist(
              db.get<Row>(
                "SELECT id, items, created_at FROM import_checklist WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
                workflowId,
              ),
            ),
          ),
      })
    }),
  )
}
