import type { Agent } from "@robot/shared"
import { call } from "../lib/rpc.ts"
import type { AgentFormValues } from "./AgentForm.tsx"

/**
 * Makes the agent of the new agent form. With a starter picked, the app also makes the routine
 * and the skill of the starter (spec 002). Without one, it is a plain agent.
 */
export const createAgent = (serverId: string, values: AgentFormValues): Promise<Agent> => {
  const { starter, ...fields } = values
  return starter
    ? call("agents.createFromStarter", { serverId, ...fields, starter })
    : call("agents.create", { serverId, ...fields })
}
