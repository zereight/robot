import { randomUUID } from "node:crypto"
import {
  type ActionCheck,
  type ActionDecider,
  type AgentMessageKind,
  addSpent as addToUsage,
  blockedErrorOf,
  isActive,
  isDecision,
  isEndedAs,
  isFinal,
  isRuntimeKind,
  isTaskProgress,
  isTeamsJobKind,
  isVerdict,
  joinWords,
  type LoggedStep,
  lastChange,
  limitState,
  messageText,
  type OutsideSource,
  queueRank,
  RECENT_WORK_MAX,
  type RecentPlace,
  type RecentWorkRow,
  type RetryNote,
  type RetryResult,
  type RuleRef,
  raiseProgress,
  remoteRetryNote,
  retryNote,
  retryNoteForModel,
  type SensitiveLabel,
  type SpentUsage,
  TASKS_QUEUED_MAX,
  type Task,
  type TaskDetail,
  type TaskProgress,
  type TaskSource,
  type TaskState,
  type TaskUsage,
  type TeamsJobKind,
  type TreeUsage,
  type TurnEnd,
  taskLabel,
  tokensOf,
  treeUsage,
  type Verdict,
  validChanges,
  withDescendantsOf,
} from "@robot/shared"
import { Cause, Context, Deferred, Effect, Exit, Layer } from "effect"
import { resumeOf } from "../providers/resume.ts"
import { ActionLog } from "./ActionLog.ts"
import { Activity } from "./Activity.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Notifier } from "./Notifier.ts"
import { SettingsStore } from "./Settings.ts"

interface TaskRow {
  id: string
  agent_id: string
  agent_name: string
  thread_id: string | null
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
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  cost_micros: number | null
  token_limit: number | null
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
  /**
   * How a channel job began, when a message from Teams began it (spec 028). Without it, a part and
   * a retry keep the kind of the task that made them, and any other task has none.
   */
  readonly teamsJob?: TeamsJobKind | null
  /**
   * Whether a task of the source "agent" is a send (the tool "send message") or the reply that
   * comes back to the sender (spec 029). Without it the task has no mark: a retry of a task is no
   * new send.
   */
  readonly agentMessage?: AgentMessageKind
  /**
   * The task is made as Failed with this error and never runs: a part of a channel job over the
   * limit of queued tasks (spec 005, "Queue").
   */
  readonly failed?: { readonly code: string; readonly detail: string }
  /**
   * The task is made, and then ends at once as Blocked with this reason and never runs: the daily
   * token limit of its channel, or of a higher channel, is used (spec 005, "Blocked"; spec 030).
   * The end makes the same notice and the same record as any other blocked task.
   */
  readonly blocked?: { readonly code: string; readonly detail: string }
}

/** One step of a task for the action log (spec 007). */
export interface StepRecord extends Omit<LoggedStep, "at"> {
  readonly agentId: string
  readonly taskId: string
  /** Who decided that the step ran or did not run. */
  readonly decidedBy: ActionDecider
  /** The rule that decided the step, or that could not be read (spec 007). */
  readonly rule?: RuleRef | null
  /** The check of "Ask when unsure", when the step went to the check (spec 007). */
  readonly check?: ActionCheck | null
  /** The first source of outside content of the turn, or null. */
  readonly outside: OutsideSource | null
  /** The label of the first credential place that the turn read, or null (spec 007). */
  readonly sensitive: SensitiveLabel | null
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
   * Runs `work` for a task. An agent runs one task at a time, and at most "Agents working at once"
   * tasks run (spec 005, "Queue"). Others wait, in the order of the queue. The task is running
   * while `work` runs, then done, failed or cancelled by how `work` ends.
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
      /**
       * Asked when the task has its place and is about to start its turn. When it gives a reason,
       * the task ends at once as Blocked with that error and the turn never runs: the daily token
       * limit of a channel (spec 005, "Blocked"; spec 030). A task that goes on after a restart is
       * not asked.
       */
      readonly gate?: () => { readonly code: string; readonly detail: string } | null
    },
  ): Effect.Effect<A, E, R>
  /**
   * The tasks that waited for an approval or a question when the app closed and wait on (spec
   * 005). The chat starts their turns again. `run` with `resumed` keeps the place of the agent.
   */
  waitingAfterRestart(): readonly Task[]
  /**
   * Marks a running task as waiting for the user, or running again. A task that waits uses no
   * slot (spec 005, "Queue"). When it goes on, it needs a slot again: the promise resolves when it
   * has one, or at once when the task ends.
   */
  setWaiting(taskId: string, waiting: boolean): Promise<void>
  /**
   * Runs `work` while a task waits for the tasks that it gave out (spec 005, "Queue"). The task
   * uses no slot, and its agent stays held. After `work`, the task takes a slot again, at the
   * front of the order.
   */
  withoutSlot<A, E, R>(taskId: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
  /**
   * "Run next" (spec 005): the queued task goes to the front of the order, before the tasks of
   * earlier picks. Only for a queued task of this computer.
   */
  runNext(taskId: string): Effect.Effect<void, AppError>
  /**
   * The reason why the queue of the agent takes no new task: it holds 20 queued tasks (spec 005,
   * "Queue"). Null when it has space.
   */
  queueFull(agentId: string): AppError | null
  /** What a queued task of this computer waits behind (spec 005). Null for any other task. */
  behindOf(taskId: string): RecentPlace | null
  /** Calls `listener` with the agent when a queued task of that agent starts or ends. */
  onQueueSpace(listener: (agentId: string) => void): void
  /**
   * Records how far the turn of a task went (spec 005). The progress only goes up: a lower value,
   * or the same one, changes nothing.
   */
  setProgress(taskId: string, progress: TaskProgress): void
  /** Records which message holds the reply of a task. */
  setMessage(taskId: string, messageId: string): void
  /**
   * Adds what a turn used to the usage of a task (spec 005, "Usage of a task"). A field that is
   * absent was not reported and stays as it is. When the run of a routine reaches its token limit,
   * the run is stopped as a Stop of the user does, and it fails with the reason (spec 009).
   */
  addSpent(taskId: string, spent: SpentUsage): void
  /** The usage of a task and every task below it, with one line for each agent. */
  treeUsage(taskId: string): TreeUsage
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
  /**
   * The note that the agent of a new try reads before its prompt, or "" when the task is no retry,
   * or the earlier try ran no step that may have changed things (spec 005, "Retry note").
   */
  retryNoteForModel(task: Pick<Task, "retryOf">): string
  /** The depth of a task in a chain of messages between agents. 0 for an unknown task. */
  depthOf(taskId: string): number
  /**
   * The words of the user for the turn of a task (spec 007, "Ask when unsure"), or null when the
   * task has none. A chat message of the user, the text typed in the dialog of a handover, the
   * prompt of a routine that the user saved, and the job message of a part of a channel job count.
   * A message of another agent, of an outside program, of Teams, a step of a workflow and the
   * handover card do not. The text of a request for changes counts for the new part (`noteRequest`).
   */
  userWords(taskId: string): string | null
  /**
   * Records the text that the user typed to ask a member for changes (or to reply to a part): it
   * counts as words of the user for the new part and for a retry of it (spec 007). It stays in
   * memory: after a restart the part has no such words, and a checked step asks.
   */
  noteRequest(taskId: string, text: string): void
  /**
   * Runs work that holds the agent as a task does, with no task: a manual compact (spec 003). No
   * task of the agent starts until it ends.
   */
  holdAgent<A, E, R>(agentId: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
  /** Adds a step of a task to the action log (spec 007). */
  recordStep(step: StepRecord): void
  /** The logged steps of a task, oldest first. */
  steps(taskId: string): readonly LoggedStep[]
  onRetry(source: TaskSource, handler: RetryHandler): void
  /** Sets how a source starts the new part of "Request changes". */
  onChanges(source: TaskSource, handler: ChangesHandler): void
  /** Calls `listener` when a task ends as done, failed, blocked or cancelled. */
  onEnd(listener: (task: Task) => void): void
  /**
   * Like `onEnd`, and the listener returns true when it told the user about this end by itself.
   * The task then makes no failure notice of its own, so the user gets one notice and not two
   * (spec 009, "Repeated failure").
   */
  onEndTold(listener: (task: Task) => boolean): void
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

const SELECT = `SELECT t.*, a.name AS agent_name,
  (SELECT m.thread_id FROM message m WHERE m.id = t.message_id) AS thread_id
  FROM task t JOIN agent a ON a.id = t.agent_id`

const usageOf = (row: TaskRow): TaskUsage => ({
  input: row.input_tokens,
  output: row.output_tokens,
  cached: row.cached_tokens,
  costMicros: row.cost_micros,
})

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
  ...(row.thread_id ? { threadId: row.thread_id } : {}),
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
  usage: usageOf(row),
  tokenLimit: row.token_limit,
})

/** How often a task that waits for the other computer looks again. */
const REMOTE_POLL_MS = 300

/**
 * One piece of work that waits for its agent and, for a task, for a slot (spec 005, "Queue").
 * `id` is the id of the task, or of a hold of `holdAgent`.
 */
interface Waiter {
  readonly id: string
  readonly agentId: string
  readonly source: TaskSource | null
  /** A task that holds its agent already and needs a slot again: it goes first. */
  readonly back: boolean
  /** False for a hold of `holdAgent`: it needs the agent only. */
  readonly slot: boolean
  readonly order: number
  readonly grant: () => void
  /** Called when the waiter leaves without a grant, because its task ended. */
  readonly drop?: () => void
}

export class Tasks extends Context.Service<Tasks, TasksService>()("robot/main/Tasks") {
  static readonly layer = Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const actionLog = yield* ActionLog
      const notifier = yield* Notifier
      const activity = yield* Activity
      const settings = yield* SettingsStore
      const stops = new Map<string, Deferred.Deferred<void>>()
      const live = new Set<string>()
      const retryHandlers = new Map<TaskSource, RetryHandler>()
      const changesHandlers = new Map<TaskSource, ChangesHandler>()
      const endListeners: ((task: Task) => unknown)[] = []
      const spaceListeners: ((agentId: string) => void)[] = []
      let remote: RemoteTasks | undefined

      // --- The queue (spec 005, "Queue") ---------------------------------------------------------
      // Each agent runs one task at a time, and at most `limit` tasks run at the same time. A task
      // that waits for the user or for its children holds its agent but uses no slot.
      let limit = (yield* settings.get).agentsAtOnce
      const waiters: Waiter[] = []
      /** The task or hold that has each agent now. */
      const holders = new Map<string, string>()
      /** The tasks that use a slot now. */
      const slotted = new Set<string>()
      /** The picks of "Run next", by task: a later pick has a higher number. */
      const picks = new Map<string, number>()
      /** The order in which the tasks were made, for "the oldest first". */
      const made = new Map<string, number>()
      /** Tasks that were told to stop: they never take a slot again. */
      const stopping = new Set<string>()
      /**
       * The runs of a routine that reached their token limit, with the limit. The first task of such
       * a run fails with the reason when it stops, and does not end as cancelled (spec 009).
       */
      const limitHits = new Map<string, number>()
      /** The agents of tasks that wait for a slot only, to tell the window when that changes. */
      let slotBound = new Set<string>()
      let counter = 0
      let remoteTimer: ReturnType<typeof setTimeout> | undefined

      const rankOf = (w: Waiter) =>
        w.back || !w.slot ? 0 : queueRank(w.source ?? "chat", picks.has(w.id))
      const compare = (a: Waiter, b: Waiter) => {
        const rank = rankOf(a) - rankOf(b)
        if (rank !== 0) return rank
        // The latest pick of "Run next" goes first; else the oldest first.
        if (rankOf(a) === 1) return (picks.get(b.id) ?? 0) - (picks.get(a.id) ?? 0)
        return (made.get(a.id) ?? a.order) - (made.get(b.id) ?? b.order)
      }

      /** Starts every waiter that can start now, in the order of the queue. */
      const pump = () => {
        let remoteWait = false
        const bound = new Set<string>()
        for (const w of [...waiters].sort(compare)) {
          const holder = holders.get(w.agentId)
          if (holder !== undefined && holder !== w.id) continue
          // One task per agent across both computers (spec 019): while the other computer runs a
          // task of this agent, this one stays queued.
          if (!w.back && w.slot && remote?.busyOn(w.agentId)) {
            remoteWait = true
            continue
          }
          if (w.slot && slotted.size >= limit) {
            bound.add(w.agentId)
            continue
          }
          waiters.splice(waiters.indexOf(w), 1)
          holders.set(w.agentId, w.id)
          if (w.slot) slotted.add(w.id)
          w.grant()
        }
        if (remoteWait && remoteTimer === undefined)
          remoteTimer = setTimeout(() => {
            remoteTimer = undefined
            pump()
          }, REMOTE_POLL_MS)
        // The line "Waits for a free slot" comes and goes with the slots.
        for (const agentId of new Set([...bound, ...slotBound]))
          if (bound.has(agentId) !== slotBound.has(agentId)) changed(agentId)
        slotBound = bound
      }

      /** Waits in the queue until the waiter starts. Leaves the queue when interrupted. */
      const enter = (w: Omit<Waiter, "grant" | "order">): Effect.Effect<void> =>
        Effect.callback<void>((resume) => {
          const waiter: Waiter = { ...w, order: ++counter, grant: () => resume(Effect.void) }
          waiters.push(waiter)
          pump()
          return Effect.sync(() => {
            const at = waiters.indexOf(waiter)
            if (at >= 0) waiters.splice(at, 1)
            pump()
          })
        })

      /** Frees the slot of a task. Its agent stays held. */
      const freeSlot = (id: string) => {
        if (slotted.delete(id)) pump()
      }

      /** Frees the slot and the agent of a task or a hold, and drops what it still waits for. */
      const leave = (id: string, agentId: string) => {
        slotted.delete(id)
        if (holders.get(agentId) === id) holders.delete(agentId)
        picks.delete(id)
        made.delete(id)
        stopping.delete(id)
        for (const w of waiters.filter((x) => x.id === id)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.drop?.()
        }
        pump()
      }

      /**
       * A task that holds its agent and no slot needs a slot again (spec 005): it waits as queued
       * at the front of the order. Resolves when it has one, or when the task ends.
       */
      const backToSlot = (id: string, agentId: string): Promise<void> =>
        new Promise<void>((resolve) => {
          if (slotted.has(id) || holders.get(agentId) !== id || stopping.has(id)) return resolve()
          waiters.push({
            id,
            agentId,
            source: null,
            back: true,
            slot: true,
            order: ++counter,
            grant: () => {
              setRunState(id, "running")
              resolve()
            },
            drop: resolve,
          })
          pump()
          if (!slotted.has(id)) setRunState(id, "queued")
        })

      /** Sets the state of a task that has started and not ended. */
      const setRunState = (id: string, state: "running" | "queued" | "waiting") => {
        const current = row(id)
        if (
          current &&
          current.state !== state &&
          (current.state === "running" || current.state === "waiting" || current.state === "queued")
        )
          setState(id, current.agent_id, state)
      }

      // A new number applies at once to the tasks that wait (spec 005, 013).
      bus.tap((event, payload) => {
        if (event !== "settings.changed") return
        const next = (payload as { agentsAtOnce?: number }).agentsAtOnce
        if (typeof next === "number" && next !== limit) {
          limit = next
          pump()
        }
      })

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
             AND t.source IN ('chat', 'teams', 'routine') AND a.archived_at IS NULL
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
        // A queued task that starts or ends makes space in the queue of its agent.
        if (state !== "queued")
          for (const listener of spaceListeners) {
            try {
              listener(agentId)
            } catch (e) {
              console.error("queue space listener failed", e)
            }
          }
        // A listener that told the user about this end by itself takes the failure notice.
        let told = false
        if (isFinal(state)) {
          const ended = endListeners.length > 0 ? row(id) : undefined
          // A listener never stops the end of a task.
          if (ended)
            for (const listener of endListeners) {
              try {
                if (listener(toTask(ended, remote)) === true) told = true
              } catch (e) {
                console.error("task end listener failed", e)
              }
            }
        }
        if (state === "review") reviewNotice(id, agentId)
        // A blocked task is a failed one for the notice (spec 005, 015).
        if (
          !told &&
          (state === "blocked" || (state === "failed" && error?.code !== "app_stopped"))
        ) {
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

      /** The text of a request for changes, by the part that it made (spec 007, "Ask when unsure"). */
      const requests = new Map<string, string>()
      const noteRequest = (taskId: string, text: string) => {
        if (requests.size >= 1000) requests.clear()
        requests.set(taskId, text)
      }

      /** The prompt of a routine, when it counts as words of the user. */
      const routineWords = (routineId: string | null, prompt: string) => {
        if (!routineId) return null
        const row = db.get<{ unsaved_import: number }>(
          "SELECT unsaved_import FROM routine WHERE id = ?",
          routineId,
        )
        // A routine that an agent file made counts after the user saved it once (spec 007, 009).
        return row && row.unsaved_import === 0 ? prompt : null
      }

      const userWords = (taskId: string): string | null => {
        const row = db.get<{
          source: string
          source_id: string | null
          prompt: string
          parent_id: string | null
          retry_of: string | null
        }>("SELECT source, source_id, prompt, parent_id, retry_of FROM task WHERE id = ?", taskId)
        if (!row) return null
        switch (row.source) {
          case "chat":
          case "handover":
            return row.prompt === "(no text)" ? null : row.prompt
          case "routine":
            return routineWords(row.source_id, row.prompt)
          case "channel": {
            // A job message, or a message that a member answers: the text of the task is what the
            // user wrote. A part has the job message (the task above it) and the text of a request
            // for changes. The text of a part is what the lead wrote: it is not words of the user.
            if (!row.parent_id) return joinWords([row.prompt])
            const job = db.get<{ prompt: string; parent_id: string | null }>(
              "SELECT prompt, parent_id FROM task WHERE id = ?",
              row.parent_id,
            )
            if (!job || job.parent_id) return null
            // A retry of a part that "Request changes" made has the same request.
            const asked =
              requests.get(taskId) ?? (row.retry_of ? requests.get(row.retry_of) : undefined)
            return joinWords([job.prompt, asked])
          }
          default:
            return null
        }
      }

      /** How the job of a task began, when a message from Teams began it (spec 028). */
      const teamsJobOf = (taskId: string | null | undefined): TeamsJobKind | null => {
        if (!taskId) return null
        const kind = db.get<{ teams_job: string | null }>(
          "SELECT teams_job FROM task WHERE id = ?",
          taskId,
        )?.teams_job
        return isTeamsJobKind(kind) ? kind : null
      }

      const create = (input: TaskInput) =>
        Effect.sync(() => {
          const id = randomUUID()
          const now = Date.now()
          const depth = input.depth ?? depthOf(input.parentId ?? input.retryOf)
          const failed = input.failed
          // A job from Teams stays a job from Teams in its parts, retries and nudges (spec 028).
          const teamsJob =
            input.teamsJob === undefined
              ? teamsJobOf(input.parentId ?? input.retryOf)
              : input.teamsJob
          // The first task of a run of a routine keeps the token limit that the run starts with
          // (spec 009). A later edit of the routine does not change a run that went.
          const tokenLimit =
            input.source === "routine" && input.sourceId && !input.parentId
              ? (db.get<{ token_limit: number | null }>(
                  "SELECT token_limit FROM routine WHERE id = ?",
                  input.sourceId,
                )?.token_limit ?? null)
              : null
          db.run(
            `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, retry_of,
               message_id, state, created_at, asked_at, depth, progress, done_test, error_code,
               error_detail, finished_at, teams_job, agent_message, token_limit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_sent', ?, ?, ?, ?, ?, ?, ?)`,
            id,
            input.agentId,
            input.prompt,
            input.label ? taskLabel(input.label) : taskLabel(input.prompt),
            input.source,
            input.sourceId,
            input.parentId ?? null,
            input.retryOf ?? null,
            input.messageId ?? null,
            failed ? "failed" : "queued",
            now,
            input.askedAt == null ? null : Math.min(input.askedAt, now),
            depth,
            input.doneTest ?? null,
            failed?.code ?? null,
            failed?.detail ?? null,
            failed ? now : null,
            teamsJob,
            input.source === "agent" ? (input.agentMessage ?? null) : null,
            tokenLimit,
          )
          if (!failed && !input.blocked) {
            stops.set(id, Deferred.makeUnsafe<void>())
            made.set(id, ++counter)
          }
          changed(input.agentId)
          if (input.source === "channel" && input.sourceId)
            bus.emit("channels.changed", { channelId: input.sourceId })
          // A task that the daily limit of its channel stops ends here, with no turn. Its end
          // goes through the same code as any end, so the notice and the listeners run.
          if (input.blocked) setState(id, input.agentId, "blocked", input.blocked)
          return toTask(row(id) as TaskRow, remote)
        })

      /**
       * A task that was stopped ends as cancelled. The first task of a run that reached its token
       * limit fails with the reason instead (spec 009): the run counts as a failed run.
       */
      const endStopped = (taskId: string, agentId: string) => {
        const limit = limitHits.get(taskId)
        limitHits.delete(taskId)
        return limit === undefined
          ? setState(taskId, agentId, "cancelled")
          : setState(taskId, agentId, "failed", { code: "token_limit", detail: String(limit) })
      }

      const run = <A, E, R>(
        taskId: string,
        agentId: string,
        work: Effect.Effect<A, E, R>,
        options?: {
          readonly resumed?: boolean
          readonly finish?: (value: A) => TurnEnd
          readonly gate?: () => { readonly code: string; readonly detail: string } | null
        },
      ) => {
        const stopSignal = stops.get(taskId) ?? Deferred.makeUnsafe<void>()
        stops.set(taskId, stopSignal)
        live.add(taskId)
        const serverId = db.get<{ server_id: string }>(
          "SELECT server_id FROM agent WHERE id = ?",
          agentId,
        )?.server_id
        const source = row(taskId)?.source ?? "chat"
        let gated: { readonly code: string; readonly detail: string } | null = null
        const guarded = Effect.gen(function* () {
          // A task that waited through a restart goes on waiting until its card is answered. It
          // holds its agent and uses no slot until then (spec 005).
          yield* enter({
            id: taskId,
            agentId,
            source,
            back: false,
            slot: !options?.resumed,
          })
          // The daily token limit of the channel (spec 030): a task that would start now ends as
          // Blocked, with no turn. The state never goes to running.
          if (!options?.resumed && options?.gate) {
            const stop = options.gate()
            if (stop) {
              gated = stop
              return yield* Effect.interrupt
            }
          }
          if (!options?.resumed) setState(taskId, agentId, "running")
          if (serverId) activity.setWorking(agentId, serverId, true)
          return yield* work.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (serverId) activity.setWorking(agentId, serverId, false)
              }),
            ),
          )
        })
        const stopped = Deferred.await(stopSignal).pipe(Effect.flatMap(() => Effect.interrupt))
        return Effect.raceFirst(guarded, stopped).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              live.delete(taskId)
              stops.delete(taskId)
              leave(taskId, agentId)
              if (gated) return setState(taskId, agentId, "blocked", gated)
              if (Exit.isSuccess(exit)) {
                let end: TurnEnd = { state: "done" }
                // A reading that fails never stops the end of a task.
                try {
                  if (options?.finish) end = options.finish(exit.value)
                } catch (e) {
                  console.error("task finish failed", e)
                }
                if (end.state === "blocked")
                  return setState(taskId, agentId, "blocked", blockedErrorOf(end))
                return setState(taskId, agentId, end.state)
              }
              if (Cause.hasInterruptsOnly(exit.cause)) return endStopped(taskId, agentId)
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
            if (live.has(taskId) && signal) {
              // Stop frees the slot at once (spec 005). The agent stays held until the turn ends.
              stopping.add(taskId)
              freeSlot(taskId)
              yield* Deferred.succeed(signal, undefined)
            } else endStopped(taskId, current.agent_id)
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
            if (live.has(id) && signal) {
              stopping.add(id)
              freeSlot(id)
              yield* Deferred.succeed(signal, undefined)
            } else setState(id, found.agent_id, "cancelled")
          }
        })

      const recordStep = (step: StepRecord) => {
        actionLog.add({
          agentId: step.agentId,
          kind: step.kind,
          access: step.access,
          target: step.target,
          decidedBy: step.decidedBy,
          ...(step.rule ? { rule: step.rule } : {}),
          ...(step.check ? { check: step.check } : {}),
          result: step.result,
          taskId: step.taskId,
          outside: step.outside,
          sensitive: step.sensitive,
        })
      }

      /** The first task of the run that this task belongs to: the task itself, or the top parent. */
      const rootOf = (id: string): TaskRow | undefined => {
        let top = row(id)
        for (let up = top?.parent_id ? row(top.parent_id) : undefined; up; ) {
          top = up
          up = top.parent_id ? row(top.parent_id) : undefined
        }
        return top
      }

      /** The task and the tasks below it, with the name of the agent of each (spec 005). */
      const treeOf = (rootId: string): TreeUsage => {
        const ids = withDescendants(rootId)
        const rows = ids.flatMap((id) => {
          const found = row(id)
          return found ? [found] : []
        })
        return treeUsage(
          rows.map((r) => ({ agentId: r.agent_id, agentName: r.agent_name, usage: usageOf(r) })),
        )
      }

      const addSpent = (taskId: string, spent: SpentUsage) => {
        const current = row(taskId)
        // The computer that runs a task counts it. The other computer gets the numbers by sync.
        if (!current || current.origin !== null) return
        const before = usageOf(current)
        const next = addToUsage(before, spent)
        if (
          next.input === before.input &&
          next.output === before.output &&
          next.cached === before.cached &&
          next.costMicros === before.costMicros
        )
          return
        db.run(
          `UPDATE task SET input_tokens = ?, output_tokens = ?, cached_tokens = ?, cost_micros = ?
           WHERE id = ?`,
          next.input,
          next.output,
          next.cached,
          next.costMicros,
          taskId,
        )
        changed(current.agent_id)
        if (current.source === "channel" && current.source_id)
          bus.emit("channels.changed", { channelId: current.source_id })
        // The token limit of a run (spec 009): cached input counts as input, so the tokens of a
        // tree are input plus output. A run that reaches the limit is stopped as a Stop of the
        // user stops it. It stops once.
        const root = rootOf(taskId)
        if (!root || root.token_limit === null || limitHits.has(root.id) || isFinal(root.state))
          return
        const used = tokensOf(treeOf(root.id).total)
        if (limitState(used, root.token_limit) !== "over") return
        limitHits.set(root.id, root.token_limit)
        Effect.runSync(stop(root.id))
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

      /**
       * What a queued task waits behind, as the name that a row shows: the work that its agent
       * runs now and its place, or a free slot (spec 005, "Tasks page").
       */
      const placeOf = (queued: TaskRow): RecentPlace | null => {
        const agentId = queued.agent_id
        const running = db.get<{
          source: TaskSource
          source_id: string | null
          thread_id: string | null
        }>(
          `SELECT t.source, t.source_id,
             (SELECT m.thread_id FROM message m WHERE m.id = t.message_id) AS thread_id
           FROM task t
           WHERE t.agent_id = ? AND t.id != ? AND t.state IN ('running', 'waiting')
             AND t.origin IS NULL
           ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1`,
          agentId,
          queued.id,
        )
        if (!running) {
          // Both computers are online and the other one runs a task of this agent (spec 019).
          const other = remote?.busyOn(agentId)
          if (other) return { kind: "computer", name: other }
          // The agent is free, and all slots are in use.
          const waits = waiters.some((w) => w.id === queued.id)
          return waits && !holders.has(agentId) && slotted.size >= limit
            ? { kind: "slot", count: limit }
            : null
        }
        // The agent works in another thread of its chat (spec 003). A handover is a message in a
        // thread, so it counts as a chat here (spec 005).
        const inChat = (source: TaskSource) =>
          source === "chat" || source === "handover" || source === "teams"
        if (
          inChat(running.source) &&
          inChat(queued.source) &&
          running.thread_id !== queued.thread_id
        )
          return { kind: "thread" }
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
          case "handover":
          case "teams":
            return { kind: "chat" }
          case "agent":
            return { kind: "agent" }
        }
      }

      /** A task with what it waits behind, when it is queued on this computer. */
      const withBehind = (r: TaskRow): Task => {
        const task = toTask(r, remote)
        return r.state === "queued" && r.origin === null ? { ...task, behind: placeOf(r) } : task
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
              behind: task.state === "queued" && r.origin === null ? placeOf(r) : null,
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
          if (!current) return Promise.resolve()
          if (waiting) {
            // A task that waits for the user uses no slot (spec 005). Its agent stays held.
            if (current.state === "running" || current.state === "waiting")
              setState(taskId, current.agent_id, "waiting")
            freeSlot(taskId)
            return Promise.resolve()
          }
          if (live.has(taskId) && !slotted.has(taskId) && !stopping.has(taskId))
            return backToSlot(taskId, current.agent_id)
          if (current.state === "waiting") setState(taskId, current.agent_id, "running")
          return Promise.resolve()
        },
        withoutSlot: (taskId, work) =>
          Effect.suspend(() => {
            const agentId = row(taskId)?.agent_id
            if (!agentId || !slotted.has(taskId)) return work
            freeSlot(taskId)
            // A stop ends the wait: the task never takes a slot again.
            return work.pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.promise(() => backToSlot(taskId, agentId))
                  : Effect.void,
              ),
            )
          }),
        runNext: (taskId) =>
          Effect.suspend(() => {
            const current = row(taskId)
            if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
            // A pick does not sync: only the computer that made the task has it (spec 005, 019).
            if (current.origin !== null)
              return Effect.fail(
                new AppError({
                  code: "task_elsewhere",
                  detail: remote?.nameOf(current.origin) ?? "",
                }),
              )
            if (current.state !== "queued" || current.started_at !== null)
              return Effect.fail(new AppError({ code: "task_not_queued" }))
            picks.set(taskId, ++counter)
            changed(current.agent_id)
            pump()
            return Effect.void
          }),
        behindOf: (taskId) => {
          const r = row(taskId)
          return r && r.state === "queued" && r.origin === null ? placeOf(r) : null
        },
        queueFull: (agentId) => {
          const count =
            db.get<{ n: number }>(
              `SELECT COUNT(*) AS n FROM task
               WHERE agent_id = ? AND state = 'queued' AND origin IS NULL AND started_at IS NULL`,
              agentId,
            )?.n ?? 0
          if (count < TASKS_QUEUED_MAX) return null
          const name = db.get<{ name: string }>(
            "SELECT name FROM agent WHERE id = ?",
            agentId,
          )?.name
          return new AppError({ code: "tasks_full", detail: name ?? "" })
        },
        onQueueSpace: (listener) => void spaceListeners.push(listener),
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
        addSpent,
        treeUsage: treeOf,
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
        retryNoteForModel: (task) => {
          if (!task.retryOf) return ""
          const note = noteFor(task.retryOf)
          return note ? retryNoteForModel(note) : ""
        },
        accept,
        requestChanges,
        endRequest,
        noteFor,
        depthOf,
        userWords,
        noteRequest,
        holdAgent: (agentId, work) =>
          Effect.suspend(() => {
            const id = `hold:${randomUUID()}`
            return enter({ id, agentId, source: null, back: false, slot: false }).pipe(
              Effect.andThen(work),
              Effect.ensuring(Effect.sync(() => leave(id, agentId))),
            )
          }),
        recordStep,
        steps,
        onRetry: (source, handler) => void retryHandlers.set(source, handler),
        onChanges: (source, handler) => void changesHandlers.set(source, handler),
        onEnd: (listener) => void endListeners.push(listener),
        onEndTold: (listener) => void endListeners.push(listener),
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<TaskRow>(
                `${SELECT} WHERE a.server_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ${LIST_MAX}`,
                serverId,
              )
              .map(withBehind),
          ),
        get: (taskId) =>
          Effect.suspend(() => {
            const current = row(taskId)
            if (!current) return Effect.fail(new AppError({ code: "task_not_found" }))
            const task = withBehind(current)
            const children: Task[] = []
            const visit = (parentId: string) => {
              for (const child of childRows(parentId)) {
                children.push(toTask(child, remote))
                visit(child.id)
              }
            }
            visit(taskId)
            // A task with child tasks shows the total of its tree (spec 005, "Usage of a task").
            const tree =
              children.length > 0
                ? treeUsage(
                    withDescendantsOf([task, ...children], task.id).map((t) => ({
                      agentId: t.agentId,
                      agentName: t.agentName,
                      usage: t.usage,
                    })),
                  )
                : null
            return Effect.succeed({
              task,
              children,
              result: resultOf(task),
              joined: joinedOf(task),
              leadName: leadNameOf(task),
              tree,
            })
          }),
        children: (parentId) => childRows(parentId).map((r) => toTask(r, remote)),
      })
    }),
  )
}
