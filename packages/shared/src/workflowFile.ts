import { readSchedule } from "./agentFile.ts"
import { AGENT_NAME_MAX, charLength, nameKey } from "./agents.ts"
import type { NotImported } from "./importReview.ts"
import type { Schedule } from "./schedule.ts"
import {
  type ConditionMode,
  NOTE_TEXT_MAX,
  NOTE_TONES,
  NOTIFY_TITLE_MAX,
  type NoteTone,
  STEP_EFFORTS,
  STEP_TEXT_MAX,
  type Step,
  type StepEffort,
  WORKFLOW_NAME_MAX,
  WORKFLOW_NOTES_MAX,
  WORKFLOW_STEPS_MAX,
  type WorkflowInput,
} from "./workflows.ts"

/** The value of the `format` field. It tells a workflow file from other JSON files. */
export const WORKFLOW_FILE_FORMAT = "robot-workflows"
/** The format version that this app writes and reads. */
export const WORKFLOW_FILE_VERSION = 1
export const WORKFLOW_FILE_MAX_WORKFLOWS = 20
export const WORKFLOW_FILE_MAX_BYTES = 10 * 1024 * 1024

/** The distance, in canvas units, between the places of steps that a file does not place. */
const GRID_X = 230
const GRID_Y = 110
/** A place outside this range is not a place on a canvas that a person can use. */
const PLACE_MAX = 1_000_000

export type WorkflowFileTrigger =
  | { readonly kind: "manual" }
  | { readonly kind: "schedule"; readonly schedule: Schedule }

interface FileStepBase {
  readonly name: string
  readonly x: number
  readonly y: number
}
export type WorkflowFileStep =
  | (FileStepBase & {
      readonly kind: "agent"
      /** The name of the agent. Empty when the file names none. */
      readonly agent: string
      readonly prompt: string
      readonly effort: StepEffort | null
      readonly continueOnFailure: boolean
    })
  | (FileStepBase & {
      readonly kind: "condition"
      readonly mode: ConditionMode
      readonly text: string
    })
  | (FileStepBase & { readonly kind: "approval"; readonly message: string })
  | (FileStepBase & { readonly kind: "post"; readonly text: string })
  | (FileStepBase & { readonly kind: "notify"; readonly title: string })

export interface WorkflowFileConnection {
  /** The node number of the step where the connection starts, from 1. */
  readonly from: number
  readonly to: number
  /** Only for a connection that leaves a condition. */
  readonly branch: "yes" | "no" | null
}

export interface WorkflowFileNote {
  readonly text: string
  readonly tone: NoteTone
  readonly x: number
  readonly y: number
}

export interface WorkflowFileWorkflow {
  readonly name: string
  readonly trigger: WorkflowFileTrigger
  readonly steps: readonly WorkflowFileStep[]
  readonly connections: readonly WorkflowFileConnection[]
  readonly notes: readonly WorkflowFileNote[]
}

export interface WorkflowFile {
  readonly workflows: readonly WorkflowFileWorkflow[]
}

/** The faults of a graph that make the app refuse a file, or an export. */
export type GraphFaultKind =
  | "too_many_steps"
  | "unknown_step"
  | "self_connection"
  | "missing_branch"
  | "branches"
  | "cycle"

/** Where a fault is. `n` counts from 1: the number of the step or of the connection. */
export interface GraphFault {
  /** The name of the workflow, as the file gives it. */
  readonly workflow: string
  readonly fault: GraphFaultKind
  readonly place: { readonly kind: "steps" | "step" | "connection"; readonly n: number }
}

/** Why a file is refused. `detail` is a path in the file, a name, or JSON of a `GraphFault`. */
export type WorkflowFileErrorCode =
  | "workflow_file_format"
  | "workflow_file_version"
  | "workflow_file_too_large"
  | "workflow_file_too_many"
  | "workflow_file_empty"
  | "workflow_file_duplicate"
  | "workflow_file_field"
  | "workflow_file_name_length"
  | "workflow_file_schedule"
  | "workflow_file_graph"

export type WorkflowFileParse =
  | { readonly ok: true; readonly file: WorkflowFile }
  | { readonly ok: false; readonly code: WorkflowFileErrorCode; readonly detail?: string }

type Failure = Extract<WorkflowFileParse, { ok: false }>

const fail = (code: WorkflowFileErrorCode, detail?: string): Failure =>
  detail === undefined ? { ok: false, code } : { ok: false, code, detail }

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isInt = (value: unknown, min: number, max = Number.POSITIVE_INFINITY): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max

type Read<T> = { readonly ok: true; readonly value: T } | Failure

/** A text field that may be missing. Its length counts characters. */
const readText = (
  obj: Json,
  key: string,
  path: string,
  max: number,
  fallback: string,
): Read<string> => {
  const value = obj[key]
  if (value === undefined || value === null) return { ok: true, value: fallback }
  if (typeof value !== "string" || charLength(value) > max)
    return fail("workflow_file_field", `${path}.${key}`)
  return { ok: true, value }
}

/** A name: spaces at both ends are removed, and it has 1 to `max` characters. */
const readName = (obj: Json, path: string, max: number): Read<string> => {
  const value = obj.name
  if (typeof value !== "string") return fail("workflow_file_field", `${path}.name`)
  const name = value.trim()
  if (charLength(name) < 1 || charLength(name) > max)
    return fail("workflow_file_name_length", `${path}.name`)
  return { ok: true, value: name }
}

const readPlace = (obj: Json, key: "x" | "y", path: string, fallback: number): Read<number> => {
  const value = obj[key]
  if (value === undefined || value === null) return { ok: true, value: fallback }
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > PLACE_MAX)
    return fail("workflow_file_field", `${path}.${key}`)
  return { ok: true, value: Math.round(value) }
}

/** Steps and notes that a file does not place go on a grid, three in a row. */
export const gridPlace = (index: number, firstRow = 0) => ({
  x: (index % 3) * GRID_X,
  y: (Math.floor(index / 3) + firstRow) * GRID_Y,
})

const readStep = (value: unknown, path: string, index: number): Read<WorkflowFileStep> => {
  if (!isObject(value)) return fail("workflow_file_field", path)
  const name = readName(value, path, WORKFLOW_NAME_MAX)
  if (!name.ok) return name
  const grid = gridPlace(index)
  const x = readPlace(value, "x", path, grid.x)
  if (!x.ok) return x
  const y = readPlace(value, "y", path, grid.y)
  if (!y.ok) return y
  const base = { name: name.value, x: x.value, y: y.value }
  switch (value.kind) {
    case "agent": {
      const agent = readText(value, "agent", path, AGENT_NAME_MAX, "")
      if (!agent.ok) return agent
      const prompt = readText(value, "prompt", path, STEP_TEXT_MAX, "")
      if (!prompt.ok) return prompt
      const effort = value.effort
      if (
        effort !== undefined &&
        effort !== null &&
        !(STEP_EFFORTS as readonly unknown[]).includes(effort)
      )
        return fail("workflow_file_field", `${path}.effort`)
      const keep = value.continueOnFailure
      if (keep !== undefined && keep !== null && typeof keep !== "boolean")
        return fail("workflow_file_field", `${path}.continueOnFailure`)
      return {
        ok: true,
        value: {
          ...base,
          kind: "agent",
          agent: agent.value.trim(),
          prompt: prompt.value,
          effort: (effort ?? null) as StepEffort | null,
          continueOnFailure: keep === true,
        },
      }
    }
    case "condition": {
      const mode = value.mode
      if (mode !== undefined && mode !== null && mode !== "contains" && mode !== "ask")
        return fail("workflow_file_field", `${path}.mode`)
      const text = readText(value, "text", path, STEP_TEXT_MAX, "")
      if (!text.ok) return text
      return {
        ok: true,
        value: {
          ...base,
          kind: "condition",
          mode: mode === "ask" ? "ask" : "contains",
          text: text.value,
        },
      }
    }
    case "approval": {
      const message = readText(value, "message", path, STEP_TEXT_MAX, "")
      if (!message.ok) return message
      return { ok: true, value: { ...base, kind: "approval", message: message.value } }
    }
    case "post": {
      const text = readText(value, "text", path, STEP_TEXT_MAX, "{{input}}")
      if (!text.ok) return text
      return { ok: true, value: { ...base, kind: "post", text: text.value } }
    }
    case "notify": {
      const title = readText(value, "title", path, NOTIFY_TITLE_MAX, "")
      if (!title.ok) return title
      return { ok: true, value: { ...base, kind: "notify", title: title.value } }
    }
    default:
      return fail("workflow_file_field", `${path}.kind`)
  }
}

const readConnection = (
  value: unknown,
  path: string,
  steps: number,
  name: string,
  index: number,
  kinds: readonly WorkflowFileStep["kind"][],
): Read<WorkflowFileConnection> => {
  const place = { kind: "connection" as const, n: index + 1 }
  if (!isObject(value)) return fail("workflow_file_field", path)
  if (!isInt(value.from, 1)) return fail("workflow_file_field", `${path}.from`)
  if (!isInt(value.to, 1)) return fail("workflow_file_field", `${path}.to`)
  const branch = value.branch
  if (branch !== undefined && branch !== null && branch !== "yes" && branch !== "no")
    return fail("workflow_file_field", `${path}.branch`)
  const graph = (fault: GraphFaultKind) =>
    fail(
      "workflow_file_graph",
      JSON.stringify({ workflow: name, fault, place } satisfies GraphFault),
    )
  if (value.from > steps || value.to > steps) return graph("unknown_step")
  if (value.from === value.to) return graph("self_connection")
  const fromCondition = kinds[value.from - 1] === "condition"
  if (fromCondition && !branch) return graph("missing_branch")
  // A branch is only for a connection that leaves a condition. On another one it means nothing.
  return {
    ok: true,
    value: {
      from: value.from,
      to: value.to,
      branch: fromCondition ? (branch as "yes" | "no") : null,
    },
  }
}

const readNote = (
  value: unknown,
  path: string,
  index: number,
  firstRow: number,
): Read<WorkflowFileNote> => {
  if (!isObject(value)) return fail("workflow_file_field", path)
  const text = readText(value, "text", path, NOTE_TEXT_MAX, "")
  if (!text.ok) return text
  const tone = value.tone
  if (tone !== undefined && tone !== null && !(NOTE_TONES as readonly unknown[]).includes(tone))
    return fail("workflow_file_field", `${path}.tone`)
  const grid = gridPlace(index, firstRow)
  const x = readPlace(value, "x", path, grid.x)
  if (!x.ok) return x
  const y = readPlace(value, "y", path, grid.y)
  if (!y.ok) return y
  return {
    ok: true,
    value: { text: text.value, tone: (tone ?? "yellow") as NoteTone, x: x.value, y: y.value },
  }
}

/**
 * The first fault in the graph of a workflow, or null. The rules: a connection joins two steps
 * that exist, never a step to itself; a connection that leaves a condition has a branch; a
 * condition has a connection for the branch Yes and one for the branch No; the connections make
 * no loop; and a workflow has at most `WORKFLOW_STEPS_MAX` steps.
 */
export const graphFault = (
  workflow: string,
  steps: readonly Pick<WorkflowFileStep, "kind">[],
  connections: readonly WorkflowFileConnection[],
): GraphFault | null => {
  const found = (
    fault: GraphFaultKind,
    kind: GraphFault["place"]["kind"],
    n: number,
  ): GraphFault => ({
    workflow,
    fault,
    place: { kind, n },
  })
  if (steps.length > WORKFLOW_STEPS_MAX) return found("too_many_steps", "steps", steps.length)
  for (const [i, c] of connections.entries()) {
    if (!isInt(c.from, 1, steps.length) || !isInt(c.to, 1, steps.length))
      return found("unknown_step", "connection", i + 1)
    if (c.from === c.to) return found("self_connection", "connection", i + 1)
    if (steps[c.from - 1]?.kind === "condition" && !c.branch)
      return found("missing_branch", "connection", i + 1)
  }
  for (const [i, step] of steps.entries()) {
    if (step.kind !== "condition") continue
    const leaving = connections.filter((c) => c.from === i + 1)
    if (!leaving.some((c) => c.branch === "yes") || !leaving.some((c) => c.branch === "no"))
      return found("branches", "step", i + 1)
  }
  // A walk that meets a step which is still on its path has found a loop: the connection that
  // closes it is the place.
  const state = new Map<number, "path" | "done">()
  let loop: number | null = null
  const walk = (node: number) => {
    state.set(node, "path")
    for (const [i, c] of connections.entries()) {
      if (c.from !== node || loop !== null) continue
      const next = state.get(c.to)
      if (next === "path") loop = i + 1
      else if (next === undefined) walk(c.to)
    }
    state.set(node, "done")
  }
  for (let node = 1; node <= steps.length && loop === null; node++) if (!state.has(node)) walk(node)
  return loop === null ? null : found("cycle", "connection", loop)
}

const readWorkflow = (value: unknown, path: string): Read<WorkflowFileWorkflow> => {
  if (!isObject(value)) return fail("workflow_file_field", path)
  const name = readName(value, path, WORKFLOW_NAME_MAX)
  if (!name.ok) return name

  let trigger: WorkflowFileTrigger = { kind: "manual" }
  const rawTrigger = value.trigger
  if (rawTrigger !== undefined && rawTrigger !== null) {
    if (!isObject(rawTrigger)) return fail("workflow_file_field", `${path}.trigger`)
    if (rawTrigger.kind === "schedule") {
      const schedule = readSchedule(rawTrigger.schedule)
      if (!schedule) return fail("workflow_file_schedule", `${path}.trigger.schedule`)
      trigger = { kind: "schedule", schedule }
    } else if (rawTrigger.kind !== "manual")
      return fail("workflow_file_field", `${path}.trigger.kind`)
  }

  const rawSteps = value.steps ?? []
  if (!Array.isArray(rawSteps)) return fail("workflow_file_field", `${path}.steps`)
  if (rawSteps.length > WORKFLOW_STEPS_MAX)
    return fail(
      "workflow_file_graph",
      JSON.stringify({
        workflow: name.value,
        fault: "too_many_steps",
        place: { kind: "steps", n: rawSteps.length },
      } satisfies GraphFault),
    )
  const steps: WorkflowFileStep[] = []
  for (const [i, raw] of rawSteps.entries()) {
    const step = readStep(raw, `${path}.steps[${i}]`, i)
    if (!step.ok) return step
    steps.push(step.value)
  }

  const rawConnections = value.connections ?? []
  if (!Array.isArray(rawConnections)) return fail("workflow_file_field", `${path}.connections`)
  const kinds = steps.map((s) => s.kind)
  const connections: WorkflowFileConnection[] = []
  for (const [i, raw] of rawConnections.entries()) {
    const connection = readConnection(
      raw,
      `${path}.connections[${i}]`,
      steps.length,
      name.value,
      i,
      kinds,
    )
    if (!connection.ok) return connection
    // The same connection twice means the same as once.
    const twice = connections.some(
      (c) =>
        c.from === connection.value.from &&
        c.to === connection.value.to &&
        c.branch === connection.value.branch,
    )
    if (!twice) connections.push(connection.value)
  }

  const rawNotes = value.notes ?? []
  if (!Array.isArray(rawNotes)) return fail("workflow_file_field", `${path}.notes`)
  if (rawNotes.length > WORKFLOW_NOTES_MAX) return fail("workflow_file_field", `${path}.notes`)
  const firstRow = Math.ceil(steps.length / 3) + 1
  const notes: WorkflowFileNote[] = []
  for (const [i, raw] of rawNotes.entries()) {
    const note = readNote(raw, `${path}.notes[${i}]`, i, firstRow)
    if (!note.ok) return note
    notes.push(note.value)
  }

  const fault = graphFault(name.value, steps, connections)
  if (fault) return fail("workflow_file_graph", JSON.stringify(fault))
  return { ok: true, value: { name: name.value, trigger, steps, connections, notes } }
}

/**
 * Reads the text of a workflow file. Fields that the format does not define are ignored. The
 * size of the file is checked by the caller, before it reads the file (see
 * `WORKFLOW_FILE_MAX_BYTES`). A file that breaks a rule is refused as a whole, and the app makes
 * nothing from it.
 */
export const parseWorkflowFile = (text: string): WorkflowFileParse => {
  let root: unknown
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return fail("workflow_file_format")
  }
  if (!isObject(root) || root.format !== WORKFLOW_FILE_FORMAT) return fail("workflow_file_format")
  if (!isInt(root.version, 1)) return fail("workflow_file_field", "version")
  if (root.version > WORKFLOW_FILE_VERSION)
    return fail("workflow_file_version", String(root.version))
  if (!Array.isArray(root.workflows)) return fail("workflow_file_field", "workflows")
  if (root.workflows.length === 0) return fail("workflow_file_empty")
  if (root.workflows.length > WORKFLOW_FILE_MAX_WORKFLOWS)
    return fail("workflow_file_too_many", String(root.workflows.length))
  const workflows: WorkflowFileWorkflow[] = []
  const seen = new Set<string>()
  for (const [i, entry] of root.workflows.entries()) {
    const workflow = readWorkflow(entry, `workflows[${i}]`)
    if (!workflow.ok) return workflow
    const key = nameKey(workflow.value.name)
    if (seen.has(key)) return fail("workflow_file_duplicate", workflow.value.name)
    seen.add(key)
    workflows.push(workflow.value)
  }
  return { ok: true, file: { workflows } }
}

const writeStep = (step: WorkflowFileStep) => {
  const base = { kind: step.kind, name: step.name, x: step.x, y: step.y }
  switch (step.kind) {
    case "agent":
      return {
        ...base,
        agent: step.agent,
        prompt: step.prompt,
        ...(step.effort ? { effort: step.effort } : {}),
        continueOnFailure: step.continueOnFailure,
      }
    case "condition":
      return { ...base, mode: step.mode, text: step.text }
    case "approval":
      return { ...base, message: step.message }
    case "post":
      return { ...base, text: step.text }
    case "notify":
      return { ...base, title: step.title }
  }
}

/** The text of a workflow file for these workflows. Two spaces of indent, a newline at the end. */
export const writeWorkflowFile = (workflows: readonly WorkflowFileWorkflow[]): string =>
  `${JSON.stringify(
    {
      format: WORKFLOW_FILE_FORMAT,
      version: WORKFLOW_FILE_VERSION,
      workflows: workflows.map((w) => ({
        name: w.name,
        trigger: w.trigger,
        steps: w.steps.map(writeStep),
        connections: w.connections.map((c) => ({
          from: c.from,
          to: c.to,
          ...(c.branch ? { branch: c.branch } : {}),
        })),
        notes: w.notes.map((n) => ({ text: n.text, tone: n.tone, x: n.x, y: n.y })),
      })),
    },
    null,
    2,
  )}\n`

/** The same file with every text changed by `change` (the hiding of secrets), and cut to its limit. */
export const mapFileTexts = (
  file: WorkflowFile,
  change: (text: string) => string,
): WorkflowFile => {
  const clip = (text: string, max: number) => [...text].slice(0, max).join("")
  return {
    workflows: file.workflows.map((w) => ({
      ...w,
      name: clip(change(w.name).trim(), WORKFLOW_NAME_MAX),
      steps: w.steps.map((s): WorkflowFileStep => {
        const name = clip(change(s.name).trim(), WORKFLOW_NAME_MAX)
        switch (s.kind) {
          case "agent":
            return {
              ...s,
              name,
              agent: clip(change(s.agent).trim(), AGENT_NAME_MAX),
              prompt: change(s.prompt),
            }
          case "condition":
            return { ...s, name, text: change(s.text) }
          case "approval":
            return { ...s, name, message: change(s.message) }
          case "post":
            return { ...s, name, text: change(s.text) }
          default:
            return { ...s, name, title: clip(change(s.title), NOTIFY_TITLE_MAX) }
        }
      }),
      notes: w.notes.map((n) => ({ ...n, text: clip(change(n.text), NOTE_TEXT_MAX) })),
    })),
  }
}

/** What an import will make, for the review screen (spec 014, "Review before an import"). */
export interface WorkflowFilePreviewItem {
  /** The name that the new workflow gets. */
  readonly name: string
  /** The name in the file, when the new workflow gets another one. */
  readonly fileName: string | null
  readonly trigger: "manual" | "schedule"
  readonly steps: number
  readonly notes: number
  /** The agent names of this workflow that no agent of the server has, once each, in order. */
  readonly missingAgents: readonly string[]
  /** True when the app hid a secret in a text of this workflow. It starts not ticked. */
  readonly secretRemoved: boolean
}

export interface WorkflowFilePreview {
  readonly workflows: readonly WorkflowFilePreviewItem[]
  /** What the file holds that the import does not make, with the reason. */
  readonly notImported: readonly NotImported[]
}

export interface WorkflowFileImported {
  readonly workflows: number
}

/** The detail of the error `workflow_file_failed`, as JSON text. */
export interface WorkflowFileFailure {
  /** The workflow that could not be made. */
  readonly name: string
  /** How many workflows were made before it. They stay. */
  readonly made: number
  readonly code: string
  readonly detail: string | null
}

/** The agent names of the file that `has` does not know, once each (ignoring case), in order. */
export const missingAgentNames = (
  file: WorkflowFile,
  has: (nameKey: string) => boolean,
): string[] => {
  const seen = new Set<string>()
  const missing: string[] = []
  for (const w of file.workflows)
    for (const s of w.steps) {
      if (s.kind !== "agent" || s.agent === "") continue
      const key = nameKey(s.agent)
      if (seen.has(key)) continue
      seen.add(key)
      if (!has(key)) missing.push(s.agent)
    }
  return missing
}

/**
 * The workflow that an import makes from the entry of a file. `agentId` gives the id of the agent
 * that has a name (see `nameKey`), or undefined when there is none: then the step has no agent
 * ("Pick an agent"). A post step has no place ("Pick a place"), because the file holds no channel.
 * The ids of steps, connections and notes are numbers with a letter, only for this workflow.
 */
export const toWorkflowInput = (
  serverId: string,
  workflow: WorkflowFileWorkflow,
  name: string,
  agentId: (nameKey: string) => string | undefined,
): WorkflowInput => {
  const steps = workflow.steps.map((s, i): Step => {
    const base = { id: `s${i + 1}`, name: s.name, x: s.x, y: s.y }
    switch (s.kind) {
      case "agent":
        return {
          ...base,
          kind: "agent",
          agentId: s.agent === "" ? "" : (agentId(nameKey(s.agent)) ?? ""),
          prompt: s.prompt,
          continueOnFailure: s.continueOnFailure,
          ...(s.effort ? { effort: s.effort } : {}),
        }
      case "condition":
        return { ...base, kind: "condition", contains: s.text, mode: s.mode }
      case "approval":
        return { ...base, kind: "approval", message: s.message }
      case "post":
        return { ...base, kind: "post", channelId: "", text: s.text }
      default:
        return { ...base, kind: "notify", title: s.title }
    }
  })
  return {
    serverId,
    name,
    trigger: workflow.trigger,
    steps,
    edges: workflow.connections.map((c, i) => ({
      id: `c${i + 1}`,
      from: `s${c.from}`,
      to: `s${c.to}`,
      ...(c.branch ? { branch: c.branch } : {}),
    })),
    notes: workflow.notes.map((n, i) => ({
      id: `n${i + 1}`,
      text: n.text,
      tone: n.tone,
      x: n.x,
      y: n.y,
    })),
  }
}
