import type { TaskSource } from "@robot/shared"
import { Deferred, Effect, Exit } from "effect"

/**
 * The place of a task in the order of the queue of its agent (spec 005, "Queue"). A lower rank
 * starts first. Tasks of one rank start in the order in which they asked.
 */
export const rankOf = (source: TaskSource): number =>
  source === "routine" || source === "workflow" ? 1 : 0

interface Waiter {
  readonly rank: number
  readonly seq: number
  readonly ready: Deferred.Deferred<void>
  granted: boolean
}

/**
 * Lets one task of an agent run at a time. When the running task ends, the waiting task with the
 * lowest rank starts, the oldest first. A new task never stops the task that runs.
 */
export class AgentGate {
  private busy = false
  private seq = 0
  private readonly waiters: Waiter[] = []

  /** The number of tasks that wait. */
  get waiting(): number {
    return this.waiters.length
  }

  private release(): void {
    const next = this.waiters.shift()
    if (!next) {
      this.busy = false
      return
    }
    next.granted = true
    Deferred.doneUnsafe(next.ready, Exit.void)
  }

  private take(rank: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.busy) {
        this.busy = true
        return Effect.void
      }
      const waiter: Waiter = {
        rank,
        seq: this.seq++,
        ready: Deferred.makeUnsafe<void>(),
        granted: false,
      }
      const at = this.waiters.findIndex(
        (w) => w.rank > rank || (w.rank === rank && w.seq > waiter.seq),
      )
      if (at === -1) this.waiters.push(waiter)
      else this.waiters.splice(at, 0, waiter)
      return Deferred.await(waiter.ready).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            // A stop while the task waits: it leaves the queue. If it got the turn in the same
            // moment, the turn goes to the next task.
            if (waiter.granted) return this.release()
            const i = this.waiters.indexOf(waiter)
            if (i !== -1) this.waiters.splice(i, 1)
          }),
        ),
      )
    })
  }

  /** Runs `work` when it is the turn of this task. */
  run<A, E, R>(rank: number, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      restore(this.take(rank)).pipe(
        Effect.flatMap(() =>
          restore(work).pipe(Effect.ensuring(Effect.sync(() => this.release()))),
        ),
      ),
    )
  }
}
