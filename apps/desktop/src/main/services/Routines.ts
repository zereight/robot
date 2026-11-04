import { randomUUID } from "node:crypto"
import {
  type AgentModel,
  changeText,
  dueRuns,
  hasUsage,
  isActive,
  type Locale,
  limitState,
  type OutsideSource,
  ROUTINE_FAILURES_MAX,
  ROUTINES_MAX,
  type Routine,
  type RoutineEntry,
  type RoutineEntryState,
  type RoutineFailure,
  type RoutineInput,
  type RoutinePatch,
  type RoutinePlace,
  resolveLocale,
  runText,
  runTimes,
  type Schedule,
  tokensOf,
  translate,
  validSchedule,
  validTokenLimit,
  validWatch,
  type Watch,
  watchRunText,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Notifier } from "./Notifier.ts"
import { Platform } from "./Platform.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { type CheckOutcome, runCheck, type ToolCaller } from "./watchCheck.ts"

export interface RoutinesService {
  list(serverId: string): Effect.Effect<readonly Routine[]>
  /** Makes a routine. `paused` makes it with the switch off, so it does not run until resumed. */
  create(input: RoutineInput, options?: { paused?: boolean }): Effect.Effect<Routine, AppError>
  update(id: string, patch: RoutinePatch): Effect.Effect<Routine, AppError>
  remove(id: string): Effect.Effect<void>
  /** Starts a run at once, outside the schedule. */
  runNow(id: string): Effect.Effect<void, AppError>
  /** Moves a routine of the other computer here: it runs here from now on (spec 019). */
  runHere(id: string): Effect.Effect<Routine, AppError>
  /** Past, present and planned runs of all routines of a server between two times. */
  calendar(serverId: string, from: number, to: number): Effect.Effect<readonly RoutineEntry[]>
  /**
   * Checks every routine at `now`: the schedules, then the watches that are due. The scheduler
   * calls it by the clock; tests call it by hand. It ends when the checks of the watches end.
   */
  tick(now: number): Effect.Effect<void>
}

interface Row {
  id: string
  server_id: string
  agent_id: string
  agent_name: string
  workspace: string
  name: string
  prompt: string
  schedule: string
  watch: string | null
  model_account_id: string | null
  model_name: string | null
  model_effort: string | null
  channel_id: string | null
  enabled: number
  last_checked_at: number
  created_at: number
  runs_on: string | null
  token_limit: number | null
}

interface StateRow {
  failed_runs: number
  paused_failure: string | null
  watch_result: string | null
  watch_checked_at: number | null
}

const SELECT = `SELECT r.*, a.name AS agent_name, a.workspace AS workspace
  FROM routine r JOIN agent a ON a.id = r.agent_id`
const TICK_MS = 15_000
const NEXT_COUNT = 3
const CALENDAR_PLAN_MAX = 500

/**
 * A test run of the app can make the clock of the watches faster: a "minute" of an interval and
 * the time between two ticks are shorter. The shipped app uses real minutes.
 */
const testRun = Boolean(process.env.ROBOT_USER_DATA)
const MINUTE_MS = (testRun && Number(process.env.ROBOT_TEST_WATCH_MINUTE_MS)) || 60_000
const LOOP_MS = (testRun && Number(process.env.ROBOT_TEST_ROUTINE_TICK_MS)) || TICK_MS

const placeOf = (row: Row): RoutinePlace =>
  row.channel_id ? { kind: "channel", channelId: row.channel_id } : { kind: "agent" }

const watchOf = (row: Row): Watch | null =>
  row.watch === null ? null : (JSON.parse(row.watch) as Watch)

const scheduleOf = (row: Row): Schedule | null =>
  row.watch === null ? (JSON.parse(row.schedule) as Schedule) : null

const modelOf = (row: Row): AgentModel | null =>
  row.model_account_id && row.model_name
    ? { accountId: row.model_account_id, model: row.model_name, effort: row.model_effort }
    : null

/** The most characters of the change that a run "Recorded" keeps. Sync carries at most this many. */
const RECORDED_MAX = 2000

const parseFailure = (text: string | null): RoutineFailure | null => {
  if (!text) return null
  try {
    return JSON.parse(text) as RoutineFailure
  } catch {
    return null
  }
}

/**
 * Today no Deny rule exists (the rules of spec 007 come with S30), so no rule refuses a check.
 * The rules pass their match here when they come.
 */
const denyRuleMatches = (_row: Row, _watch: Watch): boolean => false

/**
 * Today no connection exists (spec 018 comes with S32), so a watch on a tool of a connection
 * fails its check with the reason that the connection is not there.
 */
const callConnectionTool: ToolCaller | undefined = undefined

export class Routines extends Context.Service<Routines, RoutinesService>()("robot/main/Routines") {
  static readonly layer = Layer.effect(
    Routines,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const tasks = yield* Tasks
      const chat = yield* Chat
      const channels = yield* Channels
      const notifier = yield* Notifier
      const settings = yield* SettingsStore
      const platform = yield* Platform

      const localeNow = (): Locale =>
        resolveLocale(Effect.runSync(settings.get).language, platform.systemLocale())

      /** The routines of a server. A paused routine counts (spec 009, "Limits and safeguards"). */
      const routineCount = (serverId: string) =>
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM routine WHERE server_id = ?", serverId)
          ?.n ?? 0

      const stateOf = (id: string): StateRow =>
        db.get<StateRow>("SELECT * FROM routine_state WHERE routine_id = ?", id) ?? {
          failed_runs: 0,
          paused_failure: null,
          watch_result: null,
          watch_checked_at: null,
        }
      const setState = (id: string, values: Partial<StateRow>) => {
        db.run("INSERT OR IGNORE INTO routine_state (routine_id) VALUES (?)", id)
        for (const [column, value] of Object.entries(values))
          db.run(`UPDATE routine_state SET ${column} = ? WHERE routine_id = ?`, value, id)
      }

      const nextCheckOf = (r: Row, watch: Watch, state: StateRow) =>
        r.enabled !== 1 || r.runs_on !== null
          ? null
          : state.watch_checked_at === null
            ? Date.now()
            : Math.max(Date.now(), state.watch_checked_at + watch.minutes * MINUTE_MS)

      const toRoutine = (r: Row): Routine => {
        const schedule = scheduleOf(r)
        const watch = watchOf(r)
        const state = stateOf(r.id)
        return {
          id: r.id,
          serverId: r.server_id,
          agentId: r.agent_id,
          agentName: r.agent_name,
          name: r.name,
          prompt: r.prompt,
          schedule,
          watch,
          model: modelOf(r),
          tokenLimit: r.token_limit,
          place: placeOf(r),
          enabled: r.enabled === 1,
          createdAt: r.created_at,
          nextRuns:
            schedule && r.enabled === 1 && r.runs_on === null
              ? runTimes(schedule, Date.now(), NEXT_COUNT)
              : [],
          nextCheck: watch ? nextCheckOf(r, watch, state) : null,
          pausedAfterFailures: r.enabled === 1 ? null : parseFailure(state.paused_failure),
          runsOn: r.runs_on === null ? null : tasks.computerName(r.runs_on),
        }
      }
      const row = (id: string) => db.get<Row>(`${SELECT} WHERE r.id = ?`, id)
      const changed = (serverId: string) => bus.emit("routines.changed", { serverId })

      const checkInput = (
        agentId: string,
        trigger: { schedule: Schedule | null; watch: Watch | null },
        place: RoutinePlace,
      ) =>
        Effect.gen(function* () {
          // One trigger: a schedule or a watch, never both (spec 009).
          if ((trigger.schedule === null) === (trigger.watch === null))
            return yield* new AppError({ code: "invalid_schedule" })
          if (trigger.schedule && !validSchedule(trigger.schedule))
            return yield* new AppError({ code: "invalid_schedule" })
          if (trigger.watch && !validWatch(trigger.watch))
            return yield* new AppError({ code: "invalid_watch" })
          if (!db.get("SELECT 1 AS x FROM agent WHERE id = ? AND archived_at IS NULL", agentId))
            return yield* new AppError({ code: "agent_not_found" })
          if (
            place.kind === "channel" &&
            !db.get(
              "SELECT 1 AS x FROM channel_member WHERE channel_id = ? AND agent_id = ?",
              place.channelId,
              agentId,
            )
          )
            return yield* new AppError({ code: "agent_not_in_channel" })
        })

      const active = (routineId: string) =>
        db
          .all<{ state: Parameters<typeof isActive>[0] }>(
            "SELECT state FROM task WHERE source = 'routine' AND source_id = ?",
            routineId,
          )
          .some((t) => isActive(t.state))

      const skip = (
        routineId: string,
        at: number,
        kind: "missed" | "skipped" | "failed" | "recorded",
        reason: RoutineFailure | null = null,
      ) =>
        db.run(
          "INSERT INTO routine_skip (id, routine_id, at, kind, reason) VALUES (?, ?, ?, ?, ?)",
          randomUUID(),
          routineId,
          at,
          kind,
          reason ? JSON.stringify(reason) : null,
        )

      /**
       * A failed run or a failed check adds 1 to the count. At 3 in a row the routine pauses
       * itself, keeps the reason, and sends one notification (spec 009, "Repeated failure"). It
       * returns true when it sent that notification: it says that the routine is paused, and it
       * is the only one for that failure, so a task that failed makes no notice of its own.
       */
      const addFailure = (routineId: string, reason: RoutineFailure): boolean => {
        const r = row(routineId)
        if (!r) return false
        const count = stateOf(routineId).failed_runs + 1
        setState(routineId, { failed_runs: count })
        if (count < ROUTINE_FAILURES_MAX || r.enabled !== 1) return false
        setState(routineId, { paused_failure: JSON.stringify(reason) })
        db.run("UPDATE routine SET enabled = 0, updated_at = ? WHERE id = ?", Date.now(), r.id)
        // The notice is of the kind "routine failed" and it says "<routine> is paused after 3
        // failed runs", in the language of the interface. The island shows the same words as the
        // reason of its result card. A click opens the page of routines, where Resume is.
        notifier.notify({
          kind: "routine_failed",
          agentId: r.agent_id,
          serverId: r.server_id,
          channelId: r.channel_id,
          title: r.agent_name,
          body: translate(localeNow(), "error.routine_paused", { detail: r.name }),
          reason: { code: "routine_paused", detail: r.name },
          target: r.channel_id
            ? { kind: "channel", id: r.channel_id }
            : { kind: "agent", id: r.agent_id },
          page: "workflows",
        })
        changed(r.server_id)
        return true
      }
      const clearFailures = (routineId: string) =>
        setState(routineId, { failed_runs: 0, paused_failure: null })

      // A run that ends as Done sets the count to 0; a run that fails adds 1. A run that the user
      // stops (cancelled) does not change it.
      tasks.onEndTold((task) => {
        if (task.source !== "routine" || !task.sourceId || task.parentId) return false
        // The routine may be gone, or live on the other computer only.
        if (!row(task.sourceId)) return false
        if (task.state === "done") clearFailures(task.sourceId)
        // A blocked run is a failed run for the pause, with the reason of the block (spec 009).
        else if (task.state === "failed" || task.state === "blocked")
          return addFailure(task.sourceId, task.error ?? { code: "unknown", detail: "" })
        return false
      })

      /** Starts a run. `text` is the prompt with what the run gets with it. */
      /** `retryOf`: the task that this run tries again, so that its agent reads the retry note (spec 005). */
      const start = (r: Row, text: string, outside?: OutsideSource, retryOf?: string) => {
        const model = modelOf(r)
        return r.channel_id
          ? channels.runRoutine(r.channel_id, r.agent_id, text, r.id, {
              ...(model ? { model } : {}),
              ...(outside ? { outside } : {}),
            })
          : chat
              .send(
                { agentId: r.agent_id, text, replyTo: null },
                {
                  source: "routine",
                  sourceId: r.id,
                  ...(model ? { model } : {}),
                  ...(outside ? { outside } : {}),
                  ...(retryOf ? { retryOf } : {}),
                },
              )
              .pipe(Effect.asVoid)
      }

      /** A run that cannot start fails, with the reason (spec 009). It counts as a failed run. */
      const startOrFail = (r: Row, at: number, text: string, outside?: OutsideSource) =>
        start(r, text, outside).pipe(
          Effect.catch((e: AppError) =>
            Effect.sync(() => {
              const reason = { code: e.code, detail: e.detail ?? "" }
              skip(r.id, at, "failed", reason)
              addFailure(r.id, reason)
            }),
          ),
        )

      const scheduleTick = (now: number) =>
        Effect.gen(function* () {
          // A routine runs on one computer only (spec 019): the others do not run it, and a run
          // that it misses there does not count as missed here.
          const rows = db.all<Row>(
            `${SELECT} WHERE r.enabled = 1 AND r.runs_on IS NULL AND r.watch IS NULL`,
          )
          for (const r of rows) {
            const schedule = scheduleOf(r)
            if (!schedule) continue
            const { start: at, missed } = dueRuns(schedule, r.last_checked_at, now)
            db.run("UPDATE routine SET last_checked_at = ? WHERE id = ?", now, r.id)
            for (const m of missed) skip(r.id, m, "missed")
            if (at !== null) {
              if (active(r.id)) skip(r.id, at, "skipped")
              // A run that starts more than 15 minutes late gets both times.
              else yield* startOrFail(r, at, runText(r.prompt, at, now))
            }
            if (at !== null || missed.length > 0) changed(r.server_id)
          }
        })

      /** The watches whose check runs now, so that a slow check does not start twice. */
      const checking = new Set<string>()

      /** One check of a watch, and what follows from it (spec 009, "Watch"). */
      const check = (r: Row, watch: Watch, now: number) =>
        Effect.gen(function* () {
          const outcome: CheckOutcome = yield* Effect.promise(() =>
            runCheck(watch.target, {
              workspace: r.workspace,
              denied: denyRuleMatches(r, watch),
              ...(callConnectionTool ? { callTool: callConnectionTool } : {}),
            }),
          )
          // The routine may have changed or gone while the check ran.
          const current = row(r.id)
          if (!current || current.watch !== r.watch || current.enabled !== 1) return
          const before = stateOf(r.id).watch_result
          setState(r.id, { watch_checked_at: now })
          if (!outcome.ok) {
            skip(r.id, now, "failed", outcome.reason)
            addFailure(r.id, outcome.reason)
            changed(r.server_id)
            return
          }
          setState(r.id, { watch_result: outcome.result })
          // The first check keeps the result and does not run the routine.
          if (before === null) {
            changed(r.server_id)
            return
          }
          if (before !== outcome.result) {
            const path = watch.target.kind === "path" ? watch.target.path : ""
            const change = changeText(before, outcome.result, path)
            // "Record only": the change shows in the calendar. No task starts and no model is
            // called. It counts for no failure and no token limit.
            if (watch.recordOnly) {
              skip(r.id, now, "recorded", {
                code: "recorded",
                detail:
                  change.length > RECORDED_MAX ? `${change.slice(0, RECORDED_MAX - 1)}…` : change,
              })
              changed(r.server_id)
              return
            }
            const text = watchRunText(r.prompt, change)
            yield* startOrFail(current, now, text, { kind: "routine", name: r.name })
            changed(r.server_id)
            return
          }
          // No change: no task. One muted line when the switch is on.
          if (watch.postUnchanged) {
            const part = { kind: "note", note: "watch_unchanged", routine: r.name } as const
            if (r.channel_id) channels.note(r.channel_id, r.agent_id, part)
            else chat.note(r.agent_id, part)
          }
          changed(r.server_id)
        })

      /** The watches that are due: on, here, not in a check, and with no run that still goes. */
      const dueWatches = (now: number) =>
        db
          .all<Row>(`${SELECT} WHERE r.enabled = 1 AND r.runs_on IS NULL AND r.watch IS NOT NULL`)
          .flatMap((r) => {
            const watch = watchOf(r)
            if (!watch || checking.has(r.id)) return []
            // A check that is due while the last run goes waits until the run ends.
            if (active(r.id)) return []
            const last = stateOf(r.id).watch_checked_at
            // After a sleep, one check runs at once; no check is "Missed".
            if (last !== null && now - last < watch.minutes * MINUTE_MS) return []
            return [{ r, watch }]
          })

      const watchTick = (now: number) =>
        Effect.forEach(
          dueWatches(now),
          ({ r, watch }) => {
            checking.add(r.id)
            return check(r, watch, now).pipe(
              Effect.ensuring(Effect.sync(() => checking.delete(r.id))),
            )
          },
          { concurrency: "unbounded", discard: true },
        )

      const tick = (now: number) =>
        Effect.gen(function* () {
          yield* scheduleTick(now)
          yield* watchTick(now)
        })

      // The routine tasks that fail or stop can be tried again, as a run now.
      // A retry of a task of the other computer runs here, whatever computer the routine runs on.
      tasks.onRetry("routine", (task) =>
        task.sourceId
          ? runNow(task.sourceId, true, task.id)
          : Effect.fail(new AppError({ code: "invalid_input" })),
      )

      const runNow = (id: string, force = false, retryOf?: string): Effect.Effect<void, AppError> =>
        Effect.gen(function* () {
          const r = row(id)
          if (!r) return yield* new AppError({ code: "routine_not_found" })
          if (r.runs_on !== null && !force)
            return yield* new AppError({ code: "routine_elsewhere" })
          if (active(id)) return yield* new AppError({ code: "routine_running" })
          yield* start(r, r.prompt, undefined, retryOf)
          changed(r.server_id)
        })

      // The schedules run in the loop; a check of a watch runs beside it, so that a slow check
      // does not hold back the schedules. Both end with the layer: after that the database is
      // closed, and a check of it fails.
      const scope = yield* Effect.scope
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(LOOP_MS).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const now = Date.now()
                return scheduleTick(now).pipe(
                  Effect.andThen(Effect.forkIn(watchTick(now), scope)),
                  Effect.catchCause(() => Effect.void),
                )
              }),
            ),
          ),
        ),
      )

      const triggerOf = (input: {
        schedule?: Schedule | undefined
        watch?: Watch | undefined
      }): { schedule: Schedule | null; watch: Watch | null } => ({
        schedule: input.schedule ?? null,
        watch: input.watch ?? null,
      })

      return Routines.of({
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<Row>(`${SELECT} WHERE r.server_id = ? ORDER BY r.created_at`, serverId)
              .map(toRoutine),
          ),
        create: (input, options) =>
          Effect.gen(function* () {
            // Every way to make a routine comes here: the form, an agent file, a starter. A server
            // holds at most 50, and a paused routine counts (spec 009, "Limits and safeguards").
            if (routineCount(input.serverId) >= ROUTINES_MAX)
              return yield* new AppError({ code: "routines_full", detail: String(ROUTINES_MAX) })
            const trigger = triggerOf(input as { schedule?: Schedule; watch?: Watch })
            yield* checkInput(input.agentId, trigger, input.place)
            const id = randomUUID()
            const now = Date.now()
            const model = input.model ?? null
            if (input.tokenLimit != null && !validTokenLimit(input.tokenLimit))
              return yield* new AppError({ code: "invalid_token_limit" })
            db.run(
              `INSERT INTO routine (id, server_id, agent_id, name, prompt, schedule, watch, model_account_id, model_name, model_effort, channel_id, enabled, last_checked_at, created_at, updated_at, token_limit)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              input.serverId,
              input.agentId,
              input.name.trim(),
              input.prompt,
              JSON.stringify(trigger.schedule),
              trigger.watch ? JSON.stringify(trigger.watch) : null,
              model?.accountId ?? null,
              model?.model ?? null,
              model?.effort ?? null,
              input.place.kind === "channel" ? input.place.channelId : null,
              options?.paused ? 0 : 1,
              now,
              now,
              now,
              input.tokenLimit ?? null,
            )
            changed(input.serverId)
            return toRoutine(row(id) as Row)
          }),
        update: (id, patch) =>
          Effect.gen(function* () {
            const current = row(id)
            if (!current) return yield* new AppError({ code: "routine_not_found" })
            // A new schedule replaces a watch, and a new watch replaces a schedule.
            const trigger =
              patch.schedule !== undefined || patch.watch !== undefined
                ? triggerOf(patch as { schedule?: Schedule; watch?: Watch })
                : { schedule: scheduleOf(current), watch: watchOf(current) }
            const place = patch.place ?? placeOf(current)
            const agentId = patch.agentId ?? current.agent_id
            yield* checkInput(agentId, trigger, place)
            const model = patch.model === undefined ? modelOf(current) : patch.model
            const tokenLimit =
              patch.tokenLimit === undefined ? current.token_limit : patch.tokenLimit
            if (tokenLimit !== null && !validTokenLimit(tokenLimit))
              return yield* new AppError({ code: "invalid_token_limit" })
            const watchText = trigger.watch ? JSON.stringify(trigger.watch) : null
            const now = Date.now()
            db.run(
              `UPDATE routine SET agent_id = ?, name = ?, prompt = ?, schedule = ?, watch = ?, channel_id = ?, enabled = ?,
                 model_account_id = ?, model_name = ?, model_effort = ?, last_checked_at = ?, updated_at = ?,
                 token_limit = ? WHERE id = ?`,
              agentId,
              patch.name?.trim() ?? current.name,
              patch.prompt ?? current.prompt,
              JSON.stringify(trigger.schedule),
              watchText,
              place.kind === "channel" ? place.channelId : null,
              patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
              model?.accountId ?? null,
              model?.model ?? null,
              model?.effort ?? null,
              // Resuming or changing the schedule starts the check from now: nothing counts as missed.
              now,
              now,
              tokenLimit,
              id,
            )
            // Resume, and an edit of the prompt, the trigger, the agent or the place, set the
            // count of failed runs to 0 (spec 009).
            if (
              patch.enabled === true ||
              patch.prompt !== undefined ||
              patch.schedule !== undefined ||
              patch.watch !== undefined ||
              patch.agentId !== undefined ||
              patch.place !== undefined
            )
              clearFailures(id)
            // A watch on another thing keeps its first result again at its next check.
            const sameTarget =
              current.watch !== null &&
              trigger.watch !== null &&
              JSON.stringify((JSON.parse(current.watch) as Watch).target) ===
                JSON.stringify(trigger.watch.target)
            if (!sameTarget) setState(id, { watch_result: null, watch_checked_at: null })
            changed(current.server_id)
            return toRoutine(row(id) as Row)
          }),
        remove: (id) =>
          Effect.sync(() => {
            const current = row(id)
            if (!current) return
            db.run("DELETE FROM routine WHERE id = ?", id)
            changed(current.server_id)
          }),
        runNow: (id) => runNow(id),
        runHere: (id) =>
          Effect.gen(function* () {
            const current = row(id)
            if (!current) return yield* new AppError({ code: "routine_not_found" })
            if (current.runs_on !== null) {
              // The check starts from now: nothing counts as missed for the time it ran elsewhere.
              const now = Date.now()
              db.run(
                "UPDATE routine SET runs_on = NULL, last_checked_at = ?, updated_at = ? WHERE id = ?",
                now,
                now,
                id,
              )
              // A watch keeps its first result again here.
              setState(id, { watch_result: null, watch_checked_at: null })
              changed(current.server_id)
            }
            return toRoutine(row(id) as Row)
          }),
        calendar: (serverId, from, to) =>
          Effect.sync(() => {
            const out: RoutineEntry[] = []
            const routines = db.all<Row>(`${SELECT} WHERE r.server_id = ?`, serverId)
            for (const r of routines) {
              const done = db.all<{
                id: string
                state: RoutineEntryState
                created_at: number
                error_code: string | null
                error_detail: string | null
                token_limit: number | null
              }>(
                `SELECT id, state, created_at, error_code, error_detail, token_limit FROM task
                 WHERE source = 'routine' AND source_id = ? AND created_at BETWEEN ? AND ?`,
                r.id,
                from,
                to,
              )
              for (const t of done) {
                // The run details (spec 005, 009): the tokens of all tasks of the run, and the
                // 80 percent line of a run that has a limit.
                const total = tasks.treeUsage(t.id).total
                const limit =
                  t.token_limit === null
                    ? undefined
                    : {
                        tokens: t.token_limit,
                        near: limitState(tokensOf(total), t.token_limit) === "near",
                      }
                out.push({
                  routineId: r.id,
                  routineName: r.name,
                  at: t.created_at,
                  state: t.state,
                  taskId: t.id,
                  // A blocked or failed run shows its reason (spec 009).
                  ...((t.state === "blocked" || t.state === "failed") && t.error_code
                    ? { reason: { code: t.error_code, detail: t.error_detail ?? "" } }
                    : {}),
                  ...(hasUsage(total) ? { usage: total } : {}),
                  ...(limit ? { limit } : {}),
                })
              }
              for (const s of db.all<{
                at: number
                kind: "missed" | "skipped" | "failed" | "recorded"
                reason: string | null
              }>(
                "SELECT at, kind, reason FROM routine_skip WHERE routine_id = ? AND at BETWEEN ? AND ?",
                r.id,
                from,
                to,
              ))
                out.push({
                  routineId: r.id,
                  routineName: r.name,
                  at: s.at,
                  state: s.kind,
                  taskId: null,
                  ...(s.kind === "recorded"
                    ? { reason: null, change: parseFailure(s.reason)?.detail ?? "" }
                    : { reason: parseFailure(s.reason) }),
                })
              // A watch has no future runs in the calendar (spec 009).
              const schedule = scheduleOf(r)
              if (schedule && r.enabled === 1 && r.runs_on === null)
                for (const at of runTimes(
                  schedule,
                  Math.max(Date.now(), from - 1),
                  CALENDAR_PLAN_MAX,
                  to,
                ))
                  out.push({
                    routineId: r.id,
                    routineName: r.name,
                    at,
                    state: "planned",
                    taskId: null,
                  })
            }
            return out.sort((a, b) => a.at - b.at)
          }),
        tick,
      })
    }),
  )
}
