import {
  QUEUE_BEHIND,
  QUEUE_SLOT,
  type QuietTurn,
  type RetryResult,
  type RunSource,
  retryNote,
  type TaskFilter,
  type TaskItem,
  type TaskState,
  type TaskView,
  taskMoments,
  taskTimes,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Database } from "./Database.ts"
import { AppError } from "./errors.ts"
import { Runs } from "./Runs.ts"
import { TaskQueue } from "./TaskQueue.ts"

/**
 * The Tasks page (spec 005, "Tasks page"): the table of tasks of all workflows, one task with its
 * input, result, times, moments and usage, and the actions Stop, Retry and Run next.
 */
export interface TasksService {
  /** The tasks, newest first, that match the filters. */
  readonly list: (filter?: TaskFilter) => Effect.Effect<readonly TaskItem[]>
  readonly get: (taskId: string) => Effect.Effect<TaskView, AppError>
  readonly stop: (taskId: string) => Effect.Effect<void, AppError>
  readonly runNext: (taskId: string) => Effect.Effect<void, AppError>
  /**
   * Tries a failed, blocked or cancelled task again. A first try with a step that may have
   * changed things gives the retry note first, and starts nothing, unless `confirmed`.
   */
  readonly retry: (taskId: string, confirmed?: boolean) => Effect.Effect<RetryResult, AppError>
  readonly quiet: () => readonly QuietTurn[]
}

/** The columns that a row of the list needs. The input and the result can be large. */
interface ListRow {
  id: string
  run_id: string
  workflow_id: string
  workflow_name: string
  node_name: string
  node_number: number
  kind: "text" | "decision" | null
  source: string
  state: string
  run_state: string
  run_started_at: number
  error_code: string | null
  error_detail: string | null
  retry_of: string | null
  progress: "not_sent" | "sent" | "started"
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface Row extends ListRow {
  input: string
  result: string
  steps: number
  kept_going: number
  first_reply_at: number | null
  ended_at: number | null
  ended_as: string | null
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  cost_micros: number | null
}

/** The most rows that the page reads. */
const LIST_MAX = 1000

const FROM = `FROM task t JOIN run r ON r.id = t.run_id JOIN workflow w ON w.id = t.workflow_id`
const JOINED = `w.name AS workflow_name, r.source AS source, r.state AS run_state,
    r.started_at AS run_started_at,
    (SELECT n.kind FROM workflow_node n WHERE n.id = t.node_id) AS kind`
/** One task, whole: for the view of a task. */
const SELECT = `SELECT t.*, ${JOINED} ${FROM}`
/** The rows of the list: no input, no result, no usage. */
const SELECT_LIST = `SELECT t.id, t.run_id, t.workflow_id, t.node_name, t.node_number, t.state,
    t.error_code, t.error_detail, t.retry_of, t.progress, t.created_at, t.started_at,
    t.finished_at, ${JOINED} ${FROM}`

export class Tasks extends Context.Service<Tasks, TasksService>()("robot/main/Tasks") {
  static readonly layer = Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const db = yield* Database
      const runs = yield* Runs
      const queue = yield* TaskQueue
      const log = yield* ActionLog

      const item = (r: ListRow, reasons: ReturnType<typeof queue.scheduler.reasons>): TaskItem => {
        const why = reasons.get(r.id)
        const quiet = queue.quiet.get(r.id)
        const queued = r.state === "queued"
        return {
          id: r.id,
          runId: r.run_id,
          workflowId: r.workflow_id,
          workflowName: r.workflow_name,
          nodeNumber: r.node_number,
          nodeName: r.node_name,
          kind: r.kind ?? "text",
          source: r.source as RunSource,
          state: r.state as TaskState,
          reasonCode: r.error_code,
          reasonText: r.error_detail,
          behind:
            queued && why?.kind === QUEUE_BEHIND
              ? {
                  runId: why.holder.runId,
                  runStartedAt: why.holder.runStartedAt,
                  nodeNumber: why.holder.nodeNumber,
                  nodeName: why.holder.nodeName,
                }
              : null,
          slots: queued && (why?.kind === QUEUE_SLOT || why === undefined) ? queue.slots() : null,
          retryOf: r.retry_of,
          progress: r.progress,
          createdAt: r.created_at,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          quiet: quiet ? { name: quiet.name, seconds: quiet.seconds } : null,
          canRunNext: queue.scheduler.canRunNext(r.id),
        }
      }

      const row = (taskId: string) => db.get<Row>(`${SELECT} WHERE t.id = ?`, taskId)

      const list = (filter: TaskFilter = {}) =>
        Effect.sync(() => {
          const where: string[] = []
          const params: (string | number)[] = []
          if (filter.state) {
            where.push("t.state = ?")
            params.push(filter.state)
          }
          if (filter.workflowId) {
            where.push("t.workflow_id = ?")
            params.push(filter.workflowId)
          }
          if (filter.source) {
            where.push("r.source = ?")
            params.push(filter.source)
          }
          const rows = db.all<ListRow>(
            `${SELECT_LIST} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY t.created_at DESC, t.rowid DESC LIMIT ${LIST_MAX}`,
            ...params,
          )
          const reasons = queue.scheduler.reasons()
          return rows.map((r) => item(r, reasons))
        })

      const get = (taskId: string) => {
        const r = row(taskId)
        if (!r) return Effect.fail(new AppError({ code: "task_not_found" }))
        return Effect.sync((): TaskView => {
          const base = item(r, queue.scheduler.reasons())
          return {
            ...base,
            input: r.input,
            result: r.result,
            times: taskTimes({
              state: base.state,
              reasonCode: r.error_code,
              createdAt: r.created_at,
              startedAt: r.started_at,
              firstReplyAt: r.first_reply_at,
              finishedAt: r.finished_at,
            }),
            moments: taskMoments({
              createdAt: r.created_at,
              startedAt: r.started_at,
              endedAt: r.ended_at,
              endedAs: r.ended_as,
              finishedAt: r.finished_at,
            }),
            usage: {
              input: r.input_tokens,
              output: r.output_tokens,
              cached: r.cached_tokens,
              costMicros: r.cost_micros,
            },
            steps: r.steps,
            keptGoing: r.kept_going,
            runState: r.run_state as TaskState,
            runStartedAt: r.run_started_at,
          }
        })
      }

      const retry = (taskId: string, confirmed = false) =>
        Effect.gen(function* () {
          const r = row(taskId)
          if (!r) return yield* new AppError({ code: "task_not_found" })
          if (!["failed", "blocked", "cancelled"].includes(r.state))
            return yield* new AppError({ code: "cannot_retry_task" })
          // The note shows first when the first try has a step that may have changed things.
          if (!confirmed) {
            const note = retryNote(log.ofTask(taskId))
            if (note) return { started: false, note } satisfies RetryResult
          }
          const runId = yield* runs.retryTask(taskId)
          return { started: true, runId } satisfies RetryResult
        })

      return Tasks.of({
        list,
        get,
        stop: (taskId) => runs.stopTask(taskId),
        runNext: (taskId) =>
          Effect.suspend(() =>
            queue.scheduler.runNext(taskId)
              ? Effect.void
              : Effect.fail(new AppError({ code: "cannot_run_next" })),
          ),
        retry,
        quiet: () => queue.quiet.turns(),
      })
    }),
  )
}
