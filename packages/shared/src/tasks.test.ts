import { describe, expect, test } from "bun:test"
import type { ActionLogEntry } from "./outside.ts"
import {
  filterTasks,
  formatClock,
  isRetryable,
  isStoppable,
  isTasksAtOnce,
  mayChange,
  QUIET_MS,
  queueRank,
  quietTimeMs,
  retryNote,
  taskDuration,
  taskMoments,
  taskTimes,
} from "./tasks.ts"

describe("tasks at once (spec 013)", () => {
  test("a whole number from 1 to 8", () => {
    for (const ok of [1, 4, 8]) expect(isTasksAtOnce(ok)).toBe(true)
    for (const bad of [0, 9, -1, 2.5, "3", null, Number.NaN]) expect(isTasksAtOnce(bad)).toBe(false)
  })
})

describe("the order of the queue (spec 005, Queue)", () => {
  test("a task that went on after a wait, then a pick, then the user, then a trigger, then a memory check", () => {
    const rank = (
      source: Parameters<typeof queueRank>[0]["source"],
      resumed = false,
      picked = false,
    ) => queueRank({ source, resumed, picked })
    expect(rank("hand", true, true)).toBe(0)
    expect(rank("schedule", false, true)).toBe(1)
    expect(rank("hand")).toBe(2)
    expect(rank("chat")).toBe(2)
    expect(rank("schedule")).toBe(3)
    expect(rank("memory")).toBe(4)
  })
})

describe("the quiet time (spec 005, Quiet line)", () => {
  const MIN = 60_000
  test("90 seconds, or half of the silent limit when that is shorter", () => {
    expect(quietTimeMs(10 * MIN)).toBe(QUIET_MS)
    expect(quietTimeMs(MIN)).toBe(30_000)
    expect(quietTimeMs(5 * MIN)).toBe(QUIET_MS)
    expect(quietTimeMs(2 * MIN)).toBe(60_000)
  })
  test("with the silent limit Never it is 90 seconds", () => {
    expect(quietTimeMs(0)).toBe(QUIET_MS)
  })
  test("the time reads m:ss, and h:mm:ss after one hour", () => {
    expect(formatClock(90)).toBe("1:30")
    expect(formatClock(5)).toBe("0:05")
    expect(formatClock(3600)).toBe("1:00:00")
    expect(formatClock(3725)).toBe("1:02:05")
  })
})

describe("the filters of the Tasks page (spec 005)", () => {
  const rows = [
    { id: "1", state: "done", workflowId: "a", source: "hand" },
    { id: "2", state: "failed", workflowId: "b", source: "chat" },
    { id: "3", state: "queued", workflowId: "a", source: "schedule" },
  ] as const
  test("keep the rows that match every filter that is set", () => {
    expect(filterTasks(rows, {}).length).toBe(3)
    expect(filterTasks(rows, { state: "failed" }).map((r) => r.id)).toEqual(["2"])
    expect(filterTasks(rows, { workflowId: "a" }).map((r) => r.id)).toEqual(["1", "3"])
    expect(filterTasks(rows, { source: "schedule" }).map((r) => r.id)).toEqual(["3"])
    expect(filterTasks(rows, { workflowId: "a", state: "done" }).map((r) => r.id)).toEqual(["1"])
    expect(filterTasks(rows, { workflowId: "b", state: "done" })).toEqual([])
  })
  test("stop is for queued, running and waiting; retry for failed, blocked and cancelled", () => {
    expect(["queued", "running", "waiting"].every((s) => isStoppable(s as "queued"))).toBe(true)
    expect(isStoppable("done")).toBe(false)
    expect(["failed", "blocked", "cancelled"].every((s) => isRetryable(s as "failed"))).toBe(true)
    expect(isRetryable("done")).toBe(false)
    expect(isRetryable("queued")).toBe(false)
  })
  test("the duration is null until the task starts", () => {
    expect(taskDuration({ startedAt: null, finishedAt: null })).toBeNull()
    expect(taskDuration({ startedAt: 1000, finishedAt: 4000 })).toBe(3000)
    expect(taskDuration({ startedAt: 1000, finishedAt: null }, 1500)).toBe(500)
  })
})

describe("times and moments (spec 005)", () => {
  const base = {
    state: "done" as const,
    reasonCode: null,
    createdAt: 1000,
    startedAt: 1500,
    firstReplyAt: 3500,
    finishedAt: 6000,
  }
  test("wait, first reply and total count from the moment the task is made", () => {
    expect(taskTimes(base)).toEqual({ wait: 500, firstReply: 2500, total: 5000 })
  })
  test("a time that is not known is null, never 0", () => {
    expect(
      taskTimes({
        ...base,
        state: "failed",
        firstReplyAt: null,
        startedAt: null,
        finishedAt: 2000,
      }),
    ).toEqual({ wait: null, firstReply: null, total: 1000 })
    expect(taskTimes({ ...base, state: "running", finishedAt: null }).total).toBeNull()
  })
  test("a task that the app stopped has no known total", () => {
    expect(taskTimes({ ...base, state: "failed", reasonCode: "restart" }).total).toBeNull()
  })
  test("the moments are Given, Started, Ended and Closed; one that did not happen does not show", () => {
    const all = taskMoments({
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      endedAs: "blocked",
      finishedAt: 4,
    })
    expect(all.map((m) => m.kind)).toEqual(["given", "started", "ended", "closed"])
    expect(all[2]).toEqual({ kind: "ended", at: 3, how: "blocked" })
    expect(
      taskMoments({
        createdAt: 1,
        startedAt: null,
        endedAt: null,
        endedAs: null,
        finishedAt: null,
      }),
    ).toEqual([{ kind: "given", at: 1 }])
    // A task that the app stopped has no end of the turn that is known.
    expect(
      taskMoments({ createdAt: 1, startedAt: 2, endedAt: null, endedAs: null, finishedAt: 9 }).map(
        (m) => m.kind,
      ),
    ).toEqual(["given", "started", "closed"])
  })
})

describe("the retry note (spec 005, Retry note)", () => {
  const step = (
    kind: ActionLogEntry["kind"],
    result: ActionLogEntry["result"],
    target: string,
    access: ActionLogEntry["access"] = null,
  ): ActionLogEntry => ({
    id: target,
    at: 0,
    workflowId: "w",
    workflowName: "W",
    nodeName: null,
    nodeNumber: null,
    kind,
    access,
    target,
    decidedBy: "user",
    result,
    taskId: "t",
    outside: null,
    sensitive: null,
    rule: null,
    check: null,
    device: null,
  })
  test("a file write, a shell command and a tool of a connection may change things", () => {
    expect(mayChange(step("file", "ran", "a", "write"))).toBe(true)
    expect(mayChange(step("shell", "failed", "ls"))).toBe(true)
    expect(mayChange(step("connection", "stopped", "x · y"))).toBe(true)
  })
  test("a file read, a web page and a refused step do not", () => {
    expect(mayChange(step("file", "ran", "a", "read"))).toBe(false)
    expect(mayChange(step("web", "ran", "https://a"))).toBe(false)
    expect(mayChange(step("shell", "refused", "rm"))).toBe(false)
  })
  test("no step that may change things gives no note", () => {
    expect(retryNote([step("file", "ran", "a", "read"), step("web", "ran", "u")])).toBeNull()
  })
  test("at most 5 steps, newest first, and the number of the rest", () => {
    const steps = Array.from({ length: 8 }, (_, i) => step("shell", "ran", `cmd ${i + 1}`))
    const note = retryNote(steps)
    expect(note?.steps.map((s) => s.target)).toEqual(["cmd 8", "cmd 7", "cmd 6", "cmd 5", "cmd 4"])
    expect(note?.more).toBe(3)
    expect(note?.computer).toBeNull()
  })
})
