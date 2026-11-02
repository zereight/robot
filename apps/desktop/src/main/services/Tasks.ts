import { randomUUID } from "node:crypto"
import {
  isActive,
  messageText,
  type Task,
  type TaskDetail,
  type TaskSource,
  type TaskState,
  taskLabel,
} from "@robot/shared"
import { Cause, Context, Deferred, Effect, Exit, Layer, Semaphore } from "effect"
import { Activity } from "./Activity.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Notifier } from "./Notifier.ts"

interface TaskRow {
  id: string
  agent_id: string
  agent_name: string
  prompt: string
  label: string
  source: TaskSource
  source_id: string | null
  parent_id: string | null
  retry_of: string | null
  message_id: string | null
  state: TaskState
  error_code: string | null
  error_detail: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export interface TaskInput {
  readonly agentId: string
  readonly prompt: string
  readonly source: TaskSource
  readonly sourceId: string | null
  readonly parentId?: string | null
  readonly retryOf?: string | null
  readonly messageId?: string | null
  /** A label of its own. Without it the label comes from the prompt. */
  readonly label?: string
}

/** Starts the work again for a failed or cancelled task of one source. */
export type RetryHandler = (task: Task) => Effect.Effect<void, AppError>

export interface TasksService {
  /** Makes a queued task. */
  create(input: TaskInput): Effect.Effect<Task>
  /**
   * Runs `work` for a task. An agent runs one task at a time: others wait, in order. The task
   * is running while `work` runs, then done, failed or cancelled by how `work` ends.
   */
  run<A, E, R>(
    taskId: string,
    agentId: string,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>
  /** Marks a running task as waiting for the user, or running again. */
  setWaiting(taskId: string, waiting: boolean): void
  /** Records which message holds the reply of a task. */
  setMessage(taskId: string, messageId: string): void
  /** Stops a task and its children. Stopping a finished task does nothing. */
  stop(taskId: string): Effect.Effect<void>
  retry(taskId: string): Effect.Effect<void, AppError>
  onRetry(source: TaskSource, handler: RetryHandler): void
  list(serverId: string): Effect.Effect<readonly Task[]>
  get(taskId: string): Effect.Effect<TaskDetail, AppError>
  /** The tasks that have this parent. */
  children(parentId: string): readonly Task[]
}

const LIST_MAX = 500
const RESULT_MAX = 4000

const SELECT = `SELECT t.*, a.name AS agent_name FROM task t JOIN agent a ON a.id = t.agent_id`

const toTask = (row: TaskRow): Task => ({
  id: row.id,
  agentId: row.agent_id,
  agentName: row.agent_name,
  prompt: row.prompt,
  label: row.label,
  source: row.source,
  sourceId: row.source_id,
  parentId: row.parent_id,
  retryOf: row.retry_of,
  messageId: row.message_id,
  state: row.state,
  error: row.error_code ? { code: row.error_code, detail: row.error_detail ?? "" } : null,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
})

export class Tasks extends Context.Service<Tasks, TasksService>()("robot/main/Tasks") {
  static readonly layer = Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const notifier = yield* Notifier
      const activity = yield* Activity
      const slots = new Map<string, Semaphore.Semaphore>()
      const stops = new Map<string, Deferred.Deferred<void>>()
      const live = new Set<string>()
      const retryHandlers = new Map<TaskSource, RetryHandler>()

      // Work that was running when the app closed did not finish.
      db.run(
        `UPDATE task SET state = 'failed', error_code = 'app_stopped', finished_at = ?
         WHERE state IN ('queued', 'running', 'waiting')`,
        Date.now(),
      )

      const row = (id: string) => db.get<TaskRow>(`${SELECT} WHERE t.id = ?`, id)
      const slot = (agentId: string) => {
        let s = slots.get(agentId)
        if (!s) {
          s = Semaphore.makeUnsafe(1)
          slots.set(agentId, s)
        }
        return s
      }
      const changed = (agentId: string) => {
        const server = db.get<{ server_id: string }>(
          "SELECT server_id FROM agent WHERE id = ?",
          agentId,
        )
        if (server) bus.emit("tasks.changed", { serverId: server.server_id })
      }
      const setState = (
        id: string,
        agentId: string,
        state: TaskState,
        error?: { code: string; detail: string },
      ) => {
        const now = Date.now()
        db.run(
          `UPDATE task SET state = ?, error_code = ?, error_detail = ?,
             started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
             finished_at = CASE WHEN ? IN ('done', 'failed', 'cancelled') THEN ? ELSE finished_at END
           WHERE id = ?`,
          state,
          error?.code ?? null,
          error?.detail ?? null,
          state,
          now,
          state,
          now,
          id,
        )
        changed(agentId)
        if (state === "failed" && error?.code !== "app_stopped") {
          const task = row(id)
          const agent = db.get<{ server_id: string; name: string }>(
            "SELECT server_id, name FROM agent WHERE id = ?",
            agentId,
          )
          if (task && agent) {
            // A routine that posts in a channel fails in that channel.
            const channelId =
              task.source === "channel"
                ? task.source_id
                : task.source === "routine" && task.source_id
                  ? (db.get<{ channel_id: string | null }>(
                      "SELECT channel_id FROM routine WHERE id = ?",
                      task.source_id,
                    )?.channel_id ?? null)
                  : null
            notifier.notify({
              kind: task.source === "routine" ? "routine_failed" : "task_failed",
              agentId,
              serverId: agent.server_id,
              channelId,
              title: agent.name,
              body: task.label || task.prompt,
              reason: { code: error?.code ?? "unknown", detail: error?.detail ?? "" },
              target: channelId
                ? { kind: "channel", id: channelId }
                : { kind: "agent", id: agentId },
            })
          }
        }
        // The place list shows a working dot on a channel, and a channel shows its plan steps.
        const source = db.get<{ source: string; source_id: string | null }>(
          "SELECT source, source_id FROM task WHERE id = ?",
          id,
        )
        if (source?.source === "channel" && source.source_id)
          bus.emit("channels.changed", { channelId: source.source_id })
      }

      const create = (input: TaskInput) =>
        Effect.sync(() => {
          const id = randomUUID()
          db.run(
            `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, retry_of,
               message_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
            id,
            input.agentId,
            input.prompt,
            input.label ? taskLabel(input.label) : taskLabel(input.prompt),
            input.source,
            input.sourceId,
            input.parentId ?? null,
            input.retryOf ?? null,
            input.messageId ?? null,
            Date.now(),
          )
          stops.set(id, Deferred.makeUnsafe<void>())
          changed(input.agentId)
          if (input.source === "channel" && input.sourceId)
            bus.emit("channels.changed", { channelId: input.sourceId })
          return toTask(row(id) as TaskRow)
        })

      const run = <A, E, R>(taskId: string, agentId: string, work: Effect.Effect<A, E, R>) => {
        const stopSignal = stops.get(taskId) ?? Deferred.makeUnsafe<void>()
        stops.set(taskId, stopSignal)
        live.add(taskId)
        const serverId = db.get<{ server_id: string }>(
          "SELECT server_id FROM agent WHERE id = ?",
          agentId,
        )?.server_id
        const guarded = slot(agentId).withPermits(1)(
          Effect.suspend(() => {
            setState(taskId, agentId, "running")
            if (serverId) activity.setWorking(agentId, serverId, true)
            return work.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (serverId) activity.setWorking(agentId, serverId, false)
                }),
              ),
            )
          }),
        )
        const stopped = Deferred.await(stopSignal).pipe(Effect.flatMap(() => Effect.interrupt))
        return Effect.raceFirst(guarded, stopped).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              live.delete(taskId)
              stops.delete(taskId)
              if (Exit.isSuccess(exit)) return setState(taskId, agentId, "done")
              if (Cause.hasInterruptsOnly(exit.cause)) return setState(taskId, agentId, "cancelled")
              const failure = Cause.squash(exit.cause) as { code?: unknown; detail?: unknown }
              setState(taskId, agentId, "failed", {
                code: typeof failure?.code === "string" ? failure.code : "unknown",
                detail: typeof failure?.detail === "string" ? failure.detail : "",
              })
            }),
          ),
        )
      }

      const childRows = (parentId: string) =>
        db.all<TaskRow>(`${SELECT} WHERE t.parent_id = ? ORDER BY t.created_at, t.rowid`, parentId)

      const stop = (taskId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = row(taskId)
          if (!current) return
          // A task that has no run (for example one made but not started) ends at once.
          if (isActive(current.state)) {
            const signal = stops.get(taskId)
            if (live.has(taskId) && signal) yield* Deferred.succeed(signal, undefined)
            else setState(taskId, current.agent_id, "cancelled")
          }
          for (const child of childRows(taskId)) yield* stop(child.id)
        })

      const retry = (taskId: string) =>
        Effect.suspend(() => {
          const current = row(taskId)
          if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
          if (current.state !== "failed" && current.state !== "cancelled")
            return Effect.fail(new AppError({ code: "cannot_retry_task" }))
          const handler = retryHandlers.get(current.source)
          if (!handler) return Effect.fail(new AppError({ code: "cannot_retry_task" }))
          return handler(toTask(current))
        })

      const resultOf = (task: Task) => {
        if (!task.messageId) return ""
        const found =
          db.get<{ parts: string }>("SELECT parts FROM message WHERE id = ?", task.messageId) ??
          db.get<{ parts: string }>(
            "SELECT parts FROM channel_message WHERE id = ?",
            task.messageId,
          )
        return found ? messageText({ parts: JSON.parse(found.parts) }).slice(0, RESULT_MAX) : ""
      }

      return Tasks.of({
        create,
        run,
        setWaiting: (taskId, waiting) => {
          const current = row(taskId)
          if (current && (current.state === "running" || current.state === "waiting"))
            setState(taskId, current.agent_id, waiting ? "waiting" : "running")
        },
        setMessage: (taskId, messageId) =>
          db.run("UPDATE task SET message_id = ? WHERE id = ?", messageId, taskId),
        stop,
        retry,
        onRetry: (source, handler) => void retryHandlers.set(source, handler),
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<TaskRow>(
                `${SELECT} WHERE a.server_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ${LIST_MAX}`,
                serverId,
              )
              .map(toTask),
          ),
        get: (taskId) =>
          Effect.suspend(() => {
            const current = row(taskId)
            if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
            const task = toTask(current)
            const children: Task[] = []
            const visit = (parentId: string) => {
              for (const child of childRows(parentId)) {
                children.push(toTask(child))
                visit(child.id)
              }
            }
            visit(taskId)
            return Effect.succeed({ task, children, result: resultOf(task) })
          }),
        children: (parentId) => childRows(parentId).map(toTask),
      })
    }),
  )
}
