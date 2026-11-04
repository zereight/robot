import { describe, expect, test } from "bun:test"
import {
  addSpent,
  addUsage,
  cachedShare,
  hasUsage,
  limitState,
  NO_USAGE,
  programReportsTokens,
  type TaskUsage,
  tokensOf,
  treeUsage,
  validTokenLimit,
  withDescendantsOf,
} from "./taskUsage.ts"

const usage = (input: number | null, output: number | null, cached: number | null = null) =>
  ({ input, output, cached, costMicros: null }) satisfies TaskUsage

describe("usage of a task", () => {
  test("a number that the provider did not report stays null, and a reported 0 is 0", () => {
    expect(addSpent(NO_USAGE, {})).toEqual(NO_USAGE)
    expect(hasUsage(addSpent(NO_USAGE, {}))).toBe(false)
    const zero = addSpent(NO_USAGE, { input: 0, output: 0 })
    expect(zero.input).toBe(0)
    expect(zero.cached).toBeNull()
    expect(hasUsage(zero)).toBe(true)
  })

  test("reports add up, field by field", () => {
    let u = addSpent(NO_USAGE, { input: 1000, output: 200 })
    u = addSpent(u, { input: 3000, output: 500, cached: 2000, costMicros: 1500 })
    u = addSpent(u, { output: 5 })
    expect(u).toEqual({ input: 4000, output: 705, cached: 2000, costMicros: 1500 })
  })

  test("two usages add; a field that neither reported stays null", () => {
    expect(addUsage(usage(10, 2), usage(null, null))).toEqual(usage(10, 2))
    expect(addUsage(usage(null, null), usage(null, null))).toEqual(NO_USAGE)
    expect(addUsage(usage(10, 2, 4), usage(5, 1))).toEqual(usage(15, 3, 4))
  })

  test("the cached share is cached input divided by all input, and only when it is reported", () => {
    expect(cachedShare(usage(8000, 100, 6000))).toBe(75)
    expect(cachedShare(usage(8000, 100, null))).toBeNull()
    expect(cachedShare(usage(0, 100, 0))).toBeNull()
    expect(cachedShare(usage(null, 100, 5))).toBeNull()
    expect(cachedShare(usage(3, 1, 1))).toBe(33)
    expect(cachedShare(usage(10, 1, 99))).toBe(100)
  })

  test("tokens are input plus output; cached input is already in input", () => {
    expect(tokensOf(usage(8000, 100, 6000))).toBe(8100)
    expect(tokensOf(usage(null, 7))).toBe(7)
  })
})

describe("tree of a job", () => {
  const task = (agentId: string, name: string, u: TaskUsage) => ({
    agentId,
    agentName: name,
    usage: u,
  })

  test("a job with two parts: the total and one line for each agent, largest first", () => {
    const tree = treeUsage([
      task("lead", "Lead", usage(1000, 200)),
      task("a", "Ada", usage(3000, 500)),
      task("b", "Bo", usage(3000, 500)),
    ])
    expect(tree.total).toEqual(usage(7000, 1200))
    expect(tree.lines.map((l) => l.agentName)).toEqual(["Ada", "Bo", "Lead"])
    expect(tree.lines.map((l) => l.share)).toEqual([43, 43, 14])
  })

  test("the shares of the lines add up to 100 when every agent reported", () => {
    for (const parts of [
      [1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1],
      [5, 3, 2],
      [1, 99],
      [7, 7, 7, 79],
    ]) {
      const tree = treeUsage(parts.map((n, i) => task(`a${i}`, `Agent ${i}`, usage(n, 0))))
      const sum = tree.lines.reduce((total, l) => total + (l.share ?? 0), 0)
      expect(sum).toBe(100)
    }
  })

  test("an agent that reports nothing has a line with no numbers, comes last, and is not in the total", () => {
    const tree = treeUsage([
      task("lead", "Lead", usage(1000, 200)),
      task("a", "Ada", usage(3000, 500)),
      task("c", "Cy", NO_USAGE),
    ])
    expect(tree.total).toEqual(usage(4000, 700))
    expect(tree.lines.map((l) => l.agentName)).toEqual(["Ada", "Lead", "Cy"])
    expect(tree.lines.at(-1)?.usage).toEqual(NO_USAGE)
    expect(tree.lines.at(-1)?.share).toBeNull()
  })

  test("two tasks of one agent are one line", () => {
    const tree = treeUsage([
      task("a", "Ada", usage(10, 1)),
      task("a", "Ada", usage(20, 2)),
      task("b", "Bo", usage(1, 1)),
    ])
    expect(tree.lines).toHaveLength(2)
    expect(tree.lines[0]?.usage).toEqual(usage(30, 3))
  })

  test("a tree with no report at all has no total", () => {
    const tree = treeUsage([task("a", "Ada", NO_USAGE)])
    expect(tree.total).toEqual(NO_USAGE)
    expect(tree.lines[0]?.share).toBeNull()
  })

  test("the tasks below a root, with the root", () => {
    const tasks = [
      { id: "r", parentId: null },
      { id: "p1", parentId: "r" },
      { id: "p2", parentId: "r" },
      { id: "x", parentId: "p1" },
      { id: "other", parentId: null },
    ]
    expect(withDescendantsOf(tasks, "r").map((t) => t.id)).toEqual(["r", "p1", "x", "p2"])
    expect(withDescendantsOf(tasks, "p2").map((t) => t.id)).toEqual(["p2"])
    expect(withDescendantsOf(tasks, "nope")).toEqual([])
  })
})

describe("token limit", () => {
  test("the limit is a whole number from 1000 to 10000000", () => {
    expect(validTokenLimit(1000)).toBe(true)
    expect(validTokenLimit(10_000_000)).toBe(true)
    expect(validTokenLimit(999)).toBe(false)
    expect(validTokenLimit(10_000_001)).toBe(false)
    expect(validTokenLimit(1500.5)).toBe(false)
    expect(validTokenLimit("5000")).toBe(false)
    expect(validTokenLimit(Number.NaN)).toBe(false)
  })

  test("80 percent shows the line, the limit stops the run", () => {
    expect(limitState(3999, 5000)).toBe("ok")
    expect(limitState(4000, 5000)).toBe("near")
    expect(limitState(4100, 5000)).toBe("near")
    expect(limitState(4999, 5000)).toBe("near")
    expect(limitState(5000, 5000)).toBe("over")
    expect(limitState(5200, 5000)).toBe("over")
  })

  test("every program that the app starts reports tokens", () => {
    for (const kind of ["claude_code", "codex", "muse", "pi", "opencode"])
      expect(programReportsTokens(kind)).toBe(true)
  })
})
