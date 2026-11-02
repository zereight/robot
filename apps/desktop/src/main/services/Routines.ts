import { randomUUID } from "node:crypto"
import {
  dueRuns,
  isActive,
  type Routine,
  type RoutineEntry,
  type RoutineEntryState,
  type RoutineInput,
  type RoutinePatch,
  type RoutinePlace,
  runTimes,
  type Schedule,
  validSchedule,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Tasks } from "./Tasks.ts"

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
  /** Checks every routine at `now`. The scheduler calls it by the clock; tests call it by hand. */
  tick(now: number): Effect.Effect<void>
}

interface Row {
  id: string
  server_id: string
  agent_id: string
  agent_name: string
  name: string
  prompt: string
  schedule: string
  channel_id: string | null
  enabled: number
  last_checked_at: number
  created_at: number
  runs_on: string | null
}

const SELECT = `SELECT r.*, a.name AS agent_name FROM routine r JOIN agent a ON a.id = r.agent_id`
const TICK_MS = 15_000
const NEXT_COUNT = 3
const CALENDAR_PLAN_MAX = 500

const placeOf = (row: Row): RoutinePlace =>
  row.channel_id ? { kind: "channel", channelId: row.channel_id } : { kind: "agent" }

export class Routines extends Context.Service<Routines, RoutinesService>()("robot/main/Routines") {
  static readonly layer = Layer.effect(
    Routines,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const tasks = yield* Tasks
      const chat = yield* Chat
      const channels = yield* Channels

      const toRoutine = (r: Row): Routine => {
        const schedule = JSON.parse(r.schedule) as Schedule
        return {
          id: r.id,
          serverId: r.server_id,
          agentId: r.agent_id,
          agentName: r.agent_name,
          name: r.name,
          prompt: r.prompt,
          schedule,
          place: placeOf(r),
          enabled: r.enabled === 1,
          createdAt: r.created_at,
          nextRuns:
            r.enabled === 1 && r.runs_on === null ? runTimes(schedule, Date.now(), NEXT_COUNT) : [],
          runsOn: r.runs_on === null ? null : tasks.computerName(r.runs_on),
        }
      }
      const row = (id: string) => db.get<Row>(`${SELECT} WHERE r.id = ?`, id)
      const changed = (serverId: string) => bus.emit("routines.changed", { serverId })

      const checkInput = (agentId: string, schedule: Schedule, place: RoutinePlace) =>
        Effect.gen(function* () {
          if (!validSchedule(schedule)) return yield* new AppError({ code: "invalid_schedule" })
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

      const skip = (routineId: string, at: number, kind: "missed" | "skipped") =>
        db.run(
          "INSERT INTO routine_skip (id, routine_id, at, kind) VALUES (?, ?, ?, ?)",
          randomUUID(),
          routineId,
          at,
          kind,
        )

      const start = (r: Row) =>
        r.channel_id
          ? channels.runRoutine(r.channel_id, r.agent_id, r.prompt, r.id)
          : chat.send(
              { agentId: r.agent_id, text: r.prompt, replyTo: null },
              { source: "routine", sourceId: r.id },
            )

      const tick = (now: number) =>
        Effect.gen(function* () {
          // A routine runs on one computer only (spec 019): the others do not run it, and a run
          // that it misses there does not count as missed here.
          const rows = db.all<Row>(`${SELECT} WHERE r.enabled = 1 AND r.runs_on IS NULL`)
          for (const r of rows) {
            const { start: at, missed } = dueRuns(
              JSON.parse(r.schedule) as Schedule,
              r.last_checked_at,
              now,
            )
            db.run("UPDATE routine SET last_checked_at = ? WHERE id = ?", now, r.id)
            for (const m of missed) skip(r.id, m, "missed")
            if (at !== null) {
              if (active(r.id)) skip(r.id, at, "skipped")
              else
                yield* start(r).pipe(
                  Effect.catch(() => Effect.sync(() => skip(r.id, at, "skipped"))),
                )
            }
            if (at !== null || missed.length > 0) changed(r.server_id)
          }
        })

      // The routine tasks that fail or stop can be tried again, as a run now.
      // A retry of a task of the other computer runs here, whatever computer the routine runs on.
      tasks.onRetry("routine", (task) =>
        task.sourceId
          ? runNow(task.sourceId, true)
          : Effect.fail(new AppError({ code: "invalid_input" })),
      )

      const runNow = (id: string, force = false): Effect.Effect<void, AppError> =>
        Effect.gen(function* () {
          const r = row(id)
          if (!r) return yield* new AppError({ code: "routine_not_found" })
          if (r.runs_on !== null && !force)
            return yield* new AppError({ code: "routine_elsewhere" })
          if (active(id)) return yield* new AppError({ code: "routine_running" })
          yield* start(r)
          changed(r.server_id)
        })

      yield* Effect.forkDetach(
        Effect.forever(
          Effect.sleep(TICK_MS).pipe(Effect.andThen(Effect.suspend(() => tick(Date.now())))),
        ),
      )

      return Routines.of({
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<Row>(`${SELECT} WHERE r.server_id = ? ORDER BY r.created_at`, serverId)
              .map(toRoutine),
          ),
        create: (input, options) =>
          Effect.gen(function* () {
            yield* checkInput(input.agentId, input.schedule as Schedule, input.place)
            const id = randomUUID()
            const now = Date.now()
            db.run(
              `INSERT INTO routine (id, server_id, agent_id, name, prompt, schedule, channel_id, enabled, last_checked_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              input.serverId,
              input.agentId,
              input.name.trim(),
              input.prompt,
              JSON.stringify(input.schedule),
              input.place.kind === "channel" ? input.place.channelId : null,
              options?.paused ? 0 : 1,
              now,
              now,
              now,
            )
            changed(input.serverId)
            return toRoutine(row(id) as Row)
          }),
        update: (id, patch) =>
          Effect.gen(function* () {
            const current = row(id)
            if (!current) return yield* new AppError({ code: "routine_not_found" })
            const schedule = (patch.schedule ?? JSON.parse(current.schedule)) as Schedule
            const place = patch.place ?? placeOf(current)
            const agentId = patch.agentId ?? current.agent_id
            yield* checkInput(agentId, schedule, place)
            const now = Date.now()
            db.run(
              `UPDATE routine SET agent_id = ?, name = ?, prompt = ?, schedule = ?, channel_id = ?, enabled = ?,
                 last_checked_at = ?, updated_at = ? WHERE id = ?`,
              agentId,
              patch.name?.trim() ?? current.name,
              patch.prompt ?? current.prompt,
              JSON.stringify(schedule),
              place.kind === "channel" ? place.channelId : null,
              patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
              // Resuming or changing the schedule starts the check from now: nothing counts as missed.
              now,
              now,
              id,
            )
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
              }>(
                `SELECT id, state, created_at FROM task WHERE source = 'routine' AND source_id = ?
                 AND created_at BETWEEN ? AND ?`,
                r.id,
                from,
                to,
              )
              for (const t of done)
                out.push({
                  routineId: r.id,
                  routineName: r.name,
                  at: t.created_at,
                  state: t.state,
                  taskId: t.id,
                })
              for (const s of db.all<{ at: number; kind: "missed" | "skipped" }>(
                "SELECT at, kind FROM routine_skip WHERE routine_id = ? AND at BETWEEN ? AND ?",
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
                })
              if (r.enabled === 1 && r.runs_on === null)
                for (const at of runTimes(
                  JSON.parse(r.schedule) as Schedule,
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
