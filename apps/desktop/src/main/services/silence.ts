import {
  type QuietTurn,
  quietTimeMs,
  silentFailure,
  type TaskProgress,
  type TaskSource,
} from "@robot/shared"
import { Deferred, Effect } from "effect"
import type { AgentEvent } from "../providers/agent.ts"
import type { ActivityService } from "./Activity.ts"
import { AppError } from "./errors.ts"

/**
 * The silent limit of a turn (spec 005, "Silent turns"). A turn is silent when the model or the
 * program of the vendor shows no sign of life for as long as the limit.
 *
 * The clock is a count of ticks, not a difference of two times. A tick that comes much later than
 * it should (the computer slept) adds one tick only, so the time of the sleep does not count.
 */

/** What the watch needs from time. A test gives a clock that it moves by hand. */
export interface Clock {
  now(): number
  /** Calls `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms)
    // A watch must never keep the app open.
    timer.unref?.()
    return () => clearInterval(timer)
  },
}

/** The most chases of one turn (spec 007, "Chase"). */
export const CHASE_MAX = 3

/**
 * What the giver of a piece of work says to its worker when the work has stayed quiet for the
 * chase time (spec 007).
 */
export const CHASE_WORDS =
  "Nothing has happened in your work for a while. Reply in one short line: the state of the work and your next step. Then go on with the work."

/** How often the watch looks at the clock. */
export const TICK_MS = 1000
/** A tick later than this after the one before means the computer slept. One tick counts. */
export const SLEEP_GAP_MS = 5000

export interface SilenceTimerOptions {
  /** `Infinity` for the choice "Never": the clock counts, and the turn does not fail by itself. */
  readonly limitMs: number
  /** The quiet time (spec 005, "Quiet line"). The quiet clock is this same clock. */
  readonly quietMs: number
  readonly clock: Clock
  /** Called once, when the limit is reached. */
  readonly onSilent: () => void
  /**
   * Called with the seconds on the clock when the turn becomes quiet, again when the computer
   * wakes while the turn is quiet (so a client counts from the right value), and with null when
   * the turn is not quiet any more.
   */
  readonly onQuiet?: (seconds: number | null) => void
  /** True while the user holds the browser of the agent (spec 007). Asked at each tick. */
  readonly userHoldsBrowser?: () => boolean
  /**
   * The chase time in ms (spec 004, 007). 0 or absent: no chase. The chase clock counts the time
   * with no sign of life, and it goes on while a tool step runs: a step that runs for long and
   * shows nothing is quiet work. It stops while the turn waits for the user or the user holds the
   * browser.
   */
  readonly chaseMs?: number
  /** Called with 1, 2 and 3 each time the chase time passes, and never more than CHASE_MAX times. */
  readonly onChase?: (n: number) => void
}

/**
 * Counts the time without a sign of life. `alive` starts the count again at 0. While a hold is on
 * (the turn waits for the user, a tool step runs), or while the user holds the browser, the count
 * stays at 0, so it starts at 0 when the stop ends.
 */
export class SilenceTimer {
  private elapsed = 0
  private last = 0
  private readonly holds = new Set<string>()
  private stopTicking: (() => void) | undefined
  private done = false
  private quiet = false
  private idle = 0
  private chases = 0

  constructor(private readonly options: SilenceTimerOptions) {}

  /** The request was handed over: the clock starts at 0. */
  start() {
    if (this.stopTicking || this.done) return
    this.elapsed = 0
    this.last = this.options.clock.now()
    this.stopTicking = this.options.clock.every(TICK_MS, () => this.tick())
  }

  /** A sign of life. */
  alive() {
    this.elapsed = 0
    this.idle = 0
    this.last = this.options.clock.now()
    this.endQuiet()
  }

  /** The clock stops, for example while a tool step runs. Holds with other keys add up. */
  hold(key: string) {
    this.holds.add(key)
    this.elapsed = 0
    this.idle = 0
    this.endQuiet()
  }

  /** The hold ends. When no hold is left the clock starts again at 0. */
  release(key: string) {
    if (!this.holds.delete(key)) return
    this.elapsed = 0
    this.idle = 0
    this.last = this.options.clock.now()
    this.endQuiet()
  }

  /** The turn is over. */
  stop() {
    this.done = true
    this.stopTicking?.()
    this.stopTicking = undefined
    this.holds.clear()
    this.endQuiet()
  }

  /** True while the turn is quiet. For tests. */
  get isQuiet() {
    return this.quiet
  }

  /** Counts the time with no sign of life, and calls `onChase` each time the chase time passes. */
  private chaseTick(gap: number) {
    const { chaseMs, onChase } = this.options
    if (!chaseMs || !onChase || this.chases >= CHASE_MAX) return
    // The user decides how long these take, so they do not count.
    if (this.holds.has("user") || this.options.userHoldsBrowser?.()) return
    this.idle += gap > SLEEP_GAP_MS ? TICK_MS : gap
    if (this.idle < chaseMs) return
    this.idle = 0
    this.chases++
    onChase(this.chases)
  }

  private endQuiet() {
    if (!this.quiet) return
    this.quiet = false
    this.options.onQuiet?.(null)
  }

  /** Time without a sign of life, in ms. For tests. */
  get silentFor() {
    return this.elapsed
  }

  private tick() {
    if (this.done) return
    const now = this.options.clock.now()
    const gap = Math.max(0, now - this.last)
    this.last = now
    this.chaseTick(gap)
    if (this.holds.size > 0 || this.options.userHoldsBrowser?.()) {
      this.elapsed = 0
      this.endQuiet()
      return
    }
    const slept = gap > SLEEP_GAP_MS
    this.elapsed += slept ? TICK_MS : gap
    if (this.elapsed >= this.options.limitMs) {
      this.stop()
      this.options.onSilent()
      return
    }
    if (!this.quiet && this.elapsed >= this.options.quietMs) {
      this.quiet = true
      this.options.onQuiet?.(Math.floor(this.elapsed / 1000))
    } else if (this.quiet && slept) {
      // The sleep did not count: a client that counted on by its own clock must start again.
      this.options.onQuiet?.(Math.floor(this.elapsed / 1000))
    }
  }
}

/** What a turn does with the watch. */
export interface TurnWatch {
  /** The app hands the request over: the progress is "sent" and the clock starts. */
  handedOver(): void
  /** Something came back from the model or the program: a sign of life. */
  sense(event: AgentEvent): void
  /**
   * A sign of life that is not a part of the reply: the wait for a busy provider, and the start of
   * the new try (spec 006). The progress stays as it was, because no step has run.
   */
  pulse(): void
  /** The turn waits for the user (an approval or a question), or goes on. */
  waiting(on: boolean): void
  /**
   * Never ends while the turn is not silent. It fails with the reason of the silent limit when
   * it is. Race it with the work of the turn: the work then stops like after a Stop.
   */
  readonly silent: Effect.Effect<never, AppError>
  /** The turn is over. */
  stop(): void
}

export interface TurnWatchOptions {
  /** The silent limit in minutes. 0 means never. */
  readonly limitMinutes: number
  /** Called when the progress of the turn goes up. */
  readonly progress: (progress: TaskProgress) => void
  /**
   * The turn becomes quiet (the seconds on the quiet clock), or is not quiet any more (null). See
   * `SilenceTimerOptions`. The quiet time is 90 seconds, or half of the limit when that is shorter.
   */
  readonly onQuiet?: (seconds: number | null) => void
  readonly userHoldsBrowser?: () => boolean
  /** The chase time in minutes (spec 013), and the call for each chase. 0 or absent: no chase. */
  readonly chaseMinutes?: number
  readonly onChase?: (n: number) => void
  readonly clock?: Clock
}

/** A test can replace the clock of every watch. The app never does. */
let testClock: Clock | undefined
export const useClockForTests = (clock: Clock | undefined) => {
  testClock = clock
}

export const turnWatch = (options: TurnWatchOptions): TurnWatch => {
  const never = options.limitMinutes <= 0
  const fired = Deferred.makeUnsafe<never, AppError>()
  const failure = silentFailure(options.limitMinutes)
  // With the choice "Never" the clock still counts, for the quiet line (spec 005).
  const timer = new SilenceTimer({
    limitMs: never ? Number.POSITIVE_INFINITY : options.limitMinutes * 60_000,
    quietMs: quietTimeMs(options.limitMinutes),
    clock: options.clock ?? testClock ?? realClock,
    onSilent: () => {
      Deferred.doneUnsafe(fired, Effect.fail(new AppError(failure)))
    },
    ...(options.onQuiet ? { onQuiet: options.onQuiet } : {}),
    ...(options.userHoldsBrowser ? { userHoldsBrowser: options.userHoldsBrowser } : {}),
    ...(options.onChase && options.chaseMinutes
      ? { chaseMs: options.chaseMinutes * 60_000, onChase: options.onChase }
      : {}),
  })
  return {
    handedOver: () => {
      options.progress("sent")
      timer.start()
    },
    sense: (event) => {
      // The count of tokens is not a sign of life: it says nothing about the work.
      if (event.type === "usage" || event.type === "spent") return
      options.progress("started")
      timer.alive()
      if (event.type !== "tool") return
      if (event.state === "running") timer.hold(`tool:${event.call.id}`)
      else timer.release(`tool:${event.call.id}`)
    },
    pulse: () => timer.alive(),
    waiting: (on) => {
      if (on) {
        options.progress("started")
        timer.hold("user")
      } else {
        timer.release("user")
      }
    },
    silent: never ? Effect.never : Deferred.await(fired),
    stop: () => timer.stop(),
  }
}

/**
 * The events of a turn, for `Stream.fromAsyncIterable`. The first read is the moment when the
 * app hands the request over. Closing the stream aborts first: the generator may wait in a tool
 * and cannot end before.
 */
export const closing = (
  events: AsyncIterable<AgentEvent>,
  controller: AbortController,
  watch: TurnWatch,
): AsyncIterable<AgentEvent> => ({
  [Symbol.asyncIterator]: () => {
    const it = events[Symbol.asyncIterator]()
    let first = true
    return {
      next: () => {
        if (first) {
          first = false
          watch.handedOver()
        }
        return it.next()
      },
      return: (value?: unknown) => {
        controller.abort()
        return it.return?.(value) ?? Promise.resolve({ done: true, value: undefined })
      },
    }
  },
})

/** Where a turn belongs: what the places that show the quiet line need to find it. */
export interface QuietPlace {
  readonly taskId: string
  readonly agentId: string
  readonly threadId: string | null
  readonly source: TaskSource
  readonly sourceId: string | null
}

/**
 * The `onQuiet` of a turn: it tells `Activity` that the turn is quiet or not. `name` is asked
 * when the turn becomes quiet, because the turn can go on with the backup model (spec 006).
 */
export const quietReporter =
  (activity: ActivityService, place: QuietPlace, name: () => string) =>
  (seconds: number | null): void => {
    const turn: Omit<QuietTurn, "seconds"> = {
      ...place,
      name: seconds === null ? "" : name(),
    }
    activity.setQuiet(turn, seconds)
  }
