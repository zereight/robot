import { Schema } from "effect"
import { EVERY_MIN_MINUTES, type RoutineEntryState, type Schedule } from "./schedule.ts"

export const ROUTINE_NAME_MAX = 60
export const ROUTINE_PROMPT_MAX = 20_000

const Time = Schema.String.check(Schema.isPattern(/^\d{1,2}:\d{2}$/))

export const ScheduleSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("every"),
    minutes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(EVERY_MIN_MINUTES)),
    from: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("daily"), times: Schema.Array(Time) }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    days: Schema.Array(Schema.Number.check(Schema.isInt())),
    time: Time,
  }),
  Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String }),
])

export const RoutinePlace = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent") }),
  Schema.Struct({ kind: Schema.Literal("channel"), channelId: Schema.String }),
])
export type RoutinePlace = typeof RoutinePlace.Type

export const RoutineInput = Schema.Struct({
  serverId: Schema.String,
  agentId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ROUTINE_NAME_MAX)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ROUTINE_PROMPT_MAX)),
  schedule: ScheduleSchema,
  place: RoutinePlace,
})
export type RoutineInput = typeof RoutineInput.Type

export const RoutinePatch = Schema.Struct({
  agentId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ROUTINE_NAME_MAX)),
  ),
  prompt: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ROUTINE_PROMPT_MAX)),
  ),
  schedule: Schema.optionalKey(ScheduleSchema),
  place: Schema.optionalKey(RoutinePlace),
  enabled: Schema.optionalKey(Schema.Boolean),
})
export type RoutinePatch = typeof RoutinePatch.Type

export interface Routine {
  readonly id: string
  readonly serverId: string
  readonly agentId: string
  readonly agentName: string
  readonly name: string
  readonly prompt: string
  readonly schedule: Schedule
  readonly place: RoutinePlace
  readonly enabled: boolean
  readonly createdAt: number
  /** The next three run times. Empty when paused or finished. */
  readonly nextRuns: readonly number[]
  /** The name of the other computer where it runs, when it syncs (016). Null: it runs here. */
  readonly runsOn: string | null
}

/** One run in the calendar: past, present or planned. */
export interface RoutineEntry {
  readonly routineId: string
  readonly routineName: string
  readonly at: number
  readonly state: RoutineEntryState
  readonly taskId: string | null
}
