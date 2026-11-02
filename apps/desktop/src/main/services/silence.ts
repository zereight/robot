import { silentFailure, type TaskProgress } from "@robot/shared"
import { Deferred, Effect } from "effect"
import type { AgentEvent } from "../providers/agent.ts"
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

/** How often the watch looks at the clock. */
export const TICK_MS = 1000
/** A tick later than this after the one before means the computer slept. One tick counts. */
export const SLEEP_GAP_MS = 5000

export interface SilenceTimerOptions {
  readonly limitMs: number
  readonly clock: Clock
  /** Called once, when the limit is reached. */
  readonly onSilent: () => void
  /** True while the user holds the browser of the agent (spec 007). Asked at each tick. */
  readonly userHoldsBrowser?: () => boolean
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
    this.last = this.options.clock.now()
  }

  /** The clock stops, for example while a tool step runs. Holds with other keys add up. */
  hold(key: string) {
    this.holds.add(key)
    this.elapsed = 0
  }

  /** The hold ends. When no hold is left the clock starts again at 0. */
  release(key: string) {
    if (!this.holds.delete(key)) return
    this.elapsed = 0
    this.last = this.options.clock.now()
  }

  /** The turn is over. */
  stop() {
    this.done = true
    this.stopTicking?.()
    this.stopTicking = undefined
    this.holds.clear()
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
    if (this.holds.size > 0 || this.options.userHoldsBrowser?.()) {
      this.elapsed = 0
      return
    }
    this.elapsed += gap > SLEEP_GAP_MS ? TICK_MS : gap
    if (this.elapsed >= this.options.limitMs) {
      this.stop()
      this.options.onSilent()
    }
  }
}

/** What a turn does with the watch. */
export interface TurnWatch {
  /** The app hands the request over: the progress is "sent" and the clock starts. */
  handedOver(): void
  /** Something came back from the model or the program: a sign of life. */
  sense(event: AgentEvent): void
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
  readonly userHoldsBrowser?: () => boolean
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
  const timer = never
    ? undefined
    : new SilenceTimer({
        limitMs: options.limitMinutes * 60_000,
        clock: options.clock ?? testClock ?? realClock,
        onSilent: () => {
          Deferred.doneUnsafe(fired, Effect.fail(new AppError(failure)))
        },
        ...(options.userHoldsBrowser ? { userHoldsBrowser: options.userHoldsBrowser } : {}),
      })
  return {
    handedOver: () => {
      options.progress("sent")
      timer?.start()
    },
    sense: (event) => {
      // The count of tokens is not a sign of life: it says nothing about the work.
      if (event.type === "usage") return
      options.progress("started")
      timer?.alive()
      if (event.type !== "tool") return
      if (event.state === "running") timer?.hold(`tool:${event.call.id}`)
      else timer?.release(`tool:${event.call.id}`)
    },
    waiting: (on) => {
      if (on) {
        options.progress("started")
        timer?.hold("user")
      } else {
        timer?.release("user")
      }
    },
    silent: never ? Effect.never : Deferred.await(fired),
    stop: () => timer?.stop(),
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
