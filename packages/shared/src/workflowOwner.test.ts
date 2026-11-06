import { describe, expect, test } from "bun:test"
import {
  isParticipant,
  type ParticipantModel,
  type WorkflowOwner,
  workflowParticipants,
} from "./workflowOwner.ts"

// The example of spec 010, "Owner and participants": a workflow with no owner is shared, and a
// workflow with an owner takes that agent only.
const model = (patch: Partial<ParticipantModel> = {}): ParticipantModel => ({
  agents: [{ id: "ada" }, { id: "bo" }, { id: "cy" }, { id: "dee" }, { id: "eve" }],
  ...patch,
})
const agent = (id: string): WorkflowOwner => ({ kind: "agent", id })
const ids = (owner: WorkflowOwner | null, m = model()) => [...workflowParticipants(owner, m)].sort()

describe("who takes part in a workflow (spec 010, Owner and participants)", () => {
  test("a shared workflow takes every agent that is not archived", () => {
    expect(ids(null)).toEqual(["ada", "bo", "cy", "dee", "eve"])
    expect(ids(null, model({ agents: [{ id: "ada", archived: true }, { id: "bo" }] }))).toEqual([
      "bo",
    ])
  })

  test("a workflow of an agent takes that agent only, and none while it is archived", () => {
    expect(ids(agent("bo"))).toEqual(["bo"])
    expect(ids(agent("bo"), model({ agents: [{ id: "bo", archived: true }] }))).toEqual([])
  })

  test("an owner that the model does not hold has no participants: the caller reads an owner that exists", () => {
    expect(ids(agent("gone"))).toEqual([])
  })

  test("isParticipant answers for one agent", () => {
    expect(isParticipant(agent("cy"), model(), "cy")).toBe(true)
    expect(isParticipant(agent("cy"), model(), "dee")).toBe(false)
    expect(isParticipant(null, model(), "eve")).toBe(true)
  })
})
