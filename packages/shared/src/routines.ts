import { Schema } from "effect"
import { AgentModel } from "./agents.ts"
import { EVERY_MIN_MINUTES, type RoutineEntryState, type Schedule } from "./schedule.ts"
import type { TaskUsage } from "./taskUsage.ts"
import { TOKEN_LIMIT_MAX, TOKEN_LIMIT_MIN } from "./taskUsage.ts"
import { type Watch, WatchSchema } from "./watch.ts"

export const ROUTINE_NAME_MAX = 60
export const ROUTINE_PROMPT_MAX = 20_000
/** A server holds at most this many routines. A paused routine counts (spec 009). */
export const ROUTINES_MAX = 50

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

/** The token limit of a routine: a whole number from 1000 to 10000000, or null for no limit (spec 009). */
const TokenLimit = Schema.NullOr(
  Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(TOKEN_LIMIT_MIN),
    Schema.isLessThanOrEqualTo(TOKEN_LIMIT_MAX),
  ),
)

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
  /** A routine has one trigger: a schedule or a watch, never both (spec 009). */
  schedule: Schema.optionalKey(ScheduleSchema),
  watch: Schema.optionalKey(WatchSchema),
  place: RoutinePlace,
  /** The model and effort of the routine. Absent or null: "Same as the agent". */
  model: Schema.optionalKey(Schema.NullOr(AgentModel)),
  /** The most tokens that one run may use. Absent or null: no limit (spec 009). */
  tokenLimit: Schema.optionalKey(TokenLimit),
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
  /** A schedule replaces a watch, and a watch replaces a schedule. */
  schedule: Schema.optionalKey(ScheduleSchema),
  watch: Schema.optionalKey(WatchSchema),
  place: Schema.optionalKey(RoutinePlace),
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NullOr(AgentModel)),
  tokenLimit: Schema.optionalKey(TokenLimit),
})
export type RoutinePatch = typeof RoutinePatch.Type

export interface Routine {
  readonly id: string
  readonly serverId: string
  readonly agentId: string
  readonly agentName: string
  readonly name: string
  readonly prompt: string
  /** The schedule, or null for a watch. */
  readonly schedule: Schedule | null
  /** The watch, or null for a schedule. */
  readonly watch: Watch | null
  /** The model and effort of the routine, or null for "Same as the agent". */
  readonly model: AgentModel | null
  /** The most tokens that one run may use, or null for no limit (spec 009). */
  readonly tokenLimit: number | null
  readonly place: RoutinePlace
  readonly enabled: boolean
  readonly createdAt: number
  /** The next three run times. Empty when paused or finished, and for a watch. */
  readonly nextRuns: readonly number[]
  /** For a watch that is on and runs here: the time of the next check. */
  readonly nextCheck: number | null
  /** Set when the routine paused itself after 3 failed runs: the reason of the last failure. */
  readonly pausedAfterFailures: RoutineFailure | null
  /** The name of the other computer where it runs, when it syncs (019). Null: it runs here. */
  readonly runsOn: string | null
}

/** One run in the calendar: past, present or planned. */
export interface RoutineEntry {
  readonly routineId: string
  readonly routineName: string
  readonly at: number
  readonly state: RoutineEntryState
  readonly taskId: string | null
  /** For a failed check or a run that could not start: why. */
  readonly reason?: RoutineFailure | null
  /** For a run "Recorded" of a watch with "Record only": the change that it saw. */
  readonly change?: string
  /**
   * The run details (spec 005, 009): the tokens of all tasks of the run. Only a run that made a
   * task has them, and only when a task reported something.
   */
  readonly usage?: TaskUsage
  /**
   * For a run with a token limit: the limit, and whether the run used 80 percent of it. The
   * limit is the one that the run started with.
   */
  readonly limit?: { readonly tokens: number; readonly near: boolean }
}

/** Why a run or a check failed: an error code and a detail. */
export interface RoutineFailure {
  readonly code: string
  readonly detail: string
}

/** A routine pauses itself after this many failed runs in a row (spec 009). */
export const ROUTINE_FAILURES_MAX = 3
