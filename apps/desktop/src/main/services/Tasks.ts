import { randomUUID } from "node:crypto"
import {
  type ActionDecider,
  blockedError,
  isActive,
  isDecision,
  isEndedAs,
  isFinal,
  isRuntimeKind,
  isTaskProgress,
  isVerdict,
  type LoggedStep,
  lastChange,
  messageText,
  type OutsideSource,
  RECENT_WORK_MAX,
  type RecentPlace,
  type RecentWorkRow,
  type RetryNote,
  type RetryResult,
  raiseProgress,
  remoteRetryNote,
  retryNote,
  type Task,
  type TaskDetail,
  type TaskProgress,
  type TaskSource,
  type TaskState,
  type TurnEnd,
  taskLabel,
  type Verdict,
  validChanges,
} from "@robot/shared"
import { Cause, Context, Deferred, Effect, Exit, Layer } from "effect"
import { resumeOf } from "../providers/resume.ts"
import { ActionLog } from "./ActionLog.ts"
import { Activity } from "./Activity.ts"
import { AgentGate, rankOf } from "./agentGate.ts"
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
  depth: number
  done_test: string | null
  verdict: string | null
  verdict_reason: string | null
  judged_at: number | null
  decided_at: number | null
  ended_at: number | null
  ended_as: string | null
  decision: string | null
  decision_text: string | null
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
  /**
   * How deep the task is in a chain of messages between agents (spec 005). Without it, a part
   * and a retry keep the depth of the task that made them, and any other task has depth 0.
   */
  readonly depth?: number
  /** What a finished part must hold: one line, up to 200 characters (spec 004). */
  readonly doneTest?: string | null
}

/** One step of a task for the action log (spec 007). */
export interface StepRecord extends Omit<LoggedStep, "at"> {
  readonly agentId: string
  readonly taskId: string
  /** Who decided that the step ran or did not run. */
  readonly decidedBy: ActionDecider
  /** The first source of outside content of the turn, or null. */
  readonly outside: OutsideSource | null
}

export interface RetryOptions {
  /** The user read the retry note and chose "Retry anyway". */
  readonly confirmed?: boolean
  /**
   * The name of this computer, when the request comes from a linked device (spec 012). The
   * steps are on this computer and not on the one that asks, so the note has no list.
   */
  readonly awayFrom?: string
}

/** Starts the work again for a failed, blocked or cancelled task of one source. */
export type RetryHandler = (task: Task) => Effect.Effect<void, AppError>

/**
 * Starts the new part that "Request changes" asks for (spec 005): the same member, `text` as the
 * prompt, linked to `old` and in the same request.
 */
export type ChangesHandler = (old: Task, text: string) => Effect.Effect<void, AppError>

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
   * Runs `work` for a task. An agent runs one task at a time: others wait, in the order of spec
   * 005 ("Queue"): tasks of the user and of other agents first, then routines and workflows. The task
   * is running while `work` runs, then done, failed or cancelled by how `work` ends.
   */
  run<A, E, R>(
    taskId: string,
    agentId: string,
    work: Effect.Effect<A, E, R>,
    options?: {
      readonly resumed?: boolean
      /**
       * Says how a turn that ended with no error ends the task: done, blocked, or in review
       * (spec 005). Without it the task is done. A turn with an error is failed and a stopped
       * turn is cancelled, whatever this says.
       */
      readonly finish?: (value: A) => TurnEnd
    },
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
   * Saves the verdict of the lead for a part (spec 004, 005). A verdict is a field: the state of
   * the part does not change. It is saved only for a part that is done, has a done test, has no
   * verdict, and has no decision of the user. Gives true when it was saved.
   */
  judge(taskId: string, verdict: Verdict, reason: string | null): boolean
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
  /**
   * Ends the review of a part: the task is done (spec 005). Only on the computer that owns the
   * task, and only for a task in review.
   */
  accept(taskId: string): Effect.Effect<void, AppError>
  /**
   * Ends the review as done and starts a new part for the same member with `text` (1 to 2000
   * characters) as its prompt (spec 005).
   */
  requestChanges(taskId: string, text: string): Effect.Effect<void, AppError>
  /**
   * Cancels every task of the request of this task that is not final, also a task in review, and
   * stops the turns that still run. A task that is done keeps its result (spec 004, 005).
   */
  endRequest(taskId: string): Effect.Effect<void, AppError>
  /** The sync service gives its view of the other computer. */
  setRemote(remote: RemoteTasks): void
  /** The name of the other computer with this id, for "Runs on <name>" (spec 019). */
  computerName(originId: string): string
  /**
   * Tries a task again. When the first try (and its parts) ran steps that may have changed
   * things, and the request is not `confirmed`, nothing starts and the answer holds the note
   * (spec 005, "Retry note").
   */
  retry(taskId: string, options?: RetryOptions): Effect.Effect<RetryResult, AppError>
  /** The note for a retry of this task, or null when the retry starts at once. */
  noteFor(taskId: string, options?: Pick<RetryOptions, "awayFrom">): RetryNote | null
  /** The depth of a task in a chain of messages between agents. 0 for an unknown task. */
  depthOf(taskId: string): number
  /** Adds a step of a task to the action log (spec 007). */
  recordStep(step: StepRecord): void
  /** The logged steps of a task, oldest first. */
  steps(taskId: string): readonly LoggedStep[]
  onRetry(source: TaskSource, handler: RetryHandler): void
  /** Sets how a source starts the new part of "Request changes". */
  onChanges(source: TaskSource, handler: ChangesHandler): void
  /** Calls `listener` when a task ends as done, failed, blocked or cancelled. */
  onEnd(listener: (task: Task) => void): void
  list(serverId: string): Effect.Effect<readonly Task[]>
  get(taskId: string): Effect.Effect<TaskDetail, AppError>
  /**
   * The last 20 tasks of an agent, newest first, each with what it waits for (spec 002, "Recent
   * work"): an approval or a question for a task that waits, and the place of the work that an
   * agent runs now for a task that is queued.
   */
  recent(agentId: string): readonly RecentWorkRow[]
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
  doneTest: row.done_test,
  verdict: isVerdict(row.verdict) ? row.verdict : null,
  verdictReason: row.verdict_reason,
  judgedAt: row.judged_at,
  decidedAt: row.decided_at,
  endedAt: row.ended_at,
  endedAs: isEndedAs(row.ended_as) ? row.ended_as : null,
  decision: isDecision(row.decision) ? row.decision : null,
  decisionText: row.decision_text,
})

/** How often a task that waits for the other computer looks again. */
const REMOTE_POLL_MS = 300

export class Tasks extends Context.Service<Tasks, TasksService>()("robot/main/Tasks") {
  static readonly layer = Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const actionLog = yield* ActionLog
      const notifier = yield* Notifier
      const activity = yield* Activity
      const slots = new Map<string, AgentGate>()
      const stops = new Map<string, Deferred.Deferred<void>>()
      const live = new Set<string>()
      const retryHandlers = new Map<TaskSource, RetryHandler>()
      const changesHandlers = new Map<TaskSource, ChangesHandler>()
      const endListeners: ((task: Task) => void)[] = []
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
          s = new AgentGate()
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
      /** A part waits for the review of the user: one notification of the kind "part in review". */
      const reviewNotice = (id: string, agentId: string) => {
        const task = row(id)
        const agent = db.get<{ server_id: string; name: string }>(
          "SELECT server_id, name FROM agent WHERE id = ?",
          agentId,
        )
        const channel =
          task?.source === "channel" && task.source_id
            ? db.get<{ name: string }>("SELECT name FROM channel WHERE id = ?", task.source_id)
            : undefined
        // The main process holds no interface text, so the title and the body are names and the label.
        if (task && agent && channel && task.source_id && task.origin === null)
          notifier.notify({
            kind: "part_review",
            agentId,
            serverId: agent.server_id,
            channelId: task.source_id,
            title: `${agent.name} · ${channel.name}`,
            body: task.label || task.prompt,
            target: {
              kind: "channel",
              id: task.source_id,
              ...(task.message_id ? { messageId: task.message_id } : {}),
            },
          })
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
             finished_at = CASE WHEN ? IN ('done', 'failed', 'blocked', 'cancelled') THEN ? ELSE finished_at END
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
        // The turn ended: the moment and how it ended are kept once (spec 005, "Moments"). A task
        // that never started has no turn, so it has no such moment. A later change of the state
        // (the user accepts a part in review) leaves it as it is.
        if (isFinal(state) || state === "review")
          db.run(
            `UPDATE task SET ended_at = ?, ended_as = ?
             WHERE id = ? AND ended_at IS NULL AND started_at IS NOT NULL`,
            now,
            state,
            id,
          )
        changed(agentId)
        if (isFinal(state)) {
          const ended = endListeners.length > 0 ? row(id) : undefined
          // A listener never stops the end of a task.
          if (ended)
            for (const listener of endListeners) {
              try {
                listener(toTask(ended, remote))
              } catch (e) {
                console.error("task end listener failed", e)
              }
            }
        }
        if (state === "review") reviewNotice(id, agentId)
        // A blocked task is a failed one for the notice (spec 005, 015).
        if (state === "blocked" || (state === "failed" && error?.code !== "app_stopped")) {
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

      const depthOf = (taskId: string | null | undefined) =>
        taskId
          ? (db.get<{ depth: number }>("SELECT depth FROM task WHERE id = ?", taskId)?.depth ?? 0)
          : 0

      const create = (input: TaskInput) =>
        Effect.sync(() => {
          const id = randomUUID()
          const now = Date.now()
          const depth = input.depth ?? depthOf(input.parentId ?? input.retryOf)
          db.run(
            `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, retry_of,
               message_id, state, created_at, asked_at, depth, progress, done_test)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 'not_sent', ?)`,
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
            depth,
            input.doneTest ?? null,
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
        options?: {
          readonly resumed?: boolean
          readonly finish?: (value: A) => TurnEnd
        },
      ) => {
        const stopSignal = stops.get(taskId) ?? Deferred.makeUnsafe<void>()
        stops.set(taskId, stopSignal)
        live.add(taskId)
        const serverId = db.get<{ server_id: string }>(
          "SELECT server_id FROM agent WHERE id = ?",
          agentId,
        )?.server_id
        const source = db.get<{ source: TaskSource }>(
          "SELECT source FROM task WHERE id = ?",
          taskId,
        )
        // Tasks of the user and of other agents start before those of routines and workflows (spec
        // 005, "Queue").
        const rank = source ? rankOf(source.source) : 0
        const guarded = slot(agentId).run(
          rank,
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
              if (Exit.isSuccess(exit)) {
                let end: TurnEnd = { state: "done" }
                // A reading that fails never stops the end of a task.
                try {
                  if (options?.finish) end = options.finish(exit.value)
                } catch (e) {
                  console.error("task finish failed", e)
                }
                if (end.state === "blocked")
                  return setState(taskId, agentId, "blocked", blockedError(end.reason))
                return setState(taskId, agentId, end.state)
              }
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

      /** The task and every task below it: the parts of a plan count for the retry of the lead. */
      const withDescendants = (taskId: string): string[] => [
        taskId,
        ...childRows(taskId).flatMap((child) => withDescendants(child.id)),
      ]

      const steps = (taskId: string): readonly LoggedStep[] =>
        actionLog
          .ofTask(taskId)
          .flatMap((e) =>
            e.kind === "file" || e.kind === "shell" || e.kind === "web" || e.kind === "connection"
              ? [{ at: e.at, kind: e.kind, access: e.access, target: e.target, result: e.result }]
              : [],
          )

      const noteFor = (taskId: string, options?: Pick<RetryOptions, "awayFrom">) => {
        const current = row(taskId)
        if (!current) return null
        // The steps of a task of the other computer are on that computer. The note shows with no
        // list, because this computer cannot tell that the first try changed nothing.
        if (current.origin !== null) return remoteRetryNote(remote?.nameOf(current.origin) ?? "")
        const note = retryNote(
          withDescendants(taskId)
            .flatMap((id) => steps(id))
            .sort((a, b) => a.at - b.at),
        )
        if (!note) return null
        // A linked device asks, and the steps are here: the note names this computer, no list.
        return options?.awayFrom ? remoteRetryNote(options.awayFrom) : note
      }

      const retry = (taskId: string, options?: RetryOptions) =>
        Effect.suspend((): Effect.Effect<RetryResult, AppError> => {
          const current = row(taskId)
          if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
          if (
            current.state !== "failed" &&
            current.state !== "blocked" &&
            current.state !== "cancelled"
          )
            return Effect.fail(new AppError({ code: "cannot_retry_task" }))
          const handler = retryHandlers.get(current.source)
          if (!handler) return Effect.fail(new AppError({ code: "cannot_retry_task" }))
          if (!options?.confirmed) {
            const note = noteFor(taskId, options)
            if (note) return Effect.succeed({ started: false, note })
          }
          return handler(toTask(current, remote)).pipe(Effect.as<RetryResult>({ started: true }))
        })

      /** The task in review that the user decides on, or the reason why the user cannot. */
      const inReview = (taskId: string): Effect.Effect<TaskRow, AppError> =>
        Effect.suspend(() => {
          const current = row(taskId)
          if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
          // The user decides on the computer that owns the task (spec 005, 019).
          if (current.origin !== null)
            return Effect.fail(
              new AppError({
                code: "task_elsewhere",
                detail: remote?.nameOf(current.origin) ?? "",
              }),
            )
          if (current.state !== "review")
            return Effect.fail(new AppError({ code: "task_not_in_review" }))
          return Effect.succeed(current)
        })

      /**
       * The user decided on a part: the check gives it no verdict (spec 004). The decision and the
       * text of a request for changes are kept for the moments of the task (spec 005).
       */
      const decided = (id: string, decision: "accepted" | "changes", text: string | null) =>
        db.run(
          "UPDATE task SET decided_at = ?, decision = ?, decision_text = ? WHERE id = ? AND decided_at IS NULL",
          Date.now(),
          decision,
          text,
          id,
        )

      const accept = (taskId: string) =>
        inReview(taskId).pipe(
          Effect.map((current) => {
            // The mark comes first, so the part is never done without it.
            decided(current.id, "accepted", null)
            return setState(current.id, current.agent_id, "done")
          }),
        )

      const requestChanges = (taskId: string, text: string) =>
        Effect.gen(function* () {
          const current = yield* inReview(taskId)
          const value = text.trim()
          if (!validChanges(value)) return yield* new AppError({ code: "invalid_input" })
          const handler = changesHandlers.get(current.source)
          if (!handler) return yield* new AppError({ code: "cannot_request_changes" })
          // The new part exists before the old one is done, so the request is never without an open part.
          yield* handler(toTask(current, remote), value)
          decided(current.id, "changes", value)
          setState(current.id, current.agent_id, "done")
        })

      const endRequest = (taskId: string): Effect.Effect<void, AppError> =>
        Effect.gen(function* () {
          const current = row(taskId)
          if (!current) return yield* new AppError({ code: "task_not_found" })
          if (current.origin !== null)
            return yield* new AppError({
              code: "task_elsewhere",
              detail: remote?.nameOf(current.origin) ?? "",
            })
          // The request starts at the first task: the parent of a part, up to the top.
          let top = current
          for (let up = top.parent_id ? row(top.parent_id) : undefined; up; ) {
            top = up
            up = top.parent_id ? row(top.parent_id) : undefined
          }
          // The parent goes first, so a parent that waits ends before it can start anything.
          for (const id of withDescendants(top.id)) {
            const found = row(id)
            if (!found || found.origin !== null || isFinal(found.state)) continue
            const signal = stops.get(id)
            if (live.has(id) && signal) yield* Deferred.succeed(signal, undefined)
            else setState(id, found.agent_id, "cancelled")
          }
        })

      const recordStep = (step: StepRecord) => {
        actionLog.add({
          agentId: step.agentId,
          kind: step.kind,
          access: step.access,
          target: step.target,
          decidedBy: step.decidedBy,
          result: step.result,
          taskId: step.taskId,
          outside: step.outside,
        })
      }

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

      /** The agent that gave the task as a part of its plan: the agent of the parent task. */
      const leadNameOf = (task: Task) =>
        task.parentId && task.source === "channel"
          ? (db.get<{ name: string }>(
              "SELECT a.name AS name FROM task p JOIN agent a ON a.id = p.agent_id WHERE p.id = ?",
              task.parentId,
            )?.name ?? null)
          : null

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

      /** The place of the work that an agent runs now, as the name that a row shows. */
      const placeOf = (agentId: string, exceptId: string): RecentPlace | null => {
        const running = db.get<{ source: TaskSource; source_id: string | null }>(
          `SELECT source, source_id FROM task
           WHERE agent_id = ? AND id != ? AND state IN ('running', 'waiting') AND origin IS NULL
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
          agentId,
          exceptId,
        )
        if (!running) {
          // Both computers are online and the other one runs a task of this agent (spec 019).
          const other = remote?.busyOn(agentId)
          return other ? { kind: "computer", name: other } : null
        }
        const name = (sql: string) =>
          running.source_id ? db.get<{ name: string }>(sql, running.source_id)?.name : undefined
        switch (running.source) {
          case "channel": {
            const found = name("SELECT name FROM channel WHERE id = ?")
            return found ? { kind: "channel", name: found } : null
          }
          case "routine": {
            const found = name("SELECT name FROM routine WHERE id = ?")
            return found ? { kind: "routine", name: found } : null
          }
          case "workflow": {
            const found = name(
              "SELECT w.name AS name FROM workflow_run r JOIN workflow w ON w.id = r.workflow_id WHERE r.id = ?",
            )
            return found ? { kind: "workflow", name: found } : null
          }
          case "chat":
            return { kind: "chat" }
          case "agent":
            return { kind: "agent" }
        }
      }

      const recent = (agentId: string): readonly RecentWorkRow[] => {
        const waiting = notifier.waitingRequests()
        return db
          .all<TaskRow>(
            `${SELECT} WHERE t.agent_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ${RECENT_WORK_MAX}`,
            agentId,
          )
          .map((r) => {
            const task = toTask(r, remote)
            // The agent runs one task at a time, so the request that waits is the one of this task.
            const request =
              task.state === "waiting" ? waiting.find((w) => w.agentId === agentId) : undefined
            return {
              task,
              wait: task.state === "waiting" ? (request?.kind ?? "user") : null,
              behind: task.state === "queued" && r.origin === null ? placeOf(agentId, r.id) : null,
              changedAt: lastChange(task),
            }
          })
      }

      return Tasks.of({
        create,
        run,
        recent,
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
        judge: (taskId, verdict, reason) => {
          const current = row(taskId)
          // Only the computer that owns a task judges it (spec 019).
          if (
            !current ||
            current.origin !== null ||
            current.state !== "done" ||
            current.done_test === null ||
            current.verdict !== null ||
            current.decided_at !== null
          )
            return false
          db.run(
            "UPDATE task SET verdict = ?, verdict_reason = ?, judged_at = ? WHERE id = ?",
            verdict,
            verdict === "not_met" ? reason : null,
            Date.now(),
            taskId,
          )
          changed(current.agent_id)
          if (current.source === "channel" && current.source_id)
            bus.emit("channels.changed", { channelId: current.source_id })
          return true
        },
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
        accept,
        requestChanges,
        endRequest,
        noteFor,
        depthOf,
        recordStep,
        steps,
        onRetry: (source, handler) => void retryHandlers.set(source, handler),
        onChanges: (source, handler) => void changesHandlers.set(source, handler),
        onEnd: (listener) => void endListeners.push(listener),
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
              leadName: leadNameOf(task),
            })
          }),
        children: (parentId) => childRows(parentId).map((r) => toTask(r, remote)),
      })
    }),
  )
}
