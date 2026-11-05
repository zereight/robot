import { type Workflow, type WorkflowOwner, workflowParticipants } from "@robot/shared"
import { createMemo, createResource } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"

/**
 * The agents that may work in a step of a workflow with this owner (spec 010, "Owner and
 * participants"). It reads the same rule as the run, from the agents and organizations on screen,
 * so a change of a member or of a lead shows at once.
 */
export const useParticipants = (owner: () => WorkflowOwner | null) => {
  const agents = useAgents()
  const orgs = useOrgs()
  return createMemo(() =>
    workflowParticipants(owner(), { agents: agents.agents(), orgs: orgs.orgs() }),
  )
}

/**
 * The name of the owner of a workflow. An archived agent is not in the list of agents on screen, so
 * its name is asked once, and only while a workflow in `workflows` has such an owner.
 */
export const useOwnerNames = (workflows: () => readonly Workflow[]) => {
  const agents = useAgents()
  const orgs = useOrgs()
  const ui = useUi()
  const missing = () =>
    workflows().some((w) => w.owner?.kind === "agent" && !agents.byId(w.owner.id))
  const [archived] = createResource(
    () => (missing() ? ui.server()?.id : undefined),
    (serverId) => call("agents.list", { serverId, archived: true }).catch(() => []),
    { initialValue: [] },
  )
  return (owner: WorkflowOwner | null): string => {
    if (owner === null) return ""
    if (owner.kind === "organization") return orgs.byId(owner.id)?.name ?? ""
    return agents.byId(owner.id)?.name ?? archived().find((a) => a.id === owner.id)?.name ?? ""
  }
}
