import { describe, expect, test } from "bun:test"
import {
  BLOCKED_EMPTY_CODE,
  BLOCKED_REASON_MAX,
  BLOCKED_RULE,
  blockedError,
  blockedReason,
  endOfTurn,
  filterTasks,
  hasVisibleReply,
  isActive,
  isBlockedError,
  isFailure,
  isFinal,
  isTaskProgress,
  median,
  queueRank,
  raiseProgress,
  silentFailure,
  TASK_SOURCES,
  type Task,
  taskDuration,
  taskLabel,
  taskTimes,
  taskTree,
  toldAboutBlocked,
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
  endedAt: null,
  endedAs: null,
  usage: { input: null, output: null, cached: null, costMicros: null },
  tokenLimit: null,
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
      task("2", { state: "failed", agentId: "b", source: "routine" }),
      task("3", { label: "Write report" }),
    ]
    expect(filterTasks(list, {}).length).toBe(3)
    expect(filterTasks(list, { state: "failed" }).map((t) => t.id)).toEqual(["2"])
    expect(filterTasks(list, { agentId: "b", source: "routine" }).map((t) => t.id)).toEqual(["2"])
    expect(filterTasks(list, { query: " REPORT " }).map((t) => t.id)).toEqual(["3"])
  })

  test("a task from Teams has its own source, and the filter finds it (spec 028)", () => {
    expect(TASK_SOURCES).toContain("teams")
    const list = [task("1"), task("2", { source: "teams" }), task("3", { source: "teams" })]
    expect(filterTasks(list, { source: "teams" }).map((t) => t.id)).toEqual(["2", "3"])
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

describe("Blocked (spec 005)", () => {
  test("the last line that has text decides, in any letter case", () => {
    expect(blockedReason("Blocked: no access to the folder")).toBe("no access to the folder")
    expect(blockedReason("BLOCKED: no access")).toBe("no access")
    expect(blockedReason("blocked:no access")).toBe("no access")
    expect(blockedReason("I tried.\nBlocked: the key is missing")).toBe("the key is missing")
  })

  test("blank lines and spaces at the end do not count", () => {
    expect(blockedReason("Work.\n  Blocked:   need a login   \n\n  \n")).toBe("need a login")
    expect(blockedReason("Blocked: a\r\n")).toBe("a")
  })

  test("the line must be the last one, and must start with the word", () => {
    expect(blockedReason("Blocked: no access\nBut then I found it.")).toBeNull()
    expect(blockedReason("I am Blocked: no access")).toBeNull()
    expect(blockedReason("**Blocked:** no access")).toBeNull()
    expect(blockedReason("Blocked no access")).toBeNull()
    expect(blockedReason("")).toBeNull()
    expect(blockedReason("  \n \n")).toBeNull()
  })

  test("a line with no reason is blocked with an empty reason", () => {
    expect(blockedReason("Blocked:")).toBe("")
    expect(blockedReason("Blocked:   ")).toBe("")
    expect(blockedError("")).toEqual({ code: BLOCKED_EMPTY_CODE, detail: "" })
    expect(blockedError("why")).toEqual({ code: "blocked", detail: "why" })
    expect(isBlockedError(blockedError(""))).toBe(true)
    expect(isBlockedError(blockedError("why"))).toBe(true)
    expect(isBlockedError({ code: "boom" })).toBe(false)
    expect(isBlockedError(null)).toBe(false)
  })

  test("the reason is cut at 200 characters, and the cut counts characters", () => {
    expect(BLOCKED_REASON_MAX).toBe(200)
    expect([...(blockedReason(`Blocked: ${"x".repeat(250)}`) ?? "")]).toHaveLength(200)
    expect(blockedReason(`Blocked: ${"x".repeat(200)}`)).toBe("x".repeat(200))
    // An emoji is one character, not two.
    expect([...(blockedReason(`Blocked: ${"🙂".repeat(201)}`) ?? "")]).toHaveLength(200)
  })

  test("a turn with no error ends as blocked or done", () => {
    expect(endOfTurn("All done.")).toEqual({ state: "done" })
    expect(endOfTurn("x\nBlocked: no key")).toEqual({
      state: "blocked",
      reason: "no key",
    })
  })

  test("only a message of another agent, a routine or a workflow is told", () => {
    const told = (source: Task["source"]) => toldAboutBlocked({ source })
    expect(told("agent")).toBe(true)
    expect(told("routine")).toBe(true)
    expect(told("workflow")).toBe(true)
    // A direct chat reads the reply itself.
    expect(told("chat")).toBe(false)
    expect(told("mention")).toBe(false)
    expect(BLOCKED_RULE).toContain('"Blocked:"')
  })

  test("a blocked task is final and counts as a failed one", () => {
    expect(isFinal("blocked")).toBe(true)
    expect(isFailure("blocked")).toBe(true)
    expect(isFailure("failed")).toBe(true)
    expect(isFailure("cancelled")).toBe(false)
    expect(isFailure("done")).toBe(false)
    expect(isActive("blocked")).toBe(false)
  })
})

describe("the time of a task (spec 005)", () => {
  test("the total time of a task that has not ended is not known yet", () => {
    const running = task("r", {
      state: "running",
      finishedAt: null,
      startedAt: 100,
      firstReplyAt: 150,
    })
    expect(taskTimes(running).total).toBeNull()
    expect(taskTimes({ ...running, state: "done", finishedAt: 900 }).total).toBe(900)
    expect(taskTimes({ ...running, state: "blocked", finishedAt: 500 }).total).toBe(500)
  })
})

describe("queue order (spec 005)", () => {
  test("a pick of Run next first, then normal sources, then background sources", () => {
    expect(queueRank("routine", true)).toBe(1)
    // Teams is a normal source (spec 005).
    for (const source of ["chat", "agent", "teams"] as const)
      expect(queueRank(source, false)).toBe(2)
    expect(queueRank("routine", false)).toBe(3)
    expect(queueRank("workflow", false)).toBe(3)
  })
})
