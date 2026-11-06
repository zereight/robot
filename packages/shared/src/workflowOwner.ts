// The owner of a workflow and the agents that may work in it (spec 010, "Owner and participants").
// The run, the editor and the pages read this one rule, so they never disagree.

import { Schema } from "effect"

export const WORKFLOW_OWNER_KINDS = ["agent"] as const
export type WorkflowOwnerKind = (typeof WORKFLOW_OWNER_KINDS)[number]

/** One agent. A workflow with no owner has `null` and is shared. */
export const WorkflowOwnerSchema = Schema.Struct({
  kind: Schema.Literals(WORKFLOW_OWNER_KINDS),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export type WorkflowOwner = typeof WorkflowOwnerSchema.Type

/** What the rule reads: the agents of one server, as stored. */
export interface ParticipantModel {
  readonly agents: readonly { readonly id: string; readonly archived?: boolean }[]
}

/**
 * The agents that may be the agent of an agent step. An archived agent never is. The owner is one
 * that exists (`Workflow.owner` is none when the agent is gone, spec 010, "When the owner is
 * gone"). An owner that the model does not hold has no participants.
 */
export const workflowParticipants = (
  owner: WorkflowOwner | null,
  model: ParticipantModel,
): ReadonlySet<string> => {
  const alive = new Set(model.agents.filter((a) => a.archived !== true).map((a) => a.id))
  if (owner === null) return alive
  return new Set(alive.has(owner.id) ? [owner.id] : [])
}

export const isParticipant = (
  owner: WorkflowOwner | null,
  model: ParticipantModel,
  agentId: string,
): boolean => workflowParticipants(owner, model).has(agentId)
