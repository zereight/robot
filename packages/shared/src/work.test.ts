import { describe, expect, test } from "bun:test"
import { catalogues } from "./i18n/index.ts"
import type { Task } from "./task.ts"
import { lastChange, recentReason, recentWords, taskMoments } from "./work.ts"

const task = (extra: Partial<Task> = {}): Task => ({
  id: "t",
  agentId: "a",
  agentName: "Ada",
  prompt: "p",
  label: "Label",
  source: "chat",
  sourceId: "a",
  parentId: null,
  retryOf: null,
  messageId: null,
  state: "done",
  error: null,
  createdAt: 100,
  startedAt: 110,
  finishedAt: 150,
  askedAt: null,
  firstReplyAt: null,
  originName: null,
  waitsFor: null,
  progress: null,
  endedAt: 150,
  endedAs: "done",
  usage: { input: null, output: null, cached: null, costMicros: null },
  tokenLimit: null,
  ...extra,
})

const ids = (list: ReturnType<typeof taskMoments>) => list.map((m) => m.id)

describe("the moments of a task (spec 005)", () => {
  test("a task of a chat has Given, Started, Ended and Closed, and no Decided or Judged", () => {
    const moments = taskMoments(task())
    expect(ids(moments)).toEqual(["given", "started", "ended", "closed"])
    expect(moments[0]).toEqual({ id: "given", at: 100, by: { kind: "source", source: "chat" } })
    expect(moments[2]).toEqual({ id: "ended", at: 150, how: "done" })
    expect(moments[3]).toEqual({ id: "closed", at: 150, state: "done" })
  })

  test("a moment that did not happen is not listed", () => {
    // Queued: only Given.
    const queued = task({
      state: "queued",
      startedAt: null,
      finishedAt: null,
      endedAt: null,
      endedAs: null,
    })
    expect(ids(taskMoments(queued))).toEqual(["given"])
    // Running: Given and Started.
    const running = task({ state: "running", finishedAt: null, endedAt: null, endedAs: null })
    expect(ids(taskMoments(running))).toEqual(["given", "started"])
    // Cancelled while queued: Given and Closed.
    const cancelled = task({
      state: "cancelled",
      startedAt: null,
      endedAt: null,
      endedAs: null,
      finishedAt: 120,
    })
    expect(ids(taskMoments(cancelled))).toEqual(["given", "closed"])
  })

  test("who gave the task: another agent, or the place it came from", () => {
    const given = (t: Task) => taskMoments(t)[0]
    expect(given(task({ source: "agent" }))).toMatchObject({ by: { kind: "agent" } })
    for (const source of ["chat", "routine", "workflow"] as const)
      expect(given(task({ source }))).toMatchObject({ by: { kind: "source", source } })
  })

  test("a task that the app stopped has no Ended moment", () => {
    const stopped = task({
      state: "failed",
      error: { code: "app_stopped", detail: "" },
      endedAt: null,
      endedAs: null,
    })
    expect(ids(taskMoments(stopped))).toEqual(["given", "started", "closed"])
  })
})

describe("recent work (spec 002)", () => {
  const row = (
    state: Task["state"],
    extra: { wait?: "approval" | "question" | "user" | null; behind?: never } = {},
  ) => ({ task: { state }, wait: extra.wait ?? null, behind: null })

  test("what a task that has not ended waits for", () => {
    expect(recentWords(row("waiting", { wait: "approval" }))).toEqual({
      key: "recent.waits.approval",
    })
    expect(recentWords(row("waiting", { wait: "question" }))).toEqual({
      key: "recent.waits.question",
    })
    // A task that waits for another reason (the user holds the browser) says it waits for the user.
    expect(recentWords(row("waiting", { wait: "user" }))).toEqual({ key: "tasks.state.waiting" })
  })

  test("a queued task names the place that it waits behind", () => {
    const queued = (behind: Parameters<typeof recentWords>[0]["behind"]) =>
      recentWords({ task: { state: "queued" }, wait: null, behind })
    expect(queued({ kind: "routine", name: "Daily" })).toEqual({
      key: "recent.behind.routine",
      params: { name: "Daily" },
    })
    expect(queued({ kind: "workflow", name: "Flow" })).toEqual({
      key: "recent.behind.workflow",
      params: { name: "Flow" },
    })
    expect(queued({ kind: "computer", name: "MacBook 2" })).toEqual({
      key: "recent.behind.computer",
      params: { name: "MacBook 2" },
    })
    expect(queued({ kind: "chat" })).toEqual({ key: "recent.behind.chat" })
    expect(queued({ kind: "agent" })).toEqual({ key: "recent.behind.agent" })
    // No place is known: the plain state.
    expect(queued(null)).toEqual({ key: "tasks.state.queued" })
  })

  test("the other states say their plain state; a blocked task also has its reason", () => {
    for (const state of ["running", "done", "failed", "blocked", "cancelled"] as const)
      expect(recentWords(row(state))).toEqual({ key: `tasks.state.${state}` })
    expect(
      recentReason({ state: "blocked", error: { code: "blocked", detail: "No access" } }),
    ).toBe("No access")
    expect(recentReason({ state: "blocked", error: null })).toBe("")
    expect(recentReason({ state: "failed", error: { code: "x", detail: "y" } })).toBeNull()
  })

  test("every key that the words name has a text in both languages", () => {
    const keys = [
      "recent.waits.approval",
      "recent.waits.question",
      "recent.behind.chat",
      "recent.behind.routine",
      "recent.behind.workflow",
      "recent.behind.agent",
      "recent.behind.computer",
    ] as const
    for (const catalogue of Object.values(catalogues))
      for (const key of keys) expect(catalogue[key].length).toBeGreaterThan(0)
  })

  test("the last change is the latest moment that the task has", () => {
    expect(lastChange(task())).toBe(150)
    expect(lastChange(task({ finishedAt: 220, endedAt: 220 }))).toBe(220)
    expect(
      lastChange(task({ startedAt: null, endedAt: null, finishedAt: null, state: "queued" })),
    ).toBe(100)
  })
})
