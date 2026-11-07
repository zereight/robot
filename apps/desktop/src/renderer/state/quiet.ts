import { formatClock } from "@robot/shared"
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js"

/**
 * The turns that are quiet now (spec 005, "Quiet line"). The main process tells when a turn
 * becomes quiet, with the seconds on its quiet clock, and when it goes on again. The window counts
 * on from there, once each second, with a clock that does not run while the computer sleeps.
 * Nothing is stored: after a restart no turn is quiet.
 */
interface Held {
  readonly name: string
  readonly seconds: number
  /** When the window got the value, on the clock of the window. */
  readonly at: number
}

const [held, setHeld] = createSignal<ReadonlyMap<string, Held>>(new Map())
const [now, setNow] = createSignal(performance.now())
let started = false

const put = (taskId: string, value: Held | null) => {
  const next = new Map(held())
  if (value) next.set(taskId, value)
  else next.delete(taskId)
  setHeld(next)
}

/** Listens once. The window calls it at start, and a view that reads the state does too. */
export const startQuiet = () => {
  if (started || typeof window === "undefined" || !window.robot) return
  started = true
  createRoot(() => {
    // Listen first, then read once: a change that came meanwhile is newer than the read.
    const pushed = new Set<string>()
    window.robot.on("tasks.quiet", (change) => {
      pushed.add(change.taskId)
      put(
        change.taskId,
        change.seconds === null
          ? null
          : { name: change.name, seconds: change.seconds, at: performance.now() },
      )
    })
    void window.robot
      .invoke("tasks.quiet", undefined)
      .then((result) => {
        if (!result.ok) return
        for (const turn of result.value)
          if (!pushed.has(turn.taskId))
            put(turn.taskId, { name: turn.name, seconds: turn.seconds, at: performance.now() })
      })
      .catch(() => {})
    // One timer for the whole window, and only while some turn is quiet.
    createEffect(() => {
      if (held().size === 0) return
      setNow(performance.now())
      const timer = setInterval(() => setNow(performance.now()), 1000)
      onCleanup(() => clearInterval(timer))
    })
  })
}

/** The quiet line of the turn of one task: its name and the time as m:ss. Reactive. */
export const quietOfTask = (taskId: string | null | undefined) => {
  startQuiet()
  const entry = taskId ? held().get(taskId) : undefined
  if (!entry) return undefined
  const seconds = entry.seconds + Math.max(0, Math.floor((now() - entry.at) / 1000))
  return { name: entry.name, time: formatClock(seconds) }
}
