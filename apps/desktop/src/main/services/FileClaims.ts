import {
  CLAIM_LIMIT_TEXT,
  CLAIM_NOTE_PATHS,
  CLAIMS_MAX,
  type ClaimHolder,
  type NoteClaim,
  sharedFolderNote,
  type TaskClaims,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database, type DatabaseService } from "./Database.ts"
import { pathKey, sharingWorkflows } from "./sharedFolders.ts"

/** What a claim attempt came to (spec 025, flow 3 and "Rules"). */
export type ClaimOutcome =
  | { readonly kind: "ok" }
  /** A task of another workflow holds a file: the step does not run. */
  | { readonly kind: "held"; readonly path: string; readonly holder: ClaimHolder }
  /** The task holds 1000 claims already: the step does not run. */
  | { readonly kind: "limit"; readonly text: string }

export interface ClaimInput {
  readonly taskId: string
  readonly workflowId: string
  /** The files that one step changes. A rename gives the old path and the new path (spec 025). */
  readonly paths: readonly string[]
}

export interface FileClaimsService {
  /**
   * Tells what a step on these files would come to, and holds nothing. The check comes first, so a
   * step that cannot run never asks the user.
   */
  readonly check: (input: ClaimInput) => ClaimOutcome
  /**
   * Checks the step, and when it may run, gives the task a claim on each file. The files of one
   * step are claimed together or not at all. A workflow whose folder is not shared holds no claim
   * (spec 025, "Concepts"), but a file that another workflow holds is still refused.
   */
  readonly claim: (input: ClaimInput) => ClaimOutcome
  /** Ends the claims of a task. Called when the task is final (spec 025, flow 4). */
  readonly release: (taskId: string) => void
  /** The claims of a task, newest first, for the run view. */
  readonly ofTask: (taskId: string) => TaskClaims
  /**
   * The shared folder note for the start of a turn of a text node of this workflow, or null when
   * the folder is not shared (spec 025, "Shared folder note").
   */
  readonly note: (workflowId: string) => string | null
}

interface HolderRow {
  task_id: string
  workflow_id: string
  path: string
  workflow_name: string
  node_name: string | null
  node_number: number | null
  prompt: string | null
}

/** The claims, with the workflow and the node of each task, for a holder or the note. */
const HOLDER_SELECT = `SELECT c.task_id, c.workflow_id, c.path, w.name AS workflow_name,
    t.node_name, t.node_number, n.prompt
  FROM file_claim c
  JOIN workflow w ON w.id = c.workflow_id
  LEFT JOIN task t ON t.id = c.task_id
  LEFT JOIN workflow_node n ON n.id = t.node_id`

const toHolder = (r: HolderRow): ClaimHolder => ({
  workflow: r.workflow_name,
  nodeNumber: r.node_number,
  node: r.node_name,
  prompt: r.prompt ?? "",
})

export const makeFileClaims = (db: DatabaseService): FileClaimsService => {
  const check = (input: ClaimInput): ClaimOutcome => {
    const keys = [...new Set(input.paths.map(pathKey))]
    // The claims of another workflow of the same profile. A workflow never holds a claim against
    // itself, because it runs one task at a time (spec 025, "Rules"); the claims of its own tasks
    // are ignored, also those of an older task that is not final.
    for (const key of keys) {
      const held = db.get<HolderRow>(
        `${HOLDER_SELECT}
         WHERE c.path_key = ? AND c.workflow_id != ?
           AND w.server_id = (SELECT server_id FROM workflow WHERE id = ?)
         ORDER BY c.at DESC LIMIT 1`,
        key,
        input.workflowId,
        input.workflowId,
      )
      if (held) return { kind: "held", path: held.path, holder: toHolder(held) }
    }
    const mine = new Set(
      db
        .all<{ path_key: string }>(
          "SELECT path_key FROM file_claim WHERE task_id = ?",
          input.taskId,
        )
        .map((r) => r.path_key),
    )
    const fresh = keys.filter((k) => !mine.has(k)).length
    if (mine.size + fresh > CLAIMS_MAX) return { kind: "limit", text: CLAIM_LIMIT_TEXT }
    return { kind: "ok" }
  }

  return {
    check,
    claim: (input) =>
      db.transaction(() => {
        const outcome = check(input)
        if (outcome.kind !== "ok") return outcome
        if (sharingWorkflows(db, input.workflowId).length === 0) return outcome
        const at = Date.now()
        for (const path of input.paths)
          db.run(
            `INSERT INTO file_claim (task_id, workflow_id, path, path_key, at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (task_id, path_key) DO UPDATE SET at = excluded.at`,
            input.taskId,
            input.workflowId,
            path,
            pathKey(path),
            at,
          )
        return outcome
      }),
    release: (taskId) => db.run("DELETE FROM file_claim WHERE task_id = ?", taskId),
    ofTask: (taskId) => ({
      count:
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM file_claim WHERE task_id = ?", taskId)
          ?.n ?? 0,
      paths: db
        .all<{ path: string }>(
          "SELECT path FROM file_claim WHERE task_id = ? ORDER BY at DESC, path LIMIT ?",
          taskId,
          CLAIM_NOTE_PATHS,
        )
        .map((r) => r.path),
    }),
    note: (workflowId) => {
      const others = sharingWorkflows(db, workflowId)
      if (others.length === 0) return null
      const rows = db.all<HolderRow>(
        `${HOLDER_SELECT}
         WHERE c.workflow_id IN (${others.map(() => "?").join(", ")})
         ORDER BY c.at DESC, c.path`,
        ...others.map((o) => o.id),
      )
      const claims: NoteClaim[] = rows.map((r) => ({
        path: r.path,
        workflow: r.workflow_name,
        nodeNumber: r.node_number,
        node: r.node_name,
      }))
      return sharedFolderNote({ others: others.map((o) => o.name), claims })
    },
  }
}

/**
 * The file claims of the app (spec 025). Every claim ends at the start: after a restart every task
 * is final, one that waited too (spec 005), so no claim is left.
 */
export class FileClaims extends Context.Service<FileClaims, FileClaimsService>()(
  "robot/main/FileClaims",
) {
  static readonly layer = Layer.effect(
    FileClaims,
    Effect.gen(function* () {
      const db = yield* Database
      db.run("DELETE FROM file_claim")
      return FileClaims.of(makeFileClaims(db))
    }),
  )
}
