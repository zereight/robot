import { type CheckOutcome, checkGraphKey } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { checkWorkflow } from "../check/model.ts"
import { CHECK_LIMITS, type CheckLimits, withChecker } from "../check/runner.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import type { AppError } from "./errors.ts"
import { Workflows } from "./Workflows.ts"

export interface WorkflowCheckOptions {
  /** The limits of one check. Only tests set them. */
  readonly limits?: CheckLimits
  /**
   * Check a workflow in the background after a change (spec 010: the check runs on every change).
   * On in the app. Tests that do not read the check turn it off.
   */
  readonly auto?: boolean
}

/** The wait after the last change, so that a burst of changes makes one check. */
const AUTO_WAIT_MS = 250

export interface WorkflowCheckService {
  /**
   * The result of the check of the saved graph (spec 010, "Check"). A result that was stored for
   * the same graph is reused, unless `force` is true. The check reads the shape of the graph. It
   * starts no run, calls no model and sends nothing out.
   */
  readonly check: (
    workflowId: string,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<CheckOutcome, AppError>
}

/** Checks the graph of a workflow, keeps the result, and tells the windows (spec 010, "Check"). */
export class WorkflowCheck extends Context.Service<WorkflowCheck, WorkflowCheckService>()(
  "robot/main/WorkflowCheck",
) {
  static readonly layer = (options: WorkflowCheckOptions = {}) =>
    Layer.effect(
      WorkflowCheck,
      Effect.gen(function* () {
        const db = yield* Database
        const bus = yield* EventBus
        const workflows = yield* Workflows
        const limits = options.limits ?? CHECK_LIMITS
        let closed = false
        /** The checks that work now, one for each workflow and graph. */
        const working = new Map<string, Promise<CheckOutcome>>()

        const run = (workflowId: string, force: boolean) =>
          Effect.gen(function* () {
            const detail = yield* workflows.get(workflowId)
            if (detail.checkOutcome && !force) return detail.checkOutcome
            const key = checkGraphKey(detail.graph)
            const id = `${workflowId}:${key}`
            let promise = working.get(id)
            if (!promise) {
              promise = withChecker(limits, (model) => checkWorkflow(detail.graph, model))
                .catch(
                  (error): CheckOutcome => ({
                    state: "failed",
                    message: error instanceof Error ? error.message : String(error),
                  }),
                )
                .then((outcome) => {
                  working.delete(id)
                  // The window shows a translated text. The words of the checker stay in the log.
                  if (outcome.state === "failed")
                    console.error("check: the checker failed:", outcome.message)
                  // The workflow may be gone: the row of the result goes with it.
                  if (!closed && db.get("SELECT 1 FROM workflow WHERE id = ?", workflowId)) {
                    db.run(
                      `INSERT INTO workflow_check (workflow_id, graph_key, outcome, checked_at)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT (workflow_id) DO UPDATE SET graph_key = excluded.graph_key,
                         outcome = excluded.outcome, checked_at = excluded.checked_at`,
                      workflowId,
                      key,
                      JSON.stringify(outcome),
                      Date.now(),
                    )
                    bus.emit("workflows.changed", { serverId: detail.serverId })
                  }
                  return outcome
                })
              working.set(id, promise)
            }
            return yield* Effect.promise(() => promise as Promise<CheckOutcome>)
          })

        // A change of the graph starts a check of the graphs that have no result (spec 010).
        if (options.auto) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const serversChanged = new Set<string>()
          const refresh = () => {
            const servers = [...serversChanged]
            serversChanged.clear()
            for (const serverId of servers)
              void Effect.runPromise(
                workflows.list(serverId).pipe(
                  Effect.flatMap((list) =>
                    Effect.forEach(
                      list.filter((w) => w.check === "not_checked"),
                      (w) => run(w.id, false).pipe(Effect.ignore),
                      { concurrency: 2 },
                    ),
                  ),
                ),
              ).catch(() => {})
          }
          bus.tap((event, payload) => {
            if (closed || event !== "workflows.changed") return
            serversChanged.add((payload as { serverId: string }).serverId)
            clearTimeout(timer)
            timer = setTimeout(refresh, AUTO_WAIT_MS)
          })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true
              clearTimeout(timer)
            }),
          )
        } else
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true
            }),
          )

        return WorkflowCheck.of({
          check: (workflowId, opts) => run(workflowId, opts?.force === true),
        })
      }),
    )
}
