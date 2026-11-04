import { describe, expect, test } from "bun:test"
import {
  KEEP_GOING_MAX,
  KEEP_GOING_MESSAGE,
  type KeepGoingInput,
  keepGoingMessage,
  LIST_LABEL_MAX,
  LIST_STEPS_MAX,
  nextKeepGoing,
  openSteps,
  readStepList,
  sameOpenSteps,
} from "./keepGoing.ts"

const base: KeepGoingInput = {
  enabled: true,
  plan: [
    { label: "Write the test", done: true },
    { label: "Fix the bug", done: false },
    { label: "Run the suite", done: false },
  ],
  blocked: false,
  waiting: false,
  count: 0,
  previous: null,
}

describe("the open steps", () => {
  test("lists the labels of the steps that are not done, in order", () => {
    expect(openSteps(base.plan)).toEqual(["Fix the bug", "Run the suite"])
    expect(openSteps(null)).toEqual([])
    expect(openSteps([{ label: "a", done: true }])).toEqual([])
  })

  test("two sets are the same with the same count and labels, in any order", () => {
    expect(sameOpenSteps(["a", "b"], ["b", "a"])).toBe(true)
    expect(sameOpenSteps(["a", "b"], ["a"])).toBe(false)
    expect(sameOpenSteps(["a", "b"], ["a", "c"])).toBe(false)
    expect(sameOpenSteps([], [])).toBe(true)
  })

  test("a list keeps only steps with words, cut at their limits", () => {
    expect(readStepList([])).toEqual([])
    expect(readStepList([{ label: "   ", done: false }])).toEqual([])
    expect(readStepList([{ label: "  a  ", done: false }])).toEqual([{ label: "a", done: false }])
    const long = readStepList([{ label: "x".repeat(LIST_LABEL_MAX + 50), done: false }])
    expect([...(long[0]?.label ?? "")]).toHaveLength(LIST_LABEL_MAX)
    const many = readStepList(
      Array.from({ length: LIST_STEPS_MAX + 20 }, (_, i) => ({ label: `s${i}`, done: false })),
    )
    expect(many).toHaveLength(LIST_STEPS_MAX)
  })
})

describe("nextKeepGoing", () => {
  test("goes on with the open steps when the turn ended well", () => {
    expect(nextKeepGoing(base)).toEqual(["Fix the bug", "Run the suite"])
  })

  test("does nothing when the setting is off", () => {
    expect(nextKeepGoing({ ...base, enabled: false })).toBeNull()
  })

  test("does nothing when the program reported no list, or the list has no open step", () => {
    expect(nextKeepGoing({ ...base, plan: null })).toBeNull()
    expect(nextKeepGoing({ ...base, plan: [{ label: "a", done: true }] })).toBeNull()
  })

  test("does nothing after a Blocked line or while a card waits", () => {
    expect(nextKeepGoing({ ...base, blocked: true })).toBeNull()
    expect(nextKeepGoing({ ...base, waiting: true })).toBeNull()
  })

  test("goes on at most 8 times", () => {
    expect(KEEP_GOING_MAX).toBe(8)
    expect(nextKeepGoing({ ...base, count: 7 })).not.toBeNull()
    expect(nextKeepGoing({ ...base, count: 8 })).toBeNull()
  })

  test("stops when the open steps are the same as before the last continuation", () => {
    const same = ["Run the suite", "Fix the bug"]
    expect(nextKeepGoing({ ...base, count: 1, previous: same })).toBeNull()
    expect(nextKeepGoing({ ...base, count: 1, previous: ["Fix the bug"] })).not.toBeNull()
    expect(nextKeepGoing({ ...base, count: 1, previous: ["Fix the bug", "Other"] })).not.toBeNull()
  })
})

describe("the go-on message", () => {
  test("tells the agent to ask with a question card and not in plain text", () => {
    expect(KEEP_GOING_MESSAGE).toContain("question card")
    expect(KEEP_GOING_MESSAGE).toContain("Do not ask in plain text")
  })

  test("lists the open steps, at most 40", () => {
    expect(keepGoingMessage([])).toBe(KEEP_GOING_MESSAGE)
    const text = keepGoingMessage(["one", "two"])
    expect(text).toContain("Open steps:\n- one\n- two")
    const many = keepGoingMessage(Array.from({ length: 60 }, (_, i) => `s${i}`))
    expect(many.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(40)
  })
})
