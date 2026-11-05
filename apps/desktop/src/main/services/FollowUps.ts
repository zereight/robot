import {
  cleanFollowUpReason,
  FOLLOW_UPS_PER_AGENT_MAX,
  FOLLOW_UPS_PER_LOOK_MAX,
  type FollowUp,
  type FollowUpAction,
  followUpAt,
  followUpDue,
  storedFollowUpAction,
  validFollowUpMinutes,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"

/**
 * What the follow-up service needs to start the turn of a follow-up. The chat service gives it,
 * after both exist, as the chat gives the tools their messenger (spec 005, "Follow-up").
 */
export interface FollowUpRunner {
  /**
   * Handles one due follow-up (spec 005). A steer that can join the running turn of that
   * conversation does that. Every other follow-up starts a new task with the source "follow-up".
   * The task fails to start when the queue of the agent is full.
   */
  start(followUp: FollowUp, now: number): Effect.Effect<void, AppError>
}

export interface FollowUpsService {
  /**
   * Records the follow-up of a "wait until" call (spec 005, "Follow-up"). It fails when the agent
   * holds 20 follow-ups already.
   */
  add(input: {
    readonly agentId: string
    readonly threadId: string | null
    readonly taskId: string
    readonly reason: string
    readonly minutes: number
    readonly action: FollowUpAction
  }): Effect.Effect<FollowUp, AppError>
  /** The follow-ups that wait, oldest first. With `taskId`, only those of that task. */
  list(agentId: string, taskId?: string): Effect.Effect<readonly FollowUp[]>
  /** The follow-ups that the details of one task show (spec 005). Oldest first. */
  ofTask(taskId: string): Effect.Effect<readonly FollowUp[]>
  /** The user deletes a follow-up: no task starts for it. */
  remove(id: string): Effect.Effect<void>
  /**
   * Looks at the clock: every follow-up whose time has come starts its task, oldest first. One
   * that is more than 12 hours late starts late, with the note. Tests call it with a fake clock.
   */
  check(now: number): Effect.Effect<void>
  /** The chat service gives the way to start a turn. Without it, `check` starts nothing. */
  setRunner(runner: FollowUpRunner): void
}

/** How often the loop looks at the clock. */
const TICK_MS = 1000

interface Row {
  id: string
  agent_id: string
  thread_id: string | null
  task_id: string
  reason: string
  action: string
  at: number
  created_at: number
}

const toFollowUp = (r: Row): FollowUp => ({
  id: r.id,
  agentId: r.agent_id,
  channelId: null,
  threadId: r.thread_id,
  taskId: r.task_id,
  reason: r.reason,
  action: storedFollowUpAction(r.action),
  at: r.at,
  createdAt: r.created_at,
})

export class FollowUps extends Context.Service<FollowUps, FollowUpsService>()(
  "robot/main/FollowUps",
) {
  static readonly layer = Layer.effect(
    FollowUps,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      /** The way to start a turn. The chat service sets it (spec 005, "Follow-up"). */
      let runner: FollowUpRunner | undefined
      /** The follow-ups whose task the app makes now, so that a tick does not make it twice. */
      const starting = new Set<string>()

      const row = (id: string) => db.get<Row>("SELECT * FROM follow_up WHERE id = ?", id)

      const changed = (agentId: string) => bus.emit("followups.changed", { agentId })

      /**
       * One follow-up whose time has come. The row goes before the turn starts, because the call
       * that made it already ended and a follow-up makes at most one task (spec 005). A follow-up
       * that is more than 12 hours late makes no task: the agent would look at a result that is
       * long gone, and the details of its task say so.
       */
      const reach = (f: FollowUp, now: number, due: "start" | "drop") =>
        Effect.gen(function* () {
          db.run("DELETE FROM follow_up WHERE id = ?", f.id)
          if (due === "start" && runner)
            yield* runner.start(f, now).pipe(
              // A full queue makes no task. The follow-up is gone, and the app makes no second
              // try, as a routine run that cannot start does not (spec 005, "Queue"; 009).
              Effect.catch(() => Effect.void),
            )
          changed(f.agentId)
        })

      const check = (now: number) =>
        Effect.gen(function* () {
          if (!runner) return
          const due = db
            .all<{ id: string }>("SELECT id FROM follow_up WHERE at <= ? ORDER BY at", now)
            .slice(0, FOLLOW_UPS_PER_LOOK_MAX)
          for (const { id } of due) {
            if (starting.has(id)) continue
            const current = row(id)
            if (!current) continue
            const f = toFollowUp(current)
            const state = followUpDue(f.at, now)
            if (state.kind === "none") continue
            starting.add(id)
            yield* reach(f, now, state.kind).pipe(
              Effect.ensuring(Effect.sync(() => starting.delete(id))),
            )
          }
        })

      // The loop ends with the layer: after that the database is closed, and a look at it fails.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(TICK_MS).pipe(
            Effect.andThen(
              Effect.suspend(() => check(Date.now()).pipe(Effect.catchCause(() => Effect.void))),
            ),
          ),
        ),
      )

      return FollowUps.of({
        add: (input) =>
          Effect.gen(function* () {
            // The reason is one line, as the tool makes it: the service is its own gate (spec 005).
            const reason = cleanFollowUpReason(input.reason)
            if (reason === null)
              return yield* new AppError({ code: "invalid_input", detail: "reason" })
            if (!validFollowUpMinutes(input.minutes))
              return yield* new AppError({ code: "invalid_input", detail: "minutes" })
            const held =
              db.get<{ n: number }>(
                "SELECT COUNT(*) AS n FROM follow_up WHERE agent_id = ?",
                input.agentId,
              )?.n ?? 0
            if (held >= FOLLOW_UPS_PER_AGENT_MAX)
              return yield* new AppError({
                code: "followups_full",
                detail: String(FOLLOW_UPS_PER_AGENT_MAX),
              })
            const now = Date.now()
            const id = crypto.randomUUID()
            db.run(
              `INSERT INTO follow_up (id, agent_id, thread_id, task_id, reason, action, at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              input.agentId,
              input.threadId,
              input.taskId,
              reason,
              input.action,
              followUpAt(now, input.minutes),
              now,
            )
            changed(input.agentId)
            const made = row(id)
            if (!made) return yield* new AppError({ code: "follow_up_failed" })
            return toFollowUp(made)
          }),
        list: (agentId, taskId) =>
          Effect.sync(() =>
            db
              .all<Row>(
                taskId
                  ? "SELECT * FROM follow_up WHERE agent_id = ? AND task_id = ? ORDER BY at"
                  : "SELECT * FROM follow_up WHERE agent_id = ? ORDER BY at",
                ...(taskId ? [agentId, taskId] : [agentId]),
              )
              .map(toFollowUp),
          ),
        ofTask: (taskId) =>
          Effect.sync(() =>
            db
              .all<Row>("SELECT * FROM follow_up WHERE task_id = ? ORDER BY at", taskId)
              .map(toFollowUp),
          ),
        remove: (id) =>
          Effect.sync(() => {
            const current = row(id)
            if (!current) return
            db.run("DELETE FROM follow_up WHERE id = ?", id)
            changed(current.agent_id)
          }),
        check,
        setRunner: (next) => {
          runner = next
        },
      })
    }),
  )
}
