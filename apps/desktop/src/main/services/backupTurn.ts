import { type AgentModel, holdEnd } from "@robot/shared"
import { Cause, Effect, Exit } from "effect"
import { ProviderFailure } from "../providers/client.ts"
import { holdClock, type ModelHoldsService } from "./ModelHolds.ts"

/**
 * One try of a turn (spec 006, "Backup model"): the first one on the model that starts the turn;
 * "start" on the backup model, with the request from the start; "goOn" on the backup model, with
 * the work so far and a short message that asks it to go on.
 */
export type Attempt = "first" | "start" | "goOn"

export interface BackupTurn<A, E, R> {
  readonly agentId: string
  readonly holds: ModelHoldsService
  /**
   * The backup model of the agent, or null when the turn must not use one: the agent has none, or
   * the turn runs on a model of its own, as a routine does (spec 009).
   */
  readonly backup: AgentModel | null
  /** True when the turn started on the backup model, because the hold lasts. */
  readonly onBackup: boolean
  /** Whether the backup is ready on this computer (spec 006). */
  readonly ready: (backup: AgentModel) => Effect.Effect<boolean>
  /** Runs one try. */
  readonly run: (attempt: Attempt) => Effect.Effect<A, E, R>
  /** True when the try that failed got a sign back: it ran steps ("Started"). */
  readonly started: () => boolean
  /**
   * The backup takes over. The caller ends the open steps of the first try, writes the muted line
   * when `fresh`, and points the reply at the backup model. `resetsAt` is the reset time that the
   * provider named, when it is in the future.
   */
  readonly switchTo: (info: {
    readonly backup: AgentModel
    readonly fresh: boolean
    readonly resetsAt: number | null
  }) => void
}

/**
 * Runs a turn. It starts on the model that the agent has now. When that is the main model and it
 * fails with a limit reason, and the backup is ready, the main model is held until the reset time
 * and the turn goes on with the backup, in the same task. Any other failure, and a limit of the
 * backup itself, fails the turn as it does with no backup.
 */
export const withBackup = <A, E, R>(o: BackupTurn<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const tried = yield* Effect.exit(o.run("first"))
    if (Exit.isSuccess(tried)) {
      // The main model answered: a limit that the user ended by hand is over (spec 006).
      if (o.backup && !o.onBackup && o.holds.stored(o.agentId)?.released) o.holds.clear(o.agentId)
      return tried.value
    }
    const failure = Cause.squash(tried.cause)
    if (
      !o.backup ||
      o.onBackup ||
      Cause.hasInterruptsOnly(tried.cause) ||
      !(failure instanceof ProviderFailure) ||
      failure.code !== "provider_limit" ||
      !(yield* o.ready(o.backup))
    )
      return yield* Effect.failCause(tried.cause)
    const now = holdClock.now()
    const { fresh } = o.holds.start(o.agentId, holdEnd(now, failure.resetsAt))
    // The failed try ran steps ("Started") or not ("Not sent", "Sent"): the backup goes on with a
    // short message, or runs the request from the start. The request is not sent again after a
    // step ran, so no side effect repeats.
    const attempt: Attempt = o.started() ? "goOn" : "start"
    o.switchTo({
      backup: o.backup,
      fresh,
      resetsAt: failure.resetsAt !== undefined && failure.resetsAt > now ? failure.resetsAt : null,
    })
    return yield* o.run(attempt)
  })
