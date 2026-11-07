import type { QuietTurn } from "@robot/shared"

/**
 * The quiet line (spec 005, "Quiet line"). A turn is quiet when it shows no sign of life for the
 * quiet time. The quiet clock is the clock of the silent limit: it stops, and starts again at 0,
 * when the turn waits for the user, when the user holds the browser, and while a tool step runs.
 *
 * Nothing here is stored. After a restart no turn is quiet.
 */

export interface QuietWatch {
  /** A sign of life, or the end of a stop: the clock starts again at 0. */
  readonly beat: () => void
  /** The clock stops while `held` is true (a wait for the user, a tool step). */
  readonly set: (held: boolean) => void
  /** The turn ended. */
  readonly stop: () => void
}

export interface QuietChange {
  readonly taskId: string
  readonly workflowId: string
  readonly name: string
  /** The seconds on the quiet clock now, or null when the turn is not quiet any more. */
  readonly seconds: number | null
}

interface Entry {
  readonly workflowId: string
  readonly name: string
  /** The monotonic time (ms) at which the quiet line showed, or null while the turn is not quiet. */
  quietAt: number | null
  quietMs: number
}

export class QuietClock {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly emit: (change: QuietChange) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Starts to watch one turn. `quietMs` is the quiet time. */
  watch(
    taskId: string,
    options: { workflowId: string; name: string; quietMs: number },
  ): QuietWatch {
    const entry: Entry = {
      workflowId: options.workflowId,
      name: options.name,
      quietAt: null,
      quietMs: options.quietMs,
    }
    this.entries.set(taskId, entry)
    let held = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const end = () => {
      if (entry.quietAt === null) return
      entry.quietAt = null
      this.emit({ taskId, workflowId: entry.workflowId, name: entry.name, seconds: null })
    }
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = null
      end()
      if (held) return
      timer = setTimeout(() => {
        timer = null
        entry.quietAt = this.now()
        this.emit({
          taskId,
          workflowId: entry.workflowId,
          name: entry.name,
          seconds: Math.floor(entry.quietMs / 1000),
        })
      }, entry.quietMs)
      timer.unref?.()
    }
    arm()
    return {
      beat: arm,
      set: (value) => {
        held = value
        arm()
      },
      stop: () => {
        if (timer) clearTimeout(timer)
        timer = null
        end()
        this.entries.delete(taskId)
      },
    }
  }

  /** The turns that are quiet now. */
  turns(): QuietTurn[] {
    const now = this.now()
    const out: QuietTurn[] = []
    for (const [taskId, e] of this.entries) {
      if (e.quietAt === null) continue
      out.push({
        taskId,
        workflowId: e.workflowId,
        name: e.name,
        seconds: Math.floor(e.quietMs / 1000) + Math.max(0, Math.floor((now - e.quietAt) / 1000)),
      })
    }
    return out
  }

  get(taskId: string): QuietTurn | undefined {
    return this.turns().find((t) => t.taskId === taskId)
  }
}
