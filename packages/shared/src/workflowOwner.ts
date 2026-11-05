// The owner of a workflow and the agents that may work in it (spec 010, "Owner and participants").
// The run, the editor and the pages read this one rule, so they never disagree.

import { Schema } from "effect"
import { activeMembers, effectiveLead } from "./organizations.ts"

export const WORKFLOW_OWNER_KINDS = ["organization", "agent"] as const
export type WorkflowOwnerKind = (typeof WORKFLOW_OWNER_KINDS)[number]

/** One organization or one agent. A workflow with no owner has `null` and is shared. */
export const WorkflowOwnerSchema = Schema.Struct({
  kind: Schema.Literals(WORKFLOW_OWNER_KINDS),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export type WorkflowOwner = typeof WorkflowOwnerSchema.Type

/** What the rule reads: the agents and the organizations of one server, as stored. */
export interface ParticipantModel {
  readonly agents: readonly { readonly id: string; readonly archived?: boolean }[]
  readonly orgs: readonly {
    readonly id: string
    readonly leadId: string | null
    readonly memberIds: readonly string[]
  }[]
}

/**
 * The agents that may be the agent of an agent step. An archived agent never is. The owner is one
 * that exists (`Workflow.owner` is none when the organization or the agent is gone, spec 010, "When
 * the owner is gone"). An owner that the model does not hold has no participants.
 */
export const workflowParticipants = (
  owner: WorkflowOwner | null,
  model: ParticipantModel,
): ReadonlySet<string> => {
  const archived = new Set(model.agents.filter((a) => a.archived === true).map((a) => a.id))
  const alive = new Set(model.agents.filter((a) => a.archived !== true).map((a) => a.id))
  if (owner === null) return alive
  if (owner.kind === "agent") return new Set(alive.has(owner.id) ? [owner.id] : [])
  const own = model.orgs.find((o) => o.id === owner.id)
  if (!own) return new Set()
  const leads = model.orgs
    .filter((o) => o.id !== own.id)
    .map((o) => effectiveLead(o, archived))
    .filter((id): id is string => id !== null)
  return new Set([...activeMembers(own, archived), ...leads].filter((id) => alive.has(id)))
}

export const isParticipant = (
  owner: WorkflowOwner | null,
  model: ParticipantModel,
  agentId: string,
): boolean => workflowParticipants(owner, model).has(agentId)
