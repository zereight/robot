/**
 * The review before an import of an agent file or a workflow file (spec 014, "Review before an
 * import"), and the checklist that the app shows after it.
 */

/** A field of the file that this version does not know, so the import does not make it. */
export interface IgnoredField {
  /** The name of the agent or the workflow in the file. Null for a field of the file object. */
  readonly owner: string | null
  /** The place of the field inside its owner, for example `model` or `routines[0].place`. */
  readonly field: string
}

/** Something that the file holds and ROBot does not make, with the reason. */
export type NotImported =
  | { readonly reason: "unknown_field"; readonly owner: string | null; readonly field: string }
  /**
   * The trigger of a workflow file of an older version that ROBot has no more (a message in a
   * channel, spec 010). The workflow is made with the trigger "manual".
   */
  | { readonly reason: "no_trigger"; readonly owner: string; readonly trigger: string }
  /** A ticked skill of a team file whose agents the user did not tick (spec 002). */
  | { readonly reason: "skill_no_agent"; readonly owner: string }
  /** A skill over the limit of 100 skills of the server (spec 017). */
  | { readonly reason: "skills_full"; readonly owner: string }
  /**
   * A node of a CC Workflow Studio file, or a step of an older workflow file (a post step), that has
   * no step in ROBot: it became a note (spec 010).
   */
  | {
      readonly reason: "no_step"
      readonly owner: string
      readonly nodeType: string
      readonly name: string
    }
  /** A text of a CC Workflow Studio file that the import cut to its limit (spec 010). */
  | { readonly reason: "text_cut"; readonly owner: string; readonly name: string }

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const SCHEDULE_KEYS: Record<string, readonly string[]> = {
  once: ["at"],
  every: ["minutes", "from"],
  daily: ["times"],
  weekly: ["days", "time"],
  cron: ["expr"],
}

/** The keys of `value` that are not in `known`, as paths under `path`. */
const extra = (value: unknown, known: readonly string[], path: string): string[] =>
  isObject(value)
    ? Object.keys(value)
        .filter((key) => !known.includes(key))
        .map((key) => (path ? `${path}.${key}` : key))
    : []

const scheduleExtra = (value: unknown, path: string): string[] =>
  isObject(value) ? extra(value, ["kind", ...(SCHEDULE_KEYS[String(value.kind)] ?? [])], path) : []

const nameOf = (value: unknown): string | null =>
  isObject(value) && typeof value.name === "string" ? value.name.trim() : null

const parseRoot = (text: string): unknown => {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
}

/**
 * The fields of an agent file that the format does not define. Call it only for a file that
 * `parseAgentFile` read without a fault. The fields `skills` and `handbook` are defined from
 * version 2: in a file of version 1 they are unknown fields. The `channels` of a file of an older
 * version are an unknown field too: ROBot has no channels.
 */
export const ignoredAgentFields = (text: string): IgnoredField[] => {
  const root = parseRoot(text)
  if (!isObject(root)) return []
  const second = typeof root.version === "number" && root.version >= 2
  const out: IgnoredField[] = extra(
    root,
    second
      ? ["format", "version", "agents", "skills", "handbook"]
      : ["format", "version", "agents"],
    "",
  ).map((field) => ({ owner: null, field }))
  if (second) {
    for (const skill of Array.isArray(root.skills) ? root.skills : []) {
      if (!isObject(skill)) continue
      const owner = nameOf(skill)
      for (const field of extra(skill, ["name", "description", "instructions", "agents"], ""))
        out.push({ owner, field })
    }
  }
  const agents = Array.isArray(root.agents) ? root.agents : []
  for (const agent of agents) {
    if (!isObject(agent)) continue
    const owner = nameOf(agent)
    const fields = extra(agent, ["name", "role", "instructions", "face", "routines"], "")
    fields.push(...extra(agent.face, ["shape", "hue"], "face"))
    const routines = Array.isArray(agent.routines) ? agent.routines : []
    for (const [j, routine] of routines.entries()) {
      fields.push(...extra(routine, ["name", "prompt", "schedule"], `routines[${j}]`))
      if (isObject(routine))
        fields.push(...scheduleExtra(routine.schedule, `routines[${j}].schedule`))
    }
    for (const field of fields) out.push({ owner, field })
  }
  return out
}

const STEP_KEYS: Record<string, readonly string[]> = {
  agent: ["agent", "prompt", "effort", "continueOnFailure"],
  condition: ["mode", "text"],
  approval: ["message"],
  post: ["text"],
  notify: ["title"],
}

/**
 * The fields of a workflow file that the format does not define. Call it only for a file that
 * `parseWorkflowFile` read without a fault.
 */
export const ignoredWorkflowFields = (text: string): IgnoredField[] => {
  const root = parseRoot(text)
  if (!isObject(root)) return []
  const out: IgnoredField[] = extra(root, ["format", "version", "workflows"], "").map((field) => ({
    owner: null,
    field,
  }))
  const workflows = Array.isArray(root.workflows) ? root.workflows : []
  for (const workflow of workflows) {
    if (!isObject(workflow)) continue
    const owner = nameOf(workflow)
    const fields = extra(workflow, ["name", "trigger", "steps", "connections", "notes"], "")
    const trigger = workflow.trigger
    if (isObject(trigger)) {
      fields.push(
        ...extra(trigger, trigger.kind === "schedule" ? ["kind", "schedule"] : ["kind"], "trigger"),
      )
      if (trigger.kind === "schedule")
        fields.push(...scheduleExtra(trigger.schedule, "trigger.schedule"))
    }
    const list = (key: string) => (Array.isArray(workflow[key]) ? (workflow[key] as unknown[]) : [])
    for (const [i, step] of list("steps").entries()) {
      if (!isObject(step)) continue
      const own = STEP_KEYS[String(step.kind)] ?? []
      fields.push(...extra(step, ["kind", "name", "x", "y", ...own], `steps[${i}]`))
    }
    for (const [i, connection] of list("connections").entries())
      fields.push(...extra(connection, ["from", "to", "branch"], `connections[${i}]`))
    for (const [i, note] of list("notes").entries())
      fields.push(...extra(note, ["text", "tone", "x", "y"], `notes[${i}]`))
    for (const field of fields) out.push({ owner, field })
  }
  return out
}

/** What the user ticked for one agent of the file. */
export interface AgentPick {
  /** The place of the agent in the file, from 0. */
  readonly index: number
  /** False: the new agent has empty instructions. */
  readonly instructions: boolean
  /** The places of the routines of this agent in the file, from 0. */
  readonly routines: readonly number[]
}

/** One thing that still needs the user after an import. */
export type ChecklistItem =
  /** A routine that starts paused: "Turn on". */
  | { readonly kind: "routine"; readonly routineId: string; readonly name: string }
  /** An agent step with no agent: "Pick". */
  | { readonly kind: "stepAgent"; readonly stepId: string; readonly name: string }
  /** A step that lost an input at a node of a CC Workflow Studio file that became a note: "Connect". */
  | { readonly kind: "stepConnect"; readonly stepId: string; readonly name: string }
  /** A workflow with a schedule that is off: "Turn on". */
  | { readonly kind: "workflowOn" }

/** The checklist message of a new agent, or the checklist at the top of a new workflow. */
export interface ImportChecklist {
  readonly id: string
  readonly items: readonly ChecklistItem[]
  readonly createdAt: number
}

/** What a checklist needs to know to tell if an item is done. */
export interface ChecklistWorld {
  /** Undefined when the routine is gone. */
  readonly routine?: (id: string) => { readonly enabled: boolean } | undefined
  readonly workflow?: {
    readonly enabled: boolean
    readonly steps: readonly (
      | { readonly id: string; readonly kind: "agent"; readonly agentId: string }
      | { readonly id: string; readonly kind: "condition" | "approval" | "notify" }
    )[]
    /** The connections of the workflow. An item "Connect" needs them. */
    readonly edges?: readonly { readonly to: string }[]
  }
}

/**
 * True when the user did what the item asks. An item whose routine or step is gone has nothing
 * left to do, so it is done too.
 */
export const checklistItemDone = (item: ChecklistItem, world: ChecklistWorld): boolean => {
  switch (item.kind) {
    case "routine": {
      const routine = world.routine?.(item.routineId)
      return routine === undefined || routine.enabled
    }
    case "stepAgent": {
      const step = world.workflow?.steps.find((s) => s.id === item.stepId)
      return !step || (step.kind === "agent" && step.agentId !== "")
    }
    case "stepConnect": {
      const workflow = world.workflow
      const step = workflow?.steps.find((s) => s.id === item.stepId)
      return !step || (workflow?.edges ?? []).some((e) => e.to === item.stepId)
    }
    case "workflowOn":
      return world.workflow?.enabled === true
  }
}

/** The tick boxes of one agent on the review screen. */
export interface AgentTicks {
  readonly agent: boolean
  readonly instructions: boolean
  readonly routines: readonly boolean[]
}

interface ReviewAgent {
  readonly secretRemoved: boolean
  readonly instructions: { readonly length: number; readonly secretRemoved: boolean }
  readonly routines: readonly { readonly secretRemoved: boolean }[]
}

/**
 * The ticks at the start: agents and instructions are ticked, routines are not, because they run
 * by themselves. A part where the app hid a secret is not ticked.
 */
export const startAgentTicks = (agents: readonly ReviewAgent[]): AgentTicks[] =>
  agents.map((a) => ({
    agent: !a.secretRemoved,
    instructions: !a.instructions.secretRemoved,
    routines: a.routines.map(() => false),
  }))

/**
 * What the import makes from the ticks. An agent that is not ticked takes its instructions and
 * routines with it.
 */
export const agentPicks = (ticks: readonly AgentTicks[]): AgentPick[] =>
  ticks.flatMap((t, index) =>
    t.agent
      ? [
          {
            index,
            instructions: t.instructions,
            routines: t.routines.flatMap((on, j) => (on ? [j] : [])),
          },
        ]
      : [],
  )

/** The counts that the review shows: the agents and the routines (paused) that it will make. */
export const agentCounts = (ticks: readonly AgentTicks[]) => {
  const picks = agentPicks(ticks)
  return {
    agents: picks.length,
    routines: picks.reduce((sum, p) => sum + p.routines.length, 0),
  }
}

/**
 * The ticks at the start for workflows: a workflow where the app hid a secret, or that lost a
 * connection at a node of a CC Workflow Studio file, is not ticked.
 */
export const startWorkflowTicks = (
  workflows: readonly { readonly secretRemoved: boolean; readonly lostConnections: boolean }[],
): boolean[] => workflows.map((w) => !w.secretRemoved && !w.lostConnections)

/** The places in the file of the workflows that are ticked. */
export const workflowPicks = (ticks: readonly boolean[]): number[] =>
  ticks.flatMap((on, i) => (on ? [i] : []))
