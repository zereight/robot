import { describe, expect, test } from "bun:test"
import type { WorkflowOwner } from "@robot/shared"
import { ownerChoice, ownerFromChoice } from "./ownerChoice.ts"

describe("the choice of an owner in a select (spec 010)", () => {
  const docs: WorkflowOwner = { kind: "organization", id: "org-1" }
  const ada: WorkflowOwner = { kind: "agent", id: "agent-1" }

  test("none is the empty choice", () => {
    expect(ownerChoice(null)).toBe("")
    expect(ownerFromChoice("")).toBeNull()
  })

  test("an organization and an agent go to a choice and come back", () => {
    expect(ownerFromChoice(ownerChoice(docs))).toEqual(docs)
    expect(ownerFromChoice(ownerChoice(ada))).toEqual(ada)
    expect(ownerChoice(docs)).not.toBe(ownerChoice({ kind: "agent", id: docs.id }))
  })

  test("an id that holds a colon survives", () => {
    const odd: WorkflowOwner = { kind: "agent", id: "a:b:c" }
    expect(ownerFromChoice(ownerChoice(odd))).toEqual(odd)
  })

  test("a choice that no one made counts as none", () => {
    expect(ownerFromChoice("team:1")).toBeNull()
    expect(ownerFromChoice("agent:")).toBeNull()
  })
})
