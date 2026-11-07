import { type QueueSource, queueRank } from "@robot/shared"

/**
 * The queue and the slots of the tasks (spec 005, "Queue" and "Rules"). It holds no database and
 * no time: it only decides which waiting task starts, so a test can drive it with plain calls.
 *
 * - At most `capacity()` tasks run at the same time. A task that waits for the user uses no slot.
 * - One workflow runs one task at a time, and one run at a time. A workflow is held by a run from
 *   the start of its first task to the end of the run: also while a task waits for the user, and
 *   between two nodes of the run. So the runs of one workflow do not interleave. The slot is per
 *   task, as before: a run between two nodes uses no slot.
 * - The tasks that wait start in this order: a task that went on after a wait for the user, the
 *   picks of "Run next" (the latest first), the runs of the user (the oldest first), the runs of
 *   a trigger (the oldest first), a memory check. A task whose workflow is held keeps its place.
 */

export interface TaskTicket {
  readonly taskId: string
  readonly workflowId: string
  readonly runId: string
  readonly source: QueueSource
  /** The order in which runs were made: a lower number is older. */
  readonly runSeq: number
  /** What "behind" lines show: the node of this task. */
  readonly nodeNumber: number
  readonly nodeName: string
  readonly runStartedAt: number
}

interface Waiting {
  readonly ticket: TaskTicket
  readonly seq: number
  resumed: boolean
  pickedSeq: number | null
  grant: () => void
  fail: (error: Error) => void
  cleanup: () => void
}

/** Why a waiting task waits (spec 005, "States and reasons"). */
export type WaitReason =
  | { readonly kind: "behind"; readonly holder: TaskTicket }
  | { readonly kind: "slot" }

export class TaskScheduler {
  private readonly waiting: Waiting[] = []
  private readonly running = new Set<string>()
  /**
   * The run that holds each workflow, and the last task of that run that started (the line "Waits
   * behind <node>" names it). A hold lasts until `endRun`.
   */
  private readonly held = new Map<string, { readonly runId: string; ticket: TaskTicket }>()
  private readonly known = new Map<string, TaskTicket>()
  private counter = 0
  private pumping = false
  private listener: (() => void) | undefined

  constructor(private readonly capacity: () => number) {}

  /** Called after the order, a hold or a slot changed (a place to refresh the reasons). */
  onChange(listener: () => void) {
    this.listener = listener
  }

  /**
   * A task joins the queue. The promise resolves when the task may start; it rejects when the
   * signal aborts first. `granted` is true when the task may start at once.
   */
  enter(ticket: TaskTicket, signal?: AbortSignal): { granted: boolean; ready: Promise<void> } {
    this.known.set(ticket.taskId, ticket)
    const ready = this.queue(ticket, false, signal)
    return { granted: this.running.has(ticket.taskId), ready }
  }

  private queue(ticket: TaskTicket, resumed: boolean, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("stopped"))
      const onAbort = () => {
        this.remove(ticket.taskId)
        reject(new Error("stopped"))
        this.pump()
      }
      const waiting: Waiting = {
        ticket,
        seq: ++this.counter,
        resumed,
        pickedSeq: null,
        grant: resolve,
        fail: reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.waiting.push(waiting)
      this.pump()
    })
  }

  private remove(taskId: string) {
    const at = this.waiting.findIndex((w) => w.ticket.taskId === taskId)
    if (at < 0) return
    this.waiting[at]?.cleanup()
    this.waiting.splice(at, 1)
  }

  /** The task waits for the user: it gives up its slot and keeps its workflow held. */
  suspend(taskId: string) {
    if (this.running.delete(taskId)) this.pump()
  }

  /** The user answered: the task needs a slot again, at the front of the order. */
  resume(taskId: string, signal?: AbortSignal): Promise<void> {
    const ticket = this.known.get(taskId)
    if (!ticket) return Promise.resolve()
    return this.queue(ticket, true, signal)
  }

  /**
   * The task ended (or was removed before it started): its slot is free. Its run keeps the
   * workflow held until `endRun`, because the run may enter its next node.
   */
  release(taskId: string) {
    this.remove(taskId)
    this.running.delete(taskId)
    this.known.delete(taskId)
    this.pump()
  }

  /**
   * The run ended, in any way (done, failed, stopped or crashed): its workflow is free. The tasks
   * of the run that still wait are removed too.
   */
  endRun(runId: string) {
    for (const w of this.waiting.filter((o) => o.ticket.runId === runId)) {
      this.remove(w.ticket.taskId)
      this.known.delete(w.ticket.taskId)
      w.fail(new Error("stopped"))
    }
    for (const [workflowId, holder] of this.held)
      if (holder.runId === runId) this.held.delete(workflowId)
    this.pump()
  }

  /**
   * "Run next": the task goes to the front of the picks. It stays behind a task that went on
   * after a wait. It is off for a task that is not waiting (spec 005, "Queue").
   */
  runNext(taskId: string): boolean {
    const waiting = this.waiting.find((w) => w.ticket.taskId === taskId)
    if (!waiting) return false
    waiting.pickedSeq = ++this.counter
    this.pump()
    return true
  }

  /** Removes the waiting tasks of a run and fails their waits. Returns their ids. */
  cancelRun(runId: string): string[] {
    const gone = this.waiting.filter((w) => w.ticket.runId === runId)
    for (const w of gone) {
      w.cleanup()
      this.waiting.splice(this.waiting.indexOf(w), 1)
      w.fail(new Error("stopped"))
    }
    if (gone.length > 0) this.pump()
    return gone.map((w) => w.ticket.taskId)
  }

  /** The workflow is held, or a slot is not free: a new task would wait. */
  wouldWait(workflowId: string): boolean {
    return (
      this.held.has(workflowId) ||
      this.running.size >= this.capacity() ||
      this.waiting.some((w) => w.ticket.workflowId === workflowId)
    )
  }

  /** The number of tasks of a workflow that wait for a start (they count for the limit of 20). */
  queuedCount(workflowId: string): number {
    return this.waiting.filter((w) => w.ticket.workflowId === workflowId).length
  }

  /** Re-reads the capacity: a new number applies at once to the tasks that wait. */
  refresh() {
    this.pump()
  }

  isWaiting(taskId: string): boolean {
    return this.waiting.some((w) => w.ticket.taskId === taskId)
  }

  /** "Run next" is on for a task that waits and did not go on after a wait for the user. */
  canRunNext(taskId: string): boolean {
    const w = this.waiting.find((o) => o.ticket.taskId === taskId)
    return w !== undefined && !w.resumed
  }

  /** Why each waiting task waits. */
  reasons(): Map<string, WaitReason> {
    const out = new Map<string, WaitReason>()
    for (const w of this.waiting) {
      const hold = this.held.get(w.ticket.workflowId)
      const holder = hold && hold.runId !== w.ticket.runId ? hold.ticket : undefined
      out.set(w.ticket.taskId, holder ? { kind: "behind", holder } : { kind: "slot" })
    }
    return out
  }

  private ordered(): Waiting[] {
    return [...this.waiting].sort((a, b) => {
      const ra = queueRank({
        source: a.ticket.source,
        resumed: a.resumed,
        picked: a.pickedSeq !== null,
      })
      const rb = queueRank({
        source: b.ticket.source,
        resumed: b.resumed,
        picked: b.pickedSeq !== null,
      })
      if (ra !== rb) return ra - rb
      // The latest pick of "Run next" starts first.
      if (ra === 1) return (b.pickedSeq ?? 0) - (a.pickedSeq ?? 0)
      if (ra === 0) return a.seq - b.seq
      // The oldest run first, and in one run the task that was made first.
      return a.ticket.runSeq - b.ticket.runSeq || a.seq - b.seq
    })
  }

  private pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        if (this.running.size >= this.capacity()) break
        const next = this.ordered().find((w) => {
          // Another run holds the workflow: this task keeps its place and waits.
          const hold = this.held.get(w.ticket.workflowId)
          if (hold !== undefined && hold.runId !== w.ticket.runId) return false
          // A memory check starts only when its workflow has no other task that runs or waits.
          if (w.ticket.source === "memory")
            return !this.waiting.some((o) => o !== w && o.ticket.workflowId === w.ticket.workflowId)
          return true
        })
        if (!next) break
        this.remove(next.ticket.taskId)
        this.running.add(next.ticket.taskId)
        this.held.set(next.ticket.workflowId, { runId: next.ticket.runId, ticket: next.ticket })
        next.grant()
      }
    } finally {
      this.pumping = false
    }
    this.listener?.()
  }
}
