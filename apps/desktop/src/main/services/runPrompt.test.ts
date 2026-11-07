import { describe, expect, test } from "bun:test"
import { feedbackBlock, nodeInput, nodeSystem, renderPrompt } from "./runPrompt.ts"

describe("the prompt of a text node (spec 010)", () => {
  test("{{input}} and {{trigger}} are replaced in one pass", () => {
    expect(renderPrompt("A {{input}} B {{trigger}}", "{{trigger}}", "t")).toBe("A {{trigger}} B t")
  })
  test("a prompt with no {{input}} gets the input at its end", () => {
    expect(renderPrompt("Write", "text", "")).toBe("Write\n\ntext")
    expect(renderPrompt("Write", "", "")).toBe("Write")
    expect(renderPrompt("", "text", "")).toBe("text")
  })
  test("the feedback goes after the results and is set apart", () => {
    expect(nodeInput(["one", "two"], [])).toBe("one\n\ntwo")
    const input = nodeInput(["one"], ["Shorter"])
    expect(input.startsWith("one\n\nFeedback of the user")).toBe(true)
    expect(feedbackBlock([])).toBe("")
  })
  test("the document comes first and the rules of the app last", () => {
    const system = nodeSystem({
      document: "My document",
      workflowName: "W",
      nodeNumber: 2,
      nodeName: "Edit",
      folder: "/tmp/w",
      tools: true,
    })
    expect(system.startsWith("My document")).toBe(true)
    expect(system.indexOf("Rules of the app")).toBeGreaterThan(system.indexOf("My document"))
    expect(system).toContain("Blocked:")
  })
})
