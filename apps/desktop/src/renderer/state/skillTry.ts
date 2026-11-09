import type { Skill } from "@robot/shared"
import { createSignal } from "solid-js"

/**
 * A request to put the chip of a saved skill in the message box of a workflow (spec 017, "Make a
 * skill from a workflow", step 5: "Try it"). The draft dialog and the chat do not share a parent,
 * so they share this signal.
 */
export interface SkillTry {
  readonly workflowId: string
  readonly skill: Skill
}

const [request, setRequest] = createSignal<SkillTry | null>(null)

export const skillTryRequest = request
export const trySkill = (workflowId: string, skill: Skill) => setRequest({ workflowId, skill })
export const clearSkillTry = () => setRequest(null)
