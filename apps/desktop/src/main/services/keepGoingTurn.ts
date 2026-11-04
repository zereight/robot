import { KEEP_GOING_MAX, type ListedStep, nextKeepGoing } from "@robot/shared"
import { Effect } from "effect"

export interface KeepGoingTurn<A, E, R> {
  /** The setting "Keep going on open steps" (013). It is read when a turn ends. */
  readonly enabled: Effect.Effect<boolean>
  /**
   * Runs one turn of the reply, with its backup model when it needs one. It is null for the first
   * turn. For a continuation it holds the open steps that the turn answers.
   */
  readonly run: (go: readonly string[] | null) => Effect.Effect<A, E, R>
  /** The last list of steps that the program reported in this task. Null when it reported none. */
  readonly plan: () => readonly ListedStep[] | null
  /** True when the reply so far ends with a last line "Blocked:" (spec 005). */
  readonly blocked: () => boolean
  /** True when a card of the reply waits for the user. */
  readonly waiting: () => boolean
  /** The app asks the agent to go on: the caller writes the muted line "Kept going (n of 8)". */
  readonly note: (n: number) => void
}

/**
 * Runs a turn, and runs it again while the rule of "Keep going" says so (spec 005). A turn that
 * ends in an error, a Stop or the step limit never reaches the loop: its failure, or the
 * interrupt of the fiber, leaves at once. A turn that ends with a "Blocked:" line or a waiting
 * card ends the task without a continuation.
 *
 * All turns belong to one task and one reply. The caller reads `plan` as the turns report it, so
 * the decision comes from the list and never from the words of a reply.
 */
export const withKeepGoing = <A, E, R>(o: KeepGoingTurn<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    let result = yield* o.run(null)
    let count = 0
    let previous: readonly string[] | null = null
    for (;;) {
      const open = nextKeepGoing({
        enabled: yield* o.enabled,
        plan: o.plan(),
        blocked: o.blocked(),
        waiting: o.waiting(),
        count,
        previous,
      })
      if (open === null) break
      count += 1
      previous = open
      o.note(count)
      result = yield* o.run(open)
    }
    return result
  })

/** The limit, for the line "Kept going (n of 8)". */
export const KEEP_GOING_OF = KEEP_GOING_MAX
