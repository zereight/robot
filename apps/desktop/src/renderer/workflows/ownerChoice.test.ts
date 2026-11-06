import { describe, expect, test } from "bun:test"
import type { WorkflowOwner } from "@robot/shared"
import { ownerChoice, ownerFromChoice } from "./ownerChoice.ts"

describe("the choice of an owner in a select (spec 010)", () => {
  const ada: WorkflowOwner = { kind: "agent", id: "agent-1" }

  test("none is the empty choice", () => {
    expect(ownerChoice(null)).toBe("")
    expect(ownerFromChoice("")).toBeNull()
  })

  test("an agent goes to a choice and comes back", () => {
    expect(ownerFromChoice(ownerChoice(ada))).toEqual(ada)
  })

  test("an id that holds a colon survives", () => {
    const odd: WorkflowOwner = { kind: "agent", id: "a:b:c" }
    expect(ownerFromChoice(ownerChoice(odd))).toEqual(odd)
  })

  test("a choice that names no agent counts as none", () => {
    expect(ownerFromChoice("team:1")).toBeNull()
    expect(ownerFromChoice("organization:org-1")).toBeNull()
    expect(ownerFromChoice("agent:")).toBeNull()
  })
})
