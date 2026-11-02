import { describe, expect, test } from "bun:test"
import {
  filterTasks,
  hasVisibleReply,
  isTaskProgress,
  median,
  raiseProgress,
  silentFailure,
  type Task,
  taskDuration,
  taskLabel,
  taskTimes,
  taskTree,
} from "./task.ts"

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  agentId: "a",
  agentName: "Ada",
  prompt: id,
  label: `Label ${id}`,
  source: "chat",
  sourceId: "a",
  parentId: null,
  retryOf: null,
  messageId: null,
  state: "done",
  error: null,
  createdAt: 0,
  startedAt: 100,
  finishedAt: 350,
  askedAt: null,
  firstReplyAt: null,
  originName: null,
  waitsFor: null,
  progress: "not_sent",
  ...extra,
})

describe("tasks", () => {
  test("a label is the first line, cut at 60 characters", () => {
    expect(taskLabel("\n  first line  \nsecond")).toBe("first line")
    expect(taskLabel("x".repeat(80))).toBe(`${"x".repeat(59)}…`)
    expect(taskLabel("")).toBe("")
  })

  test("filters by state, agent, source and label", () => {
    const list = [
      task("1"),
      task("2", { state: "failed", agentId: "b", source: "channel" }),
      task("3", { label: "Write report" }),
    ]
    expect(filterTasks(list, {}).length).toBe(3)
    expect(filterTasks(list, { state: "failed" }).map((t) => t.id)).toEqual(["2"])
    expect(filterTasks(list, { agentId: "b", source: "channel" }).map((t) => t.id)).toEqual(["2"])
    expect(filterTasks(list, { query: " REPORT " }).map((t) => t.id)).toEqual(["3"])
  })

  test("duration needs a start; a running task counts to now", () => {
    expect(taskDuration(task("1"))).toBe(250)
    expect(taskDuration(task("1", { startedAt: null }))).toBeNull()
    expect(taskDuration(task("1", { finishedAt: null }), 1100)).toBe(1000)
  })

  test("times: wait from made to start, first reply and total from the message", () => {
    const done = task("1", {
      askedAt: 0,
      createdAt: 40,
      startedAt: 100,
      firstReplyAt: 2100,
      finishedAt: 3000,
    })
    expect(taskTimes(done)).toEqual({ wait: 60, firstReply: 2100, total: 3000 })
    // No message started the task: the times count from the moment it was made.
    expect(taskTimes({ ...done, askedAt: null })).toEqual({
      wait: 60,
      firstReply: 2060,
      total: 2960,
    })
  })

  test("a time that is not known is null, never 0", () => {
    // Failed before any reply.
    const failed = task("1", { state: "failed", error: { code: "unknown", detail: "" } })
    expect(taskTimes(failed).firstReply).toBeNull()
    expect(taskTimes(failed).total).toBe(350)
    // Queued: nothing is known yet.
    expect(taskTimes(task("2", { state: "queued", startedAt: null, finishedAt: null }))).toEqual({
      wait: null,
      firstReply: null,
      total: null,
    })
    // Running: the total is not known until the end.
    expect(taskTimes(task("3", { state: "running", finishedAt: null })).total).toBeNull()
    // The app stopped: the real end is not known, the earlier times stay.
    const stopped = task("4", {
      state: "failed",
      error: { code: "app_stopped", detail: "" },
      firstReplyAt: 300,
      finishedAt: 999_999,
    })
    expect(taskTimes(stopped)).toEqual({ wait: 100, firstReply: 300, total: null })
  })

  test("a visible reply is text or a card that asks; thinking and tool cards are not", () => {
    expect(hasVisibleReply([])).toBe(false)
    expect(hasVisibleReply([{ kind: "thinking", text: "hmm" }])).toBe(false)
    expect(hasVisibleReply([{ kind: "text", text: "  \n" }])).toBe(false)
    expect(hasVisibleReply([{ kind: "tool" }])).toBe(false)
    expect(hasVisibleReply([{ kind: "tool", ask: undefined }])).toBe(false)
    expect(hasVisibleReply([{ kind: "text", text: "Hi" }])).toBe(true)
    expect(hasVisibleReply([{ kind: "tool", ask: { kind: "approval" } }])).toBe(true)
  })

  test("median of odd and even lists", () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  test("a tree puts each child after its parent", () => {
    const list = [
      task("root"),
      task("b", { parentId: "root" }),
      task("a", { parentId: "root" }),
      task("a1", { parentId: "a" }),
    ]
    expect(taskTree(list, "root").map((n) => `${n.depth}:${n.task.id}`)).toEqual([
      "0:b",
      "0:a",
      "1:a1",
    ])
  })
})

describe("how far a turn went", () => {
  test("the progress only goes up", () => {
    expect(raiseProgress("not_sent", "sent")).toBe("sent")
    expect(raiseProgress("sent", "started")).toBe("started")
    expect(raiseProgress("started", "sent")).toBe("started")
    expect(raiseProgress("started", "not_sent")).toBe("started")
    expect(raiseProgress("sent", "sent")).toBe("sent")
  })

  test("a progress that is not known counts as the lowest", () => {
    expect(raiseProgress(null, "sent")).toBe("sent")
    expect(raiseProgress(undefined, "not_sent")).toBe("not_sent")
  })

  test("only the three values are progress", () => {
    expect(isTaskProgress("started")).toBe(true)
    expect(isTaskProgress("done")).toBe(false)
    expect(isTaskProgress(null)).toBe(false)
  })
})

describe("the failure of the silent limit", () => {
  test("one minute reads in the singular, every other limit in the plural", () => {
    expect(silentFailure(1)).toEqual({ code: "silent_limit_1", detail: "1" })
    expect(silentFailure(5)).toEqual({ code: "silent_limit", detail: "5" })
    expect(silentFailure(60)).toEqual({ code: "silent_limit", detail: "60" })
  })
})
