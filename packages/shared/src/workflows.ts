import { Schema } from "effect"
import { ScheduleSchema } from "./routines.ts"

export const WORKFLOW_NAME_MAX = 60
export const WORKFLOW_STEPS_MAX = 30
export const STEP_TEXT_MAX = 20_000

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const Text = Schema.String.check(Schema.isMaxLength(STEP_TEXT_MAX))
const Name = Schema.String.check(Schema.isMaxLength(WORKFLOW_NAME_MAX))
const Pos = { x: Schema.Number, y: Schema.Number }

export const StepSchema = Schema.Union([
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("agent"),
    name: Name,
    ...Pos,
    agentId: Schema.String,
    /** `{{input}}` is the result of the steps before; `{{trigger}}` is what started the run. */
    prompt: Text,
    continueOnFailure: Schema.Boolean,
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("condition"),
    name: Name,
    ...Pos,
    /** The branch `yes` is taken when the input contains this text (ignoring case). */
    contains: Text,
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("approval"),
    name: Name,
    ...Pos,
    message: Text,
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("post"),
    name: Name,
    ...Pos,
    channelId: Schema.String,
    text: Text,
  }),
])
export type Step = typeof StepSchema.Type
export type StepKind = Step["kind"]
export const STEP_KINDS = ["agent", "condition", "approval", "post"] as const

export const EdgeSchema = Schema.Struct({
  id: Id,
  from: Id,
  to: Id,
  /** For an edge that leaves a condition. */
  branch: Schema.optionalKey(Schema.Literals(["yes", "no"])),
})
export type Edge = typeof EdgeSchema.Type

export const TriggerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({ kind: Schema.Literal("schedule"), schedule: ScheduleSchema }),
  Schema.Struct({
    kind: Schema.Literal("channel"),
    channelId: Schema.String,
    contains: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
])
export type Trigger = typeof TriggerSchema.Type

export const WorkflowInput = Schema.Struct({
  serverId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(WORKFLOW_NAME_MAX)),
  trigger: TriggerSchema,
  steps: Schema.Array(StepSchema).check(Schema.isMaxLength(WORKFLOW_STEPS_MAX)),
  edges: Schema.Array(EdgeSchema),
})
export type WorkflowInput = typeof WorkflowInput.Type

export const WorkflowPatch = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(WORKFLOW_NAME_MAX)),
  ),
  trigger: Schema.optionalKey(TriggerSchema),
  steps: Schema.optionalKey(Schema.Array(StepSchema).check(Schema.isMaxLength(WORKFLOW_STEPS_MAX))),
  edges: Schema.optionalKey(Schema.Array(EdgeSchema)),
  enabled: Schema.optionalKey(Schema.Boolean),
})
export type WorkflowPatch = typeof WorkflowPatch.Type

export interface Workflow {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly trigger: Trigger
  readonly steps: readonly Step[]
  readonly edges: readonly Edge[]
  /** A schedule or channel trigger only fires while this is on. */
  readonly enabled: boolean
  /** True while a run goes: the editor is read-only. */
  readonly running: boolean
  readonly createdAt: number
}

export const RUN_STATES = ["running", "done", "failed", "cancelled"] as const
export type RunState = (typeof RUN_STATES)[number]
export const STEP_STATES = ["pending", "running", "waiting", "done", "failed", "skipped"] as const
export type StepState = (typeof STEP_STATES)[number]

export interface WorkflowRun {
  readonly id: string
  readonly workflowId: string
  readonly state: RunState
  /** What started the run: `manual`, `schedule`, or `channel`. */
  readonly trigger: string
  readonly triggerText: string
  readonly startedAt: number
  readonly finishedAt: number | null
}

export interface RunStep {
  readonly stepId: string
  readonly name: string
  readonly kind: StepKind
  readonly state: StepState
  readonly input: string
  readonly result: string
  readonly error: string
  readonly taskId: string | null
}

export interface WorkflowRunDetail {
  readonly run: WorkflowRun
  readonly steps: readonly RunStep[]
}

/**
 * Why a graph cannot run, or null. Steps need one id each, edges must join two steps, a
 * condition edge needs a branch, and the graph must have no cycle.
 */
export const graphProblem = (
  steps: readonly Pick<Step, "id" | "kind">[],
  edges: readonly Edge[],
): "no_steps" | "duplicate_step" | "bad_edge" | "missing_branch" | "cycle" | null => {
  if (steps.length === 0) return "no_steps"
  const kinds = new Map(steps.map((s) => [s.id, s.kind]))
  if (kinds.size !== steps.length) return "duplicate_step"
  const incoming = new Map<string, number>(steps.map((s) => [s.id, 0]))
  for (const e of edges) {
    if (!kinds.has(e.from) || !kinds.has(e.to) || e.from === e.to) return "bad_edge"
    if (kinds.get(e.from) === "condition" && !e.branch) return "missing_branch"
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)
  }
  // Kahn: a graph with a cycle leaves steps that never reach zero inputs.
  const queue = [...incoming].filter(([, n]) => n === 0).map(([id]) => id)
  let seen = 0
  while (queue.length > 0) {
    const id = queue.pop() as string
    seen++
    for (const e of edges.filter((x) => x.from === id)) {
      const left = (incoming.get(e.to) ?? 0) - 1
      incoming.set(e.to, left)
      if (left === 0) queue.push(e.to)
    }
  }
  return seen === steps.length ? null : "cycle"
}

/** The text of a prompt with `{{input}}` and `{{trigger}}` filled in. */
export const fillTemplate = (template: string, input: string, trigger: string) =>
  template.replaceAll("{{input}}", input).replaceAll("{{trigger}}", trigger)
