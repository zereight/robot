import { describe, expect, test } from "bun:test"
import type { QueueSource } from "@robot/shared"
import { TaskScheduler, type TaskTicket } from "./taskScheduler.ts"

// The queue and the slots of the tasks (spec 005, "Queue" and "Rules"). The scheduler holds no
// database and no time, so these tests drive it with plain calls.

let seq = 0
const ticket = (
  workflowId: string,
  source: QueueSource = "hand",
  runSeq = ++seq,
  taskId = `t${++seq}`,
): TaskTicket => ({
  taskId,
  workflowId,
  runId: `run-${runSeq}`,
  source,
  runSeq,
  nodeNumber: 1,
  nodeName: `Node of ${workflowId}`,
  runStartedAt: runSeq,
})

/** A scheduler with a capacity that a test can change, and the order in which tasks started. */
const make = (capacity = 1) => {
  const cap = { n: capacity }
  const s = new TaskScheduler(() => cap.n)
  const started: string[] = []
  const runOf = new Map<string, string>()
  /** The task and its run end together (a run of one node). */
  const finish = (taskId: string) => {
    s.release(taskId)
    const runId = runOf.get(taskId)
    if (runId) s.endRun(runId)
  }
  const enter = (t: TaskTicket, signal?: AbortSignal) => {
    runOf.set(t.taskId, t.runId)
    const place = s.enter(t, signal)
    void place.ready.then(
      () => started.push(t.taskId),
      () => {},
    )
    return place
  }
  return { s, cap, started, enter, finish }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("the order of the queue (spec 005, Queue)", () => {
  test("a run of the user starts before a run of a trigger, although the trigger came first", async () => {
    const { s, started, enter, finish } = make(1)
    enter(ticket("w", "hand", 1, "running"))
    enter(ticket("w", "schedule", 2, "schedule-1"))
    enter(ticket("w", "hand", 3, "hand-1"))
    enter(ticket("w", "schedule", 4, "schedule-2"))
    enter(ticket("w", "memory", 5, "memory"))
    for (const id of ["running", "hand-1", "schedule-1", "schedule-2"]) {
      await flush()
      finish(id)
    }
    await flush()
    expect(started).toEqual(["running", "hand-1", "schedule-1", "schedule-2", "memory"])
  })

  test("the user runs go oldest first, and the chat counts as the user", async () => {
    const { s, started, enter, finish } = make(1)
    enter(ticket("w", "hand", 1, "a"))
    enter(ticket("w", "chat", 2, "b"))
    enter(ticket("w", "hand", 3, "c"))
    for (const id of ["a", "b", "c"]) {
      await flush()
      finish(id)
    }
    expect(started).toEqual(["a", "b", "c"])
  })

  test("Run next: the third starts first; a pick of the second then goes before the third", async () => {
    const { s, started, enter, finish } = make(1)
    enter(ticket("w", "hand", 1, "running"))
    enter(ticket("w", "hand", 2, "second"))
    enter(ticket("w", "hand", 3, "third"))
    enter(ticket("w", "hand", 4, "fourth"))
    expect(s.runNext("fourth")).toBe(true)
    expect(s.runNext("second")).toBe(true)
    finish("running")
    await flush()
    // The latest pick starts first.
    expect(started).toEqual(["running", "second"])
    finish("second")
    await flush()
    expect(started).toEqual(["running", "second", "fourth"])
    finish("fourth")
    await flush()
    expect(started.at(-1)).toBe("third")
  })

  test("Run next is off for a task that is not waiting", () => {
    const { s, enter, finish } = make(1)
    enter(ticket("w", "hand", 1, "running"))
    enter(ticket("w", "hand", 2, "queued"))
    expect(s.canRunNext("running")).toBe(false)
    expect(s.canRunNext("queued")).toBe(true)
    expect(s.runNext("running")).toBe(false)
    expect(s.runNext("nobody")).toBe(false)
  })

  test("a memory check starts only when its workflow has no other task that runs or waits", async () => {
    const { s, started, enter, finish } = make(4)
    enter(ticket("w", "hand", 1, "work"))
    enter(ticket("w", "memory", 2, "memory"))
    await flush()
    expect(started).toEqual(["work"])
    finish("work")
    await flush()
    expect(started).toEqual(["work", "memory"])
  })
})

describe("the slots (spec 005, Tasks at once)", () => {
  test("at most that many tasks run at the same time; the next waits for a free slot", async () => {
    const { s, started, enter, finish } = make(2)
    expect(enter(ticket("a", "hand", 1, "a")).granted).toBe(true)
    expect(enter(ticket("b", "hand", 2, "b")).granted).toBe(true)
    const third = enter(ticket("c", "hand", 3, "c"))
    expect(third.granted).toBe(false)
    expect(s.reasons().get("c")).toEqual({ kind: "slot" })
    finish("a")
    await flush()
    expect(started).toEqual(["a", "b", "c"])
  })

  test("a new number applies at once to the tasks that wait, and stops no task that runs", async () => {
    const { s, cap, started, enter, finish } = make(2)
    enter(ticket("a", "hand", 1, "a"))
    enter(ticket("b", "hand", 2, "b"))
    enter(ticket("c", "hand", 3, "c"))
    cap.n = 3
    s.refresh()
    await flush()
    expect(started).toEqual(["a", "b", "c"])
    // Lowering the number stops nothing; a new task waits until enough tasks end.
    cap.n = 1
    s.refresh()
    const d = enter(ticket("d", "hand", 4, "d"))
    expect(d.granted).toBe(false)
    finish("a")
    finish("b")
    await flush()
    expect(started).not.toContain("d")
    finish("c")
    await flush()
    expect(started).toContain("d")
  })

  test("a task of a busy workflow keeps its place: the next task in the order starts instead", async () => {
    const { s, started, enter, finish } = make(2)
    enter(ticket("a", "hand", 1, "a-running"))
    enter(ticket("a", "hand", 2, "a-second"))
    enter(ticket("b", "hand", 3, "b-first"))
    await flush()
    // The second slot goes to the other workflow, not to the second task of the busy one.
    expect(started).toEqual(["a-running", "b-first"])
    expect(s.reasons().get("a-second")).toMatchObject({
      kind: "behind",
      holder: { taskId: "a-running" },
    })
    finish("b-first")
    await flush()
    expect(started).not.toContain("a-second")
    finish("a-running")
    await flush()
    expect(started).toContain("a-second")
  })

  test("a task that waits for the user uses no slot, and its workflow stays held", async () => {
    const { s, started, enter, finish } = make(1)
    enter(ticket("a", "hand", 1, "a-approval"))
    enter(ticket("a", "hand", 2, "a-second"))
    enter(ticket("b", "hand", 3, "b"))
    s.suspend("a-approval")
    await flush()
    // The slot is free: the other workflow runs. The second task of the first one stays queued.
    expect(started).toEqual(["a-approval", "b"])
    expect(s.reasons().get("a-second")).toMatchObject({ kind: "behind" })
  })

  test("after the answer the task needs a slot again, at the front, before a Run next pick", async () => {
    const { s, started, enter, finish } = make(1)
    enter(ticket("a", "hand", 1, "a"))
    s.suspend("a")
    enter(ticket("b", "hand", 2, "b"))
    await flush()
    enter(ticket("c", "hand", 3, "c"))
    s.runNext("c")
    // The user allows the step of "a" while "b" holds the slot.
    let back = false
    void s.resume("a").then(() => {
      back = true
    })
    await flush()
    expect(back).toBe(false)
    expect(s.isWaiting("a")).toBe(true)
    expect(s.reasons().get("a")).toEqual({ kind: "slot" })
    finish("b")
    await flush()
    expect(back).toBe(true)
    // "c" was picked with Run next, but the task that went on after the wait goes first.
    expect(started).toEqual(["a", "b"])
    finish("a")
    await flush()
    expect(started.at(-1)).toBe("c")
  })

  test("stop of a waiting task removes it; its wait rejects", async () => {
    const { s, enter, finish } = make(1)
    enter(ticket("a", "hand", 1, "a"))
    const controller = new AbortController()
    const place = s.enter(ticket("a", "hand", 2, "b"), controller.signal)
    const result = place.ready.then(
      () => "started",
      () => "stopped",
    )
    controller.abort()
    expect(await result).toBe("stopped")
    expect(s.isWaiting("b")).toBe(false)
  })

  test("cancelRun fails the waits of the tasks of one run and returns their ids", async () => {
    const { s, enter, finish } = make(1)
    enter(ticket("a", "hand", 1, "a"))
    const place = enter(ticket("a", "hand", 2, "b"))
    const result = place.ready.then(
      () => "started",
      () => "stopped",
    )
    expect(s.cancelRun("run-2")).toEqual(["b"])
    expect(await result).toBe("stopped")
    expect(s.queuedCount("a")).toBe(0)
  })
})

describe("one run holds its workflow until it ends (spec 005, Rules; 010)", () => {
  /** A task of a run, with the node number of the task. */
  const node = (workflowId: string, runSeq: number, nodeNumber: number): TaskTicket => ({
    ...ticket(workflowId, "hand", runSeq, `r${runSeq}n${nodeNumber}`),
    nodeNumber,
    nodeName: `Node ${nodeNumber}`,
    runId: `run-${runSeq}`,
  })

  test("two runs of two nodes: the second run waits until the first run ends, between its nodes too", async () => {
    const { s, started, enter } = make(1)
    enter(node("w", 1, 1))
    enter(node("w", 2, 1))
    await flush()
    s.release("r1n1")
    await flush()
    // The first run is between its nodes: the second run does not take the workflow.
    expect(started).toEqual(["r1n1"])
    expect(s.reasons().get("r2n1")).toMatchObject({ kind: "behind", holder: { taskId: "r1n1" } })
    enter(node("w", 1, 2))
    await flush()
    expect(started).toEqual(["r1n1", "r1n2"])
    s.release("r1n2")
    s.endRun("run-1")
    await flush()
    expect(started).toEqual(["r1n1", "r1n2", "r2n1"])
    s.release("r2n1")
    enter(node("w", 2, 2))
    await flush()
    expect(started).toEqual(["r1n1", "r1n2", "r2n1", "r2n2"])
  })

  test("the end of a run in any way frees the workflow, also between its nodes", async () => {
    const { s, started, enter } = make(2)
    enter(node("w", 1, 1))
    enter(node("w", 2, 1))
    s.release("r1n1")
    await flush()
    expect(started).toEqual(["r1n1"])
    // The run failed, was stopped or crashed: no second node comes.
    s.endRun("run-1")
    await flush()
    expect(started).toEqual(["r1n1", "r2n1"])
  })

  test("a run between two nodes uses no slot: a task of another workflow takes it", async () => {
    const { s, started, enter } = make(1)
    enter(node("a", 1, 1))
    enter(node("b", 2, 1))
    s.release("r1n1")
    await flush()
    expect(started).toEqual(["r1n1", "r2n1"])
    // The next node of the first run waits for a slot, and no other run of "a" goes before it.
    enter(node("a", 1, 2))
    enter(node("a", 3, 1))
    s.release("r2n1")
    s.endRun("run-2")
    await flush()
    expect(started).toEqual(["r1n1", "r2n1", "r1n2"])
  })

  test("a run that waits for the user keeps the workflow; a pick of Run next in another run does not pass it", async () => {
    const { s, started, enter } = make(1)
    enter(node("w", 1, 1))
    enter(node("w", 2, 1))
    s.suspend("r1n1")
    expect(s.runNext("r2n1")).toBe(true)
    await flush()
    expect(started).toEqual(["r1n1"])
    s.release("r1n1")
    s.endRun("run-1")
    await flush()
    expect(started).toEqual(["r1n1", "r2n1"])
  })

  test("endRun removes the tasks of the run that still wait", async () => {
    const { s, enter } = make(1)
    enter(node("w", 1, 1))
    const place = enter(node("w", 2, 1))
    const result = place.ready.then(
      () => "started",
      () => "stopped",
    )
    s.endRun("run-2")
    expect(await result).toBe("stopped")
    expect(s.queuedCount("w")).toBe(0)
  })
})
