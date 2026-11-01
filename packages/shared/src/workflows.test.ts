import { describe, expect, test } from "bun:test"
import { fillTemplate, graphProblem } from "./workflows.ts"

const s = (id: string, kind: "agent" | "condition" | "post" = "agent") => ({ id, kind })

describe("graphProblem", () => {
  test("accepts a chain and a branch", () => {
    expect(graphProblem([s("a"), s("b")], [{ id: "1", from: "a", to: "b" }])).toBeNull()
    expect(
      graphProblem(
        [s("a"), s("c", "condition"), s("d"), s("e")],
        [
          { id: "1", from: "a", to: "c" },
          { id: "2", from: "c", to: "d", branch: "yes" },
          { id: "3", from: "c", to: "e", branch: "no" },
        ],
      ),
    ).toBeNull()
  })
  test("finds the problems", () => {
    expect(graphProblem([], [])).toBe("no_steps")
    expect(graphProblem([s("a"), s("a")], [])).toBe("duplicate_step")
    expect(graphProblem([s("a")], [{ id: "1", from: "a", to: "zzz" }])).toBe("bad_edge")
    expect(graphProblem([s("a")], [{ id: "1", from: "a", to: "a" }])).toBe("bad_edge")
    expect(graphProblem([s("c", "condition"), s("a")], [{ id: "1", from: "c", to: "a" }])).toBe(
      "missing_branch",
    )
    expect(
      graphProblem(
        [s("a"), s("b")],
        [
          { id: "1", from: "a", to: "b" },
          { id: "2", from: "b", to: "a" },
        ],
      ),
    ).toBe("cycle")
  })
})

test("fillTemplate", () => {
  expect(fillTemplate("Summarise: {{input}} / {{trigger}} / {{input}}", "X", "T")).toBe(
    "Summarise: X / T / X",
  )
})
