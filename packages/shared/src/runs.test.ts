import { describe, expect, test } from "bun:test"
import { guardVerdict } from "./outside.ts"
import { blockedReason } from "./runs.ts"
import { levelForNode } from "./tools.ts"

describe("the Blocked line (spec 005)", () => {
  test("the last non-empty line decides, ignoring case, and is cut at 200 characters", () => {
    expect(blockedReason("work\nblocked: no key\n\n")).toBe("no key")
    expect(blockedReason("Blocked: first\nmore")).toBeNull()
    expect(blockedReason("Blocked: ".concat("x".repeat(300)))?.length).toBe(200)
    expect(blockedReason("")).toBeNull()
  })
})

describe("a guarded step (spec 007)", () => {
  test("outside content asks except at Full access; the program mark always asks", () => {
    expect(guardVerdict({ level: "ask_risky", outside: false, program: false })).toBe("run")
    expect(guardVerdict({ level: "ask_risky", outside: true, program: false })).toBe("ask")
    expect(guardVerdict({ level: "read_only", outside: true, program: false })).toBe("ask")
    expect(guardVerdict({ level: "full", outside: true, program: false })).toBe("run")
    expect(guardVerdict({ level: "full", outside: true, program: true })).toBe("ask")
    expect(guardVerdict({ level: "full", outside: false, program: true })).toBe("ask")
  })
})

describe("the level of a node", () => {
  test("Ask when unsure works as Ask for risky steps in a node (no words of the user)", () => {
    expect(levelForNode("ask_unsure")).toBe("ask_risky")
    expect(levelForNode("full")).toBe("full")
  })
})
