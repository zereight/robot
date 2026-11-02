import {
  type AccountFacts,
  type CardFacts,
  type DoneFacts,
  dayBounds,
  dayKey,
  doneRows,
  isRuntimeKind,
  localZone,
  needsRows,
  nextRows,
  type PartFacts,
  type RoutineFacts,
  type RpcEvent,
  type RunFacts,
  runTimes,
  type Schedule,
  type TaskFacts,
  type TaskSource,
  TODAY_AHEAD_MS,
  type TodayGroupId,
  type TodayReason,
  type TodayRow,
  type TodaySnapshot,
  type TodayWhere,
  todaySnapshot,
  type WorkflowFacts,
  wrongRows,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { Notifier } from "./Notifier.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"

export interface TodayService {
  /**
   * The Today page of this computer at `now` (spec 021). It reads local data only. It starts no
   * turn of an agent and sends nothing off the computer.
   */
  snapshot(now?: number): Effect.Effect<TodaySnapshot>
  /**
   * Looks at the page again as the clock passes. It pushes the page when it changed, as the loop
   * does. Tests call it by hand with a fake clock.
   */
  check(now: number): Effect.Effect<void>
}

/** The events that can change a row. The page is pushed within a short wait after one of them. */
const SOURCES = new Set<RpcEvent>([
  "island.state",
  "tasks.changed",
  "routines.changed",
  "workflows.changed",
  "workflows.run",
  "providers.changed",
  "agents.changed",
  "channels.changed",
  "channel.message",
  "chat.message",
  "chat.removed",
  "sync.changed",
])

/** How often the loop looks for a change that came from an event. */
const STEP_MS = 100
/** How often the loop looks at the clock: the day, the zone, and times that rows wait for. */
const CLOCK_MS = 1000
/** The page is looked at again at least this often, for runs that come into the next 24 hours. */
const REFRESH_MS = 60_000
/** A group never reads more rows than this, so a very long history cannot slow the page. */
const READ_MAX = 2000
/** Final runs of a routine that the count of failed runs in a row looks back at. */
const STREAK_LOOK = 100

type Reasoned = { error_code: string | null; error_detail: string | null }
const reasonOf = (row: Reasoned): TodayReason | null =>
  row.error_code ? { code: row.error_code, detail: row.error_detail ?? "" } : null

/** Reads the rows of the Today page from the local data and the waiting requests. */
export class Today extends Context.Service<Today, TodayService>()("robot/main/Today") {
  static readonly layer = Layer.effect(
    Today,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const notifier = yield* Notifier
      const secrets = yield* Secrets

      // ------------------------------------------------------------------ Needs you
      const cards = (): CardFacts[] =>
        notifier.waitingRequests().map((w) => ({
          agentId: w.agentId,
          callId: w.callId,
          kind: w.kind,
          text: w.summary,
          channel: w.place,
          target: w.target,
          askedAt: w.askedAt,
          computer: w.from,
        }))

      // A failed part of a channel job that was not tried again and whose request was not ended,
      // and a part that waits for the review of the user (spec 004, 005).
      const parts = (): PartFacts[] =>
        db
          .all<
            Reasoned & {
              id: string
              agent_id: string
              label: string
              state: "failed" | "blocked" | "review"
              at: number
              channel_id: string
              channel_name: string
              message_id: string | null
            }
          >(
            `SELECT t.id, t.agent_id, t.label, t.state, t.error_code, t.error_detail,
                    COALESCE(t.finished_at, t.created_at) AS at,
                    t.source_id AS channel_id, c.name AS channel_name,
                    (SELECT cm.id FROM channel_message cm WHERE cm.task_id = t.id
                     ORDER BY cm.created_at DESC, cm.rowid DESC LIMIT 1) AS message_id
             FROM task t JOIN channel c ON c.id = t.source_id
             WHERE t.source = 'channel' AND t.parent_id IS NOT NULL AND t.origin IS NULL
               AND t.state IN ('failed', 'blocked', 'review')
               AND NOT EXISTS (SELECT 1 FROM task r WHERE r.retry_of = t.id)
               AND NOT EXISTS (SELECT 1 FROM task p WHERE p.id = t.parent_id AND p.state = 'cancelled')
             LIMIT ${READ_MAX}`,
          )
          .map((r) => ({
            taskId: r.id,
            agentId: r.agent_id,
            label: r.label,
            state: r.state,
            channel: r.channel_name,
            target: {
              kind: "channel" as const,
              id: r.channel_id,
              ...(r.message_id ? { messageId: r.message_id } : {}),
            },
            at: r.at,
            reason: reasonOf(r),
          }))

      // ------------------------------------------------------------------ Went wrong
      const tasks = (day: { start: number; end: number }): TaskFacts[] =>
        db
          .all<
            Reasoned & {
              id: string
              agent_id: string
              label: string
              state: "failed" | "blocked"
              source: TaskSource
              finished_at: number
              channel_name: string | null
              workflow_name: string | null
            }
          >(
            `SELECT t.id, t.agent_id, t.label, t.state, t.source, t.error_code, t.error_detail,
                    t.finished_at, c.name AS channel_name, w.name AS workflow_name
             FROM task t
             LEFT JOIN channel c ON t.source = 'channel' AND c.id = t.source_id
             LEFT JOIN workflow_run wr ON t.source = 'workflow' AND wr.id = t.source_id
             LEFT JOIN workflow w ON w.id = wr.workflow_id
             WHERE t.state IN ('failed', 'blocked') AND t.origin IS NULL AND t.source != 'routine'
               AND NOT (t.source = 'channel' AND t.parent_id IS NOT NULL)
               AND t.finished_at >= ? AND t.finished_at < ?
               AND NOT EXISTS (SELECT 1 FROM task r WHERE r.retry_of = t.id)
             ORDER BY t.finished_at DESC LIMIT ${READ_MAX}`,
            day.start,
            day.end,
          )
          .map((r) => {
            const where: TodayWhere | null =
              r.source === "chat"
                ? { kind: "direct", name: "" }
                : r.source === "channel" && r.channel_name
                  ? { kind: "channel", name: r.channel_name }
                  : r.source === "workflow" && r.workflow_name
                    ? { kind: "workflow", name: r.workflow_name }
                    : null
            return {
              id: r.id,
              agentId: r.agent_id,
              label: r.label,
              state: r.state,
              source: r.source,
              where,
              at: r.finished_at,
              reason: reasonOf(r),
            }
          })

      /** The routines that run here, with the runs that decide their row (spec 009). */
      const routines = (day: { start: number; end: number }): RoutineFacts[] => {
        const runRow = (r: {
          state: string
          created_at: number
          finished_at: number | null
          error_code: string | null
          error_detail: string | null
        }): RunFacts => ({
          state: r.state,
          createdAt: r.created_at,
          finishedAt: r.finished_at,
          reason: reasonOf(r),
        })
        type RunRow = Parameters<typeof runRow>[0] & { id: string; routine_id: string }
        // The newest final runs of each routine, for the failed runs in a row...
        const recent = db.all<RunRow>(
          `SELECT id, routine_id, state, created_at, finished_at, error_code, error_detail FROM (
             SELECT id, source_id AS routine_id, state, created_at, finished_at, error_code, error_detail,
                    ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at DESC) AS n
             FROM task
             WHERE source = 'routine' AND origin IS NULL AND state IN ('done', 'failed', 'blocked')
           ) WHERE n <= ${STREAK_LOOK}`,
        )
        // ...and every failed run of today, however many runs came after it.
        const failedToday = db.all<RunRow>(
          `SELECT id, source_id AS routine_id, state, created_at, finished_at, error_code, error_detail
           FROM task
           WHERE source = 'routine' AND origin IS NULL AND state IN ('failed', 'blocked')
             AND finished_at >= ? AND finished_at < ?
           LIMIT ${READ_MAX}`,
          day.start,
          day.end,
        )
        const runs = new Map<string, Map<string, RunFacts>>()
        for (const r of [...recent, ...failedToday]) {
          const list = runs.get(r.routine_id) ?? new Map<string, RunFacts>()
          list.set(r.id, runRow(r))
          runs.set(r.routine_id, list)
        }
        return db
          .all<{
            id: string
            name: string
            agent_id: string
            enabled: number
            updated_at: number
          }>("SELECT id, name, agent_id, enabled, updated_at FROM routine WHERE runs_on IS NULL")
          .map((r) => ({
            id: r.id,
            name: r.name,
            agentId: r.agent_id,
            enabled: r.enabled === 1,
            resetAt: r.updated_at,
            runs: [...(runs.get(r.id)?.values() ?? [])],
            nextRun: null,
          }))
      }

      /**
       * A model account has a problem when its newest turn failed because the sign-in is not valid
       * or the plan limit is reached (spec 021). A turn belongs to the account that its agent uses.
       */
      const accounts = (): AccountFacts[] =>
        db
          .all<{ id: string; kind: string; name: string; off: number }>(
            "SELECT id, kind, name, off FROM provider_account ORDER BY created_at",
          )
          .map((a) => {
            const agents = db.all<{ id: string }>(
              "SELECT id FROM agent WHERE model_account_id = ?",
              a.id,
            )
            type Turn = {
              status: string
              error_code: string | null
              error_resets_at: number | null
              at: number
            }
            let last: (Turn & { agentId: string }) | undefined
            for (const agent of agents) {
              const direct = db.get<Turn>(
                `SELECT status, error_code, error_resets_at, COALESCE(finished_at, created_at) AS at
                 FROM message WHERE agent_id = ? AND author = 'agent' AND status IN ('done', 'failed')
                 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
                agent.id,
              )
              const channel = db.get<Turn>(
                `SELECT status, error_code, error_resets_at, COALESCE(finished_at, created_at) AS at
                 FROM channel_message
                 WHERE agent_id = ? AND author = 'agent' AND status IN ('done', 'failed')
                 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
                agent.id,
              )
              for (const turn of [direct, channel])
                if (turn && (!last || turn.at > last.at)) last = { ...turn, agentId: agent.id }
            }
            // A runtime account is disconnected by a switch, an API account by removing its key.
            return {
              id: a.id,
              name: a.name,
              connected: isRuntimeKind(a.kind)
                ? a.off === 0
                : secrets.get(secretKey(a.id)) !== null,
              last: last
                ? {
                    failed: last.status === "failed",
                    code: last.error_code ?? "",
                    resetsAt: last.error_resets_at,
                    at: last.at,
                    agentId: last.agentId,
                  }
                : null,
            }
          })

      // ------------------------------------------------------------------ Done today
      const done = (day: { start: number; end: number }): DoneFacts[] => [
        ...db
          .all<{ id: string; name: string; agent_id: string; n: number; last: number }>(
            `SELECT r.id, r.name, r.agent_id, COUNT(*) AS n, MAX(t.finished_at) AS last
             FROM task t JOIN routine r ON r.id = t.source_id
             WHERE t.source = 'routine' AND t.origin IS NULL AND t.state = 'done'
               AND t.finished_at >= ? AND t.finished_at < ?
             GROUP BY r.id`,
            day.start,
            day.end,
          )
          .map((r) => ({
            kind: "routine" as const,
            id: r.id,
            name: r.name,
            agentId: r.agent_id,
            count: r.n,
            last: r.last,
          })),
        ...db
          .all<{ id: string; name: string; n: number; last: number }>(
            `SELECT w.id, w.name, COUNT(*) AS n, MAX(r.finished_at) AS last
             FROM workflow_run r JOIN workflow w ON w.id = r.workflow_id
             WHERE r.origin IS NULL AND r.state = 'done'
               AND r.finished_at >= ? AND r.finished_at < ?
             GROUP BY w.id`,
            day.start,
            day.end,
          )
          .map((w) => ({
            kind: "workflow" as const,
            id: w.id,
            name: w.name,
            agentId: null,
            count: w.n,
            last: w.last,
          })),
      ]

      // ------------------------------------------------------------------ Next 24 hours
      /** The next run of each routine that runs here and is on. */
      const routineRuns = (now: number) =>
        db
          .all<{ id: string; name: string; agent_id: string; enabled: number; schedule: string }>(
            "SELECT id, name, agent_id, enabled, schedule FROM routine WHERE runs_on IS NULL",
          )
          .map((r) => ({
            id: r.id,
            name: r.name,
            agentId: r.agent_id,
            enabled: r.enabled === 1,
            nextRun:
              r.enabled === 1
                ? (runTimes(JSON.parse(r.schedule) as Schedule, now, 1, now + TODAY_AHEAD_MS)[0] ??
                  null)
                : null,
          }))

      const workflows = (
        now: number,
      ): Pick<WorkflowFacts, "id" | "name" | "enabled" | "nextRun">[] =>
        db
          .all<{ id: string; name: string; enabled: number; trigger: string }>(
            "SELECT id, name, enabled, trigger FROM workflow WHERE runs_on IS NULL",
          )
          .map((w) => {
            const trigger = JSON.parse(w.trigger) as { kind: string; schedule?: Schedule }
            return {
              id: w.id,
              name: w.name,
              enabled: w.enabled === 1,
              nextRun:
                w.enabled === 1 && trigger.kind === "schedule" && trigger.schedule
                  ? (runTimes(trigger.schedule, now, 1, now + TODAY_AHEAD_MS)[0] ?? null)
                  : null,
            }
          })

      // ------------------------------------------------------------------ The page
      /** Reads one group. A source that cannot be read gives `null`, not an empty list. */
      const read = (rows: () => readonly TodayRow[]): readonly TodayRow[] | null => {
        try {
          return rows()
        } catch (error) {
          console.error("today group could not be read", error)
          return null
        }
      }

      const build = (now: number) => {
        const day = dayBounds(now)
        const groups: Record<TodayGroupId, readonly TodayRow[] | null> = {
          needs: read(() => needsRows(cards(), parts())),
          wrong: read(() => wrongRows(tasks(day), routines(day), accounts(), day, now)),
          done: read(() => doneRows(done(day))),
          next: read(() => nextRows(routineRuns(now), workflows(now), now)),
        }
        const snapshot = todaySnapshot(day.start, groups)
        // The times when a row waits for the clock: the next midnight, the end of a plan limit,
        // and a run that is due. Anything else is found by the look every minute.
        const marks = [
          day.end,
          now + REFRESH_MS,
          ...snapshot.groups.flatMap((g) =>
            g.rows.flatMap((r) =>
              g.id === "next" ? [r.at] : r.resetsAt !== null ? [r.resetsAt] : [],
            ),
          ),
        ].filter((t) => t > now)
        return { snapshot, change: Math.min(...marks) }
      }

      // ------------------------------------------------------------------ Pushing
      let pushed = ""
      let change = 0
      let dirty = false
      let looked = 0
      let zoneDay = dayKey(Date.now(), localZone())

      const push = (now: number) => {
        const built = build(now)
        change = built.change
        const sig = JSON.stringify(built.snapshot)
        if (sig === pushed) return
        pushed = sig
        bus.emit("today.changed", built.snapshot)
      }

      bus.tap((event, payload) => {
        if (!SOURCES.has(event)) return
        // A reply that still streams does not change a row.
        if (
          (event === "chat.message" || event === "channel.message") &&
          (payload as { status?: string }).status === "streaming"
        )
          return
        dirty = true
      })

      const check = (now: number) =>
        Effect.sync(() => {
          // A change that came from an event shows within one step. The clock is looked at less
          // often: the day, the time zone, and a time that a row waits for.
          const clockDue = now - looked >= CLOCK_MS || now < looked
          if (!dirty && !clockDue) return
          let reread = dirty
          if (clockDue) {
            looked = now
            const key = dayKey(now, localZone())
            if (key !== zoneDay || (change > 0 && now >= change)) {
              zoneDay = key
              reread = true
            }
          }
          if (!reread) return
          dirty = false
          push(now)
        })

      yield* Effect.forkDetach(
        Effect.forever(
          Effect.sleep(STEP_MS).pipe(Effect.andThen(Effect.suspend(() => check(Date.now())))),
        ),
      )

      return Today.of({
        snapshot: (now = Date.now()) =>
          Effect.sync(() => {
            const built = build(now)
            change = built.change
            pushed = JSON.stringify(built.snapshot)
            zoneDay = dayKey(now, localZone())
            return built.snapshot
          }),
        check,
      })
    }),
  )
}
