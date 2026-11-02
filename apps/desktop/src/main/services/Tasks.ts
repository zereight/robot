import { randomUUID } from "node:crypto"
import {
  isActive,
  isRuntimeKind,
  isTaskProgress,
  messageText,
  raiseProgress,
  type Task,
  type TaskDetail,
  type TaskProgress,
  type TaskSource,
  type TaskState,
  taskLabel,
} from "@robot/shared"
import { Cause, Context, Deferred, Effect, Exit, Layer, Semaphore } from "effect"
import { resumeOf } from "../providers/resume.ts"
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
  asked_at: number | null
  first_reply_at: number | null
  origin: string | null
  progress: string | null
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
  /**
   * When the message that started the task was sent (spec 005). Without it the times of the task
   * count from the moment it is made.
   */
  readonly askedAt?: number | null
}

/** Starts the work again for a failed or cancelled task of one source. */
export type RetryHandler = (task: Task) => Effect.Effect<void, AppError>

/**
 * What the sync service tells the tasks about the other computer (spec 019). The tasks cannot
 * ask the sync service themselves, because it is built after them.
 */
export interface RemoteTasks {
  /** The name of the computer that has this id. */
  nameOf(originId: string): string
  /** The name of the other computer when it runs a task of this agent now and both are online. */
  busyOn(agentId: string): string | null
  /** Asks the computer where a task runs to stop it. */
  stop(taskId: string, originId: string): Effect.Effect<void, AppError>
}

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
    options?: { readonly resumed?: boolean },
  ): Effect.Effect<A, E, R>
  /**
   * The tasks that waited for an approval or a question when the app closed and wait on (spec
   * 005). The chat starts their turns again. `run` with `resumed` keeps the place of the agent.
   */
  waitingAfterRestart(): readonly Task[]
  /** Marks a running task as waiting for the user, or running again. */
  setWaiting(taskId: string, waiting: boolean): void
  /**
   * Records how far the turn of a task went (spec 005). The progress only goes up: a lower value,
   * or the same one, changes nothing.
   */
  setProgress(taskId: string, progress: TaskProgress): void
  /** Records which message holds the reply of a task. */
  setMessage(taskId: string, messageId: string): void
  /**
   * Records that the first part of the reply that the user sees is stored now (spec 005). Only the
   * first call counts.
   */
  replied(taskId: string): void
  /** Stops a task and its children. Stopping a finished task does nothing. */
  stop(taskId: string): Effect.Effect<void>
  /** Like `stop`, and a task of the other computer is stopped there (spec 019). */
  stopAny(taskId: string): Effect.Effect<void, AppError>
  /** Stops the tasks of this agent that run on the other computer (spec 019). Local ones stay. */
  stopRemoteFor(agentId: string): Effect.Effect<void, AppError>
  /** The sync service gives its view of the other computer. */
  setRemote(remote: RemoteTasks): void
  /** The name of the other computer with this id, for "Runs on <name>" (spec 019). */
  computerName(originId: string): string
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

const toTask = (row: TaskRow, remote?: RemoteTasks): Task => ({
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
  askedAt: row.asked_at,
  firstReplyAt: row.first_reply_at,
  originName: row.origin === null ? null : (remote?.nameOf(row.origin) ?? ""),
  waitsFor:
    row.state === "queued" && row.origin === null ? (remote?.busyOn(row.agent_id) ?? null) : null,
  progress: isTaskProgress(row.progress) ? row.progress : null,
})

/** How often a task that waits for the other computer looks again. */
const REMOTE_POLL_MS = 300

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
      let remote: RemoteTasks | undefined

      // A task that waits for an approval or a question can wait through a restart when it has no
      // parent task, is no part of a workflow run, and has no vendor runtime (spec 005). Its card
      // and its place are kept. Its turn starts again in the chat.
      const keepIds = db
        .all<{ id: string; parts: string; kind: string | null }>(
          `SELECT t.id, m.parts, p.kind FROM task t
             JOIN agent a ON a.id = t.agent_id
             JOIN message m ON m.id = t.message_id
             LEFT JOIN provider_account p ON p.id = a.model_account_id
           WHERE t.state = 'waiting' AND t.origin IS NULL AND t.parent_id IS NULL
             AND t.source IN ('chat', 'routine') AND a.archived_at IS NULL
             AND m.status = 'streaming' AND m.origin IS NULL`,
        )
        .filter((r) => r.kind !== null && !isRuntimeKind(r.kind))
        .filter((r) => {
          try {
            return resumeOf(JSON.parse(r.parts)) !== undefined
          } catch {
            return false
          }
        })
        .map((r) => r.id)
      // Work that was running when the app closed did not finish. A task of the other computer
      // (spec 019) is not ours to end: its own computer does.
      db.run(
        `UPDATE task SET state = 'failed', error_code = 'app_stopped', finished_at = ?
         WHERE state IN ('queued', 'running', 'waiting') AND origin IS NULL
           AND id NOT IN (SELECT value FROM json_each(?))`,
        Date.now(),
        JSON.stringify(keepIds),
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
          const now = Date.now()
          db.run(
            `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, retry_of,
               message_id, state, created_at, asked_at, progress)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 'not_sent')`,
            id,
            input.agentId,
            input.prompt,
            input.label ? taskLabel(input.label) : taskLabel(input.prompt),
            input.source,
            input.sourceId,
            input.parentId ?? null,
            input.retryOf ?? null,
            input.messageId ?? null,
            now,
            input.askedAt == null ? null : Math.min(input.askedAt, now),
          )
          stops.set(id, Deferred.makeUnsafe<void>())
          changed(input.agentId)
          if (input.source === "channel" && input.sourceId)
            bus.emit("channels.changed", { channelId: input.sourceId })
          return toTask(row(id) as TaskRow, remote)
        })

      const run = <A, E, R>(
        taskId: string,
        agentId: string,
        work: Effect.Effect<A, E, R>,
        options?: { readonly resumed?: boolean },
      ) => {
        const stopSignal = stops.get(taskId) ?? Deferred.makeUnsafe<void>()
        stops.set(taskId, stopSignal)
        live.add(taskId)
        const serverId = db.get<{ server_id: string }>(
          "SELECT server_id FROM agent WHERE id = ?",
          agentId,
        )?.server_id
        const guarded = slot(agentId).withPermits(1)(
          Effect.gen(function* () {
            // One task per agent across both computers (spec 019): while the other computer runs
            // a task of this agent, this one stays queued.
            let told = false
            while (!options?.resumed && remote?.busyOn(agentId)) {
              if (!told) changed(agentId)
              told = true
              yield* Effect.sleep(REMOTE_POLL_MS)
            }
            // A task that waited through a restart goes on waiting until its card is answered.
            if (!options?.resumed) setState(taskId, agentId, "running")
            if (serverId) activity.setWorking(agentId, serverId, true)
            return yield* work.pipe(
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
          // A task of the other computer is stopped there, never changed here.
          if (!current || current.origin !== null) return
          // A task that has no run (for example one made but not started) ends at once.
          if (isActive(current.state)) {
            const signal = stops.get(taskId)
            if (live.has(taskId) && signal) yield* Deferred.succeed(signal, undefined)
            else setState(taskId, current.agent_id, "cancelled")
          }
          for (const child of childRows(taskId)) yield* stop(child.id)
        })

      const stopAny = (taskId: string): Effect.Effect<void, AppError> =>
        Effect.suspend(() => {
          const current = row(taskId)
          if (current?.origin == null || !remote) return stop(taskId)
          return remote.stop(taskId, current.origin)
        })

      const retry = (taskId: string) =>
        Effect.suspend(() => {
          const current = row(taskId)
          if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
          if (current.state !== "failed" && current.state !== "cancelled")
            return Effect.fail(new AppError({ code: "cannot_retry_task" }))
          const handler = retryHandlers.get(current.source)
          if (!handler) return Effect.fail(new AppError({ code: "cannot_retry_task" }))
          return handler(toTask(current, remote))
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

      /** The messages that the user sent into the turn of the task (spec 003). */
      const joinedOf = (task: Task) =>
        task.messageId
          ? db
              .all<{ parts: string; created_at: number }>(
                "SELECT parts, created_at FROM message WHERE joined_to = ? ORDER BY created_at, rowid",
                task.messageId,
              )
              .map((r) => ({
                text: messageText({ parts: JSON.parse(r.parts) }).slice(0, RESULT_MAX),
                at: r.created_at,
              }))
          : []

      return Tasks.of({
        create,
        run,
        waitingAfterRestart: () =>
          keepIds.flatMap((id) => {
            const r = row(id)
            return r ? [toTask(r, remote)] : []
          }),
        setWaiting: (taskId, waiting) => {
          const current = row(taskId)
          if (current && (current.state === "running" || current.state === "waiting"))
            setState(taskId, current.agent_id, waiting ? "waiting" : "running")
        },
        setProgress: (taskId, progress) => {
          const current = row(taskId)
          // Only the computer that owns a task records its progress (spec 019).
          if (!current || current.origin !== null) return
          const next = raiseProgress(
            isTaskProgress(current.progress) ? current.progress : null,
            progress,
          )
          if (next === current.progress) return
          db.run("UPDATE task SET progress = ? WHERE id = ?", next, taskId)
          changed(current.agent_id)
        },
        setMessage: (taskId, messageId) =>
          db.run("UPDATE task SET message_id = ? WHERE id = ?", messageId, taskId),
        replied: (taskId) => {
          const current = row(taskId)
          if (!current || current.first_reply_at !== null || current.origin !== null) return
          db.run(
            "UPDATE task SET first_reply_at = ? WHERE id = ? AND first_reply_at IS NULL",
            Date.now(),
            taskId,
          )
          changed(current.agent_id)
        },
        stop,
        stopAny,
        stopRemoteFor: (agentId) =>
          Effect.forEach(
            db.all<{ id: string }>(
              `SELECT id FROM task WHERE agent_id = ? AND origin IS NOT NULL AND parent_id IS NULL
                 AND state IN ('queued', 'running', 'waiting')`,
              agentId,
            ),
            (t) => stopAny(t.id),
            { discard: true },
          ),
        setRemote: (hooks) => {
          remote = hooks
        },
        computerName: (originId) => remote?.nameOf(originId) ?? "",
        retry,
        onRetry: (source, handler) => void retryHandlers.set(source, handler),
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<TaskRow>(
                `${SELECT} WHERE a.server_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ${LIST_MAX}`,
                serverId,
              )
              .map((r) => toTask(r, remote)),
          ),
        get: (taskId) =>
          Effect.suspend(() => {
            const current = row(taskId)
            if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
            const task = toTask(current, remote)
            const children: Task[] = []
            const visit = (parentId: string) => {
              for (const child of childRows(parentId)) {
                children.push(toTask(child, remote))
                visit(child.id)
              }
            }
            visit(taskId)
            return Effect.succeed({
              task,
              children,
              result: resultOf(task),
              joined: joinedOf(task),
            })
          }),
        children: (parentId) => childRows(parentId).map((r) => toTask(r, remote)),
      })
    }),
  )
}
