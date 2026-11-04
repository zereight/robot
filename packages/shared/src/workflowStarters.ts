import { numberedName } from "./agentFile.ts"
import { nameKey } from "./agents.ts"
import {
  type Edge,
  type Note,
  type Step,
  WORKFLOW_NAME_MAX,
  type WorkflowInput,
} from "./workflows.ts"

// This file holds no interface text. The text of a starter is in `workflowStarterText.ts`, which
// only the window and the tests read: the window picks the language when the user presses Create
// and sends a finished workflow to the app (spec 010, "Starters").

/** The workflow starters, in the order of the list. This version has one. */
export const WORKFLOW_STARTERS = ["tla"] as const
export type WorkflowStarterId = (typeof WORKFLOW_STARTERS)[number]

/**
 * The line that the step "Run TLC" ends its reply with, and the text that the condition looks
 * for. They are the same in every language, because the app reads them (spec 010, "Rules of the
 * starter").
 */
export const TLC_RESULT_WORD = "TLC_RESULT:"
export const TLC_PASS = `${TLC_RESULT_WORD} PASS`
export const TLC_FAIL = `${TLC_RESULT_WORD} FAIL`

/**
 * The texts of the starter "TLA+ check" in one language. All of them come from the catalogue of
 * the language of the interface, except the condition text, which is the same in every language.
 */
export interface TlaStarterText {
  /** The name of the starter and of the new workflow. */
  readonly name: string
  /** One line about what the workflow does. It shows on the row of the dialog. */
  readonly job: string
  /** A muted line about what the workflow needs. */
  readonly needs: string
  readonly write: { readonly name: string; readonly prompt: string }
  readonly run: { readonly name: string; readonly prompt: string }
  readonly check: { readonly name: string }
  readonly pass: { readonly name: string; readonly title: string }
  readonly explain: { readonly name: string; readonly prompt: string }
  readonly gap: { readonly name: string; readonly title: string }
  /** The yellow note on the canvas. */
  readonly note: string
}

/**
 * Where each node sits on the canvas. A step is 180 wide and 64 high, and a column is 220
 * apart. The branch "yes" goes up and the branch "no" goes down, so no connection crosses another.
 */
const PLACE = {
  write: { x: 0, y: 70 },
  run: { x: 220, y: 70 },
  check: { x: 440, y: 70 },
  pass: { x: 660, y: 0 },
  explain: { x: 660, y: 140 },
  gap: { x: 880, y: 140 },
  note: { x: 0, y: 200 },
} as const

/**
 * The graph of "TLA+ check" (spec 010, "The graph of TLA+ check"): six steps in the order of the
 * node numbers, five connections and one yellow note. Every agent step names `agentId`. The
 * trigger is manual.
 *
 * `name` is the name that the new workflow gets, which the caller has made free (see
 * `starterWorkflowName`).
 */
export const buildTlaStarter = (input: {
  readonly serverId: string
  readonly name: string
  readonly agentId: string
  readonly text: TlaStarterText
}): WorkflowInput => {
  const { text, agentId } = input
  const agent = (
    id: string,
    name: string,
    prompt: string,
    at: { readonly x: number; readonly y: number },
  ): Step => ({
    id,
    kind: "agent",
    name,
    ...at,
    agentId,
    prompt,
    continueOnFailure: false,
  })
  const steps: Step[] = [
    agent("s1", text.write.name, text.write.prompt, PLACE.write),
    agent("s2", text.run.name, text.run.prompt, PLACE.run),
    {
      id: "s3",
      kind: "condition",
      name: text.check.name,
      ...PLACE.check,
      mode: "contains",
      contains: TLC_PASS,
    },
    {
      id: "s4",
      kind: "notify",
      name: text.pass.name,
      ...PLACE.pass,
      title: text.pass.title,
    },
    agent("s5", text.explain.name, text.explain.prompt, PLACE.explain),
    {
      id: "s6",
      kind: "notify",
      name: text.gap.name,
      ...PLACE.gap,
      title: text.gap.title,
    },
  ]
  const edges: Edge[] = [
    { id: "c1", from: "s1", to: "s2" },
    { id: "c2", from: "s2", to: "s3" },
    { id: "c3", from: "s3", to: "s4", branch: "yes" },
    { id: "c4", from: "s3", to: "s5", branch: "no" },
    { id: "c5", from: "s5", to: "s6" },
  ]
  const notes: Note[] = [{ id: "n1", text: text.note, tone: "yellow", ...PLACE.note }]
  return {
    serverId: input.serverId,
    name: input.name,
    trigger: { kind: "manual" },
    steps,
    edges,
    notes,
  }
}

/**
 * The name of a new workflow from a starter: the name of the starter, or that name with a number
 * when a workflow has it already (ignoring case), inside the length limit. It is the rule of an
 * import (spec 010, "Workflow file").
 */
export const starterWorkflowName = (starterName: string, taken: Iterable<string>): string => {
  const used = new Set<string>()
  for (const name of taken) used.add(nameKey(name))
  return numberedName(starterName, (candidate) => used.has(nameKey(candidate)), WORKFLOW_NAME_MAX)
}

/**
 * The agent that the field "Agent" starts with: the main agent, or, when there is none (or it is
 * not in the list), the first agent of the list. Empty when the list is empty.
 */
export const defaultStarterAgent = (
  agents: readonly { readonly id: string }[],
  mainAgentId: string | null = null,
): string => {
  if (mainAgentId !== null && agents.some((a) => a.id === mainAgentId)) return mainAgentId
  return agents[0]?.id ?? ""
}

/**
 * Why "New from a starter" is off, or null when it is on (spec 010, "Way in"). A linked computer
 * without the switch "Can create and change agents" gets the reason about the switch first,
 * because it cannot make an agent either. `canChange` is true on the computer that holds the
 * workflows, and on a linked one only with the switch.
 */
export const starterMenuOff = (input: {
  readonly canChange: boolean
  readonly agentCount: number
}): "no_switch" | "no_agent" | null =>
  !input.canChange ? "no_switch" : input.agentCount === 0 ? "no_agent" : null
