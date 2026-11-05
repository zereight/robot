import { describe, expect, test } from "bun:test"
import {
  isParticipant,
  type ParticipantModel,
  type WorkflowOwner,
  workflowParticipants,
} from "./workflowOwner.ts"

// The example of spec 010, "Owner and participants": "Docs" has the lead Ada and the member Bo,
// "Ops" has the lead Cy and the member Dee, and Eve is in no organization.
const model = (patch: Partial<ParticipantModel> = {}): ParticipantModel => ({
  agents: [{ id: "ada" }, { id: "bo" }, { id: "cy" }, { id: "dee" }, { id: "eve" }],
  orgs: [
    { id: "docs", leadId: "ada", memberIds: ["ada", "bo"] },
    { id: "ops", leadId: "cy", memberIds: ["cy", "dee"] },
  ],
  ...patch,
})
const org = (id: string): WorkflowOwner => ({ kind: "organization", id })
const agent = (id: string): WorkflowOwner => ({ kind: "agent", id })
const ids = (owner: WorkflowOwner | null, m = model()) => [...workflowParticipants(owner, m)].sort()

describe("who takes part in a workflow (spec 010, Owner and participants)", () => {
  test("a shared workflow takes every agent that is not archived", () => {
    expect(ids(null)).toEqual(["ada", "bo", "cy", "dee", "eve"])
    expect(ids(null, model({ agents: [{ id: "ada", archived: true }, { id: "bo" }] }))).toEqual([
      "bo",
    ])
  })

  test("a workflow of an organization takes its members and the leads of the other organizations", () => {
    expect(ids(org("docs"))).toEqual(["ada", "bo", "cy"])
    expect(ids(org("ops"))).toEqual(["ada", "cy", "dee"])
  })

  test("a lead who changes counts from the next look, with no edit of a step", () => {
    const next = model({
      orgs: [
        { id: "docs", leadId: "ada", memberIds: ["ada", "bo"] },
        { id: "ops", leadId: "dee", memberIds: ["cy", "dee"] },
      ],
    })
    expect(ids(org("docs"), next)).toEqual(["ada", "bo", "dee"])
  })

  test("a member who is removed stops taking part", () => {
    const next = model({
      orgs: [
        { id: "docs", leadId: "ada", memberIds: ["ada"] },
        { id: "ops", leadId: "cy", memberIds: ["cy", "dee"] },
      ],
    })
    expect(ids(org("docs"), next)).toEqual(["ada", "cy"])
  })

  test("a lead who is not a member leads nothing, and so takes no part from another organization", () => {
    const next = model({
      orgs: [
        { id: "docs", leadId: "ada", memberIds: ["ada", "bo"] },
        { id: "ops", leadId: "eve", memberIds: ["cy", "dee"] },
      ],
    })
    expect(ids(org("docs"), next)).toEqual(["ada", "bo"])
  })

  test("an archived agent never takes part, also as a member or as a lead", () => {
    const next = model({
      agents: [
        { id: "ada", archived: true },
        { id: "bo" },
        { id: "cy", archived: true },
        { id: "dee" },
      ],
    })
    expect(ids(org("docs"), next)).toEqual(["bo"])
  })

  test("the members of a lower organization do not take part, unless they lead one", () => {
    const next = model({
      orgs: [
        { id: "docs", leadId: "ada", memberIds: ["ada", "bo"] },
        { id: "docs-site", leadId: "cy", memberIds: ["cy", "dee"] },
      ],
    })
    expect(ids(org("docs"), next)).toEqual(["ada", "bo", "cy"])
  })

  test("a workflow of an agent takes that agent only, and none while it is archived", () => {
    expect(ids(agent("bo"))).toEqual(["bo"])
    expect(ids(agent("bo"), model({ agents: [{ id: "bo", archived: true }] }))).toEqual([])
  })

  test("an owner that the model does not hold has no participants: the caller reads an owner that exists", () => {
    expect(ids(org("gone"))).toEqual([])
    expect(ids(agent("gone"))).toEqual([])
  })

  test("isParticipant answers for one agent", () => {
    expect(isParticipant(org("docs"), model(), "cy")).toBe(true)
    expect(isParticipant(org("docs"), model(), "dee")).toBe(false)
    expect(isParticipant(null, model(), "eve")).toBe(true)
  })
})
