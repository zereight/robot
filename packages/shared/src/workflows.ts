import { Schema } from "effect"
import { EFFORT_LEVELS } from "./providers.ts"
import { ScheduleSchema } from "./routines.ts"
import { type WorkflowOwner, WorkflowOwnerSchema } from "./workflowOwner.ts"

export const WORKFLOW_NAME_MAX = 60
export const WORKFLOW_STEPS_MAX = 30
export const WORKFLOW_NOTES_MAX = 50
export const STEP_TEXT_MAX = 20_000
export const NOTE_TEXT_MAX = 2_000
export const NOTIFY_TITLE_MAX = 100
/** The first characters of the input that a notify step shows as the body of its notification. */
export const NOTIFY_BODY_MAX = 200
/** The longest part of an answer that an error of a condition holds. */
export const ANSWER_ERROR_MAX = 240

/**
 * The levels of an agent step that sets its own effort, from none to ultra (spec 006, 010). A model
 * that does not list the level gets the effort of the agent instead.
 */
export const STEP_EFFORTS = EFFORT_LEVELS
export type StepEffort = (typeof STEP_EFFORTS)[number]

export const NOTE_TONES = ["yellow", "blue", "green", "pink"] as const
export type NoteTone = (typeof NOTE_TONES)[number]

export const CONDITION_MODES = ["contains", "ask"] as const
export type ConditionMode = (typeof CONDITION_MODES)[number]

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
    /** Empty when the step has no agent yet ("Pick an agent"). */
    agentId: Schema.String,
    /** `{{input}}` is the result of the steps before; `{{trigger}}` is what started the run. */
    prompt: Text,
    continueOnFailure: Schema.Boolean,
    /** Missing means that the step follows the effort of its agent. */
    effort: Schema.optionalKey(Schema.Literals(STEP_EFFORTS)),
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("condition"),
    name: Name,
    ...Pos,
    /**
     * In mode "contains" the branch `yes` is taken when the input contains this text (ignoring
     * case). In mode "ask" it is the yes or no question about the input. The field keeps its name
     * from the time when a condition could only test for a text.
     */
    contains: Text,
    /** Missing means "contains": a condition that was made before the second mode still works. */
    mode: Schema.optionalKey(Schema.Literals(CONDITION_MODES)),
    /** The model that answers in mode "ask". Missing means that the app picks one. */
    provider: Schema.optionalKey(Schema.Struct({ accountId: Schema.String, model: Schema.String })),
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
    /** Empty when the step has no place yet ("Pick a place"). */
    channelId: Schema.String,
    text: Text,
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("notify"),
    name: Name,
    ...Pos,
    /** The title of the system notification. */
    title: Schema.String.check(Schema.isMaxLength(NOTIFY_TITLE_MAX)),
  }),
])
export type Step = typeof StepSchema.Type
export type StepKind = Step["kind"]
export const STEP_KINDS = ["agent", "condition", "approval", "post", "notify"] as const

/**
 * A text on the canvas. It has no connection, no node number and no effect on a run, and it does
 * not count towards the limit of steps.
 */
export const NoteSchema = Schema.Struct({
  id: Id,
  text: Schema.String.check(Schema.isMaxLength(NOTE_TEXT_MAX)),
  tone: Schema.Literals(NOTE_TONES),
  ...Pos,
})
export type Note = typeof NoteSchema.Type

export const EdgeSchema = Schema.Struct({
  id: Id,
  from: Id,
  to: Id,
  /** For an edge that leaves a condition. */
  branch: Schema.optionalKey(Schema.Literals(["yes", "no"])),
})
export type Edge = typeof EdgeSchema.Type

/**
 * "Record only" on a schedule or a message trigger: when it fires, no step runs and no model is
 * called. The run history shows a run "Recorded". Run now still runs the workflow.
 */
const RecordOnly = Schema.optionalKey(Schema.Boolean)

export const TriggerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    schedule: ScheduleSchema,
    recordOnly: RecordOnly,
  }),
  Schema.Struct({
    kind: Schema.Literal("channel"),
    channelId: Schema.String,
    contains: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    recordOnly: RecordOnly,
  }),
])
export type Trigger = typeof TriggerSchema.Type

export const WorkflowInput = Schema.Struct({
  serverId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(WORKFLOW_NAME_MAX)),
  trigger: TriggerSchema,
  steps: Schema.Array(StepSchema).check(Schema.isMaxLength(WORKFLOW_STEPS_MAX)),
  edges: Schema.Array(EdgeSchema),
  notes: Schema.optionalKey(Schema.Array(NoteSchema).check(Schema.isMaxLength(WORKFLOW_NOTES_MAX))),
  /** Absent or null: no owner, a shared workflow (spec 010, "Owner and participants"). */
  owner: Schema.optionalKey(Schema.NullOr(WorkflowOwnerSchema)),
})
export type WorkflowInput = typeof WorkflowInput.Type

export const WorkflowPatch = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(WORKFLOW_NAME_MAX)),
  ),
  trigger: Schema.optionalKey(TriggerSchema),
  steps: Schema.optionalKey(Schema.Array(StepSchema).check(Schema.isMaxLength(WORKFLOW_STEPS_MAX))),
  edges: Schema.optionalKey(Schema.Array(EdgeSchema)),
  notes: Schema.optionalKey(Schema.Array(NoteSchema).check(Schema.isMaxLength(WORKFLOW_NOTES_MAX))),
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Null: back to no owner. Absent: unchanged. */
  owner: Schema.optionalKey(Schema.NullOr(WorkflowOwnerSchema)),
})
export type WorkflowPatch = typeof WorkflowPatch.Type

export interface Workflow {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly trigger: Trigger
  readonly steps: readonly Step[]
  readonly edges: readonly Edge[]
  readonly notes: readonly Note[]
  /** A schedule or channel trigger only fires while this is on. */
  readonly enabled: boolean
  /** True while a run goes: the editor is read-only. */
  readonly running: boolean
  readonly createdAt: number
  /** The name of the other computer where it runs, when it syncs (019). Null: it runs here. */
  readonly runsOn: string | null
  /**
   * The organization or the agent that owns the workflow, or null (spec 010). An owner that is
   * gone counts as null, so it never names an organization or an agent that does not exist.
   */
  readonly owner: WorkflowOwner | null
}

export const RUN_STATES = ["running", "done", "failed", "cancelled", "recorded"] as const
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
  /** The name of the linked device that started the run, or null (spec 012). */
  readonly startedBy: string | null
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
  /** The name of the linked device that answered an approval step, or null (spec 012). */
  readonly decidedBy: string | null
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

/** The number of each step, from 1, in the order of the step list. Notes have none. */
export const nodeNumbers = (steps: readonly Pick<Step, "id">[]): Map<string, number> =>
  new Map(steps.map((s, i) => [s.id, i + 1]))

/** A character that would break one line of a Mermaid flowchart. It becomes a space. */
const DIAGRAM_SPACE = new Set(['"', "[", "]", "{", "}", "|", "\n", "\r"])

const diagramLabel = (name: string) =>
  [...name].map((char) => (DIAGRAM_SPACE.has(char) ? " " : char)).join("")

/**
 * The Mermaid flowchart of a workflow (spec 010, "Diagram"). The node number is the place of the
 * step in `steps`, from 1. Notes and the trigger are not arguments, so they are not in the text.
 */
export const workflowDiagram = (
  steps: readonly Pick<Step, "id" | "kind" | "name">[],
  edges: readonly Pick<Edge, "from" | "to" | "branch">[],
): string => {
  const numbers = nodeNumbers(steps)
  const kindOf = new Map(steps.map((step) => [step.id, step.kind]))
  const lines = ["flowchart TD"]
  for (const step of steps) {
    const n = numbers.get(step.id) ?? 0
    const label = `${n}. ${diagramLabel(step.name)}`
    lines.push(step.kind === "condition" ? `  n${n}{"${label}"}` : `  n${n}["${label}"]`)
  }
  for (const edge of edges) {
    const from = numbers.get(edge.from)
    const to = numbers.get(edge.to)
    if (from === undefined || to === undefined) continue
    const branch = kindOf.get(edge.from) === "condition" && edge.branch ? `|${edge.branch}|` : ""
    lines.push(`  n${from} -->${branch} n${to}`)
  }
  return lines.join("\n")
}

/** The mode of a condition. A condition from before the second mode has none and tests for text. */
export const conditionMode = (step: Extract<Step, { kind: "condition" }>): ConditionMode =>
  step.mode ?? "contains"

/**
 * The agent step that is nearest before a step, along the connections, or null. The nearest
 * has the fewest connections between. Among equals, the one that comes first in the list wins.
 */
export const nearestAgentStep = (
  steps: readonly Step[],
  edges: readonly Edge[],
  stepId: string,
): Extract<Step, { kind: "agent" }> | null => {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const order = new Map(steps.map((s, i) => [s.id, i]))
  const seen = new Set<string>([stepId])
  let level = [stepId]
  while (level.length > 0) {
    const next = new Set<string>()
    for (const id of level)
      for (const e of edges) if (e.to === id && !seen.has(e.from)) next.add(e.from)
    const found = [...next]
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .map((id) => byId.get(id))
      .find((s) => s?.kind === "agent")
    if (found?.kind === "agent") return found
    for (const id of next) seen.add(id)
    level = [...next]
  }
  return null
}

/**
 * The effort that one turn of an agent step runs with. The step's own effort counts only when the
 * model offers it; otherwise the turn takes the effort of the agent. Call it for each try, so a
 * retry reads the step again and not the outcome of the first try.
 */
export const stepTurnEffort = (
  stepEffort: StepEffort | undefined,
  agentEffort: string | null,
  offered: readonly string[],
): string | null =>
  stepEffort !== undefined && offered.includes(stepEffort) ? stepEffort : agentEffort

/** The body of the notification of a notify step: the first characters of the input. */
export const notifyBody = (input: string): string => [...input].slice(0, NOTIFY_BODY_MAX).join("")

/**
 * Reads the answer of a model to a yes or no question. The whole answer must be the one word, in
 * any case, with spaces, marks around it and an end mark allowed. Anything else is null.
 */
export const parseYesNo = (answer: string): "yes" | "no" | null => {
  const match = /^[\s"'`*_(]*(yes|no)[\s"'`*_).!]*$/i.exec(answer)
  return match ? ((match[1] as string).toLowerCase() as "yes" | "no") : null
}

/** The start of an answer for an error: one line, at most `ANSWER_ERROR_MAX` characters. */
export const answerStart = (answer: string): string =>
  [...answer.replace(/\s+/g, " ").trim()].slice(0, ANSWER_ERROR_MAX).join("")

/** The error of a condition whose answer is not yes or no. The text after the colon is the answer. */
export const ANSWER_ERROR = "answer_not_yes_no"
export const answerError = (answer: string): string => `${ANSWER_ERROR}: ${answerStart(answer)}`

/** The tries of a model step or a condition in mode "ask", and the wait between them. */
export const ASK_TRIES = 3
export const ASK_RETRY_MS = 2_000

/**
 * Whether a failed call of a model is tried again. Only a plain failure is: the model could not be
 * reached, or it answered with an error. A usage limit, a busy model, a sign-in that is gone and a
 * model that is not there end the step at once.
 */
export const retryableFailure = (code: string): boolean =>
  code === "provider_unreachable" || code === "provider_error"
