import { describe, expect, test } from "bun:test"
import { filterTasks, type Task, taskDuration, taskLabel, taskTree } from "./task.ts"

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
