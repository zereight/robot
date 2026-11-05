/**
 * Reads a file of CC Workflow Studio, a public tool that draws a workflow on a canvas (spec 010,
 * "CC Workflow Studio files"). The table of nodes and steps is in
 * `docs/cc-wf-studio-format.md`. The result has the shape of an entry of a ROBot workflow file, so
 * the hiding of secrets, the names, the rules of the graph and the making of the workflow are
 * the same as for a ROBot file.
 */
import type { NotImported } from "./importReview.ts"
import {
  type GraphFault,
  graphFault,
  PLACE_MAX,
  WORKFLOW_FILE_FORMAT,
  type WorkflowFile,
  type WorkflowFileConnection,
  type WorkflowFileNote,
  type WorkflowFileParse,
  type WorkflowFileStep,
} from "./workflowFile.ts"
import { NOTE_TEXT_MAX, STEP_TEXT_MAX, WORKFLOW_NAME_MAX, WORKFLOW_NOTES_MAX } from "./workflows.ts"

/** What the import of such a file tells besides the workflow. */
export interface CcImportExtra {
  /** What the file holds that ROBot does not make. The owner is the name in the file. */
  readonly notImported: readonly NotImported[]
  /** The node numbers (from 1) of the steps that lost an input to a node that became a note. */
  readonly lostInputs: readonly number[]
  /** True when a connection was dropped at a node that became a note. */
  readonly lostConnections: boolean
  /** The number of agent steps. The file names no agent, so each one needs an agent. */
  readonly agentSteps: number
}

type Failure = Extract<WorkflowFileParse, { ok: false }>
export type CcParse =
  | { readonly ok: true; readonly file: WorkflowFile; readonly cc: CcImportExtra }
  | Failure

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === "string" ? value : "")
const filled = (value: string): boolean => value.trim() !== ""

const failField = (path: string): Failure => ({
  ok: false,
  code: "workflow_file_field",
  detail: path,
})
const failGraph = (fault: GraphFault): Failure => ({
  ok: false,
  code: "workflow_file_graph",
  detail: JSON.stringify(fault),
})

/** The text cut to `max` characters, and whether it was cut. */
const cut = (value: string, max: number): { text: string; cut: boolean } => {
  const chars = [...value]
  return chars.length > max
    ? { text: chars.slice(0, max).join(""), cut: true }
    : { text: value, cut: false }
}

/** Fields of a sub-agent node that ROBot has no place for. */
const SUB_AGENT_FIELDS = ["model", "tools", "memory", "color", "agentType", "builtInType"] as const

interface CcNode {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly data: Json
  readonly parentId: string | null
  readonly x: number
  readonly y: number
}

/** The workflow object of the text, or null when the text is not in this form. */
const findWorkflow = (root: unknown): Json | null => {
  if (!isObject(root) || root.format === WORKFLOW_FILE_FORMAT) return null
  const hasGraph = (value: unknown): value is Json =>
    isObject(value) && Array.isArray(value.nodes) && Array.isArray(value.connections)
  if (hasGraph(root.workflow)) return root.workflow
  return hasGraph(root) ? root : null
}

const readNodes = (raw: readonly unknown[]): CcNode[] | Failure => {
  const nodes: CcNode[] = []
  const ids = new Set<string>()
  for (const [i, entry] of raw.entries()) {
    if (!isObject(entry)) return failField(`nodes[${i}]`)
    const id = str(entry.id)
    if (id === "" || ids.has(id)) return failField(`nodes[${i}].id`)
    ids.add(id)
    const type = str(entry.type)
    if (type === "") return failField(`nodes[${i}].type`)
    const position = entry.position
    if (
      !isObject(position) ||
      typeof position.x !== "number" ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    )
      return failField(`nodes[${i}].position`)
    nodes.push({
      id,
      type,
      name: str(entry.name),
      data: isObject(entry.data) ? entry.data : {},
      parentId: str(entry.parentId) || null,
      x: position.x,
      y: position.y,
    })
  }
  return nodes
}

/**
 * The place of every node on the canvas. A node in a group holds a place that is relative to the
 * group, so the place on the canvas adds the places of the groups above it.
 */
const canvasPlaces = (
  nodes: readonly CcNode[],
): Map<string, { x: number; y: number }> | Failure => {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const clamp = (value: number) => Math.max(-PLACE_MAX, Math.min(PLACE_MAX, Math.round(value)))
  const places = new Map<string, { x: number; y: number }>()
  for (const [i, node] of nodes.entries()) {
    const seen = new Set<string>()
    let x = 0
    let y = 0
    for (
      let at: CcNode | undefined = node;
      at;
      at = at.parentId ? byId.get(at.parentId) : undefined
    ) {
      if (seen.has(at.id)) return failField(`nodes[${i}].parentId`)
      seen.add(at.id)
      x += at.x
      y += at.y
    }
    places.set(node.id, { x: clamp(x), y: clamp(y) })
  }
  return places
}

/** `{{name}}` becomes the text that `variables` holds for it. Any other `{{...}}` stays. */
const fillVariables = (prompt: string, variables: unknown): string =>
  isObject(variables)
    ? prompt.replace(/\{\{([^{}]+)\}\}/g, (all, key: string) => {
        const value = Object.hasOwn(variables, key) ? variables[key] : undefined
        return typeof value === "string" ? value : all
      })
    : prompt

const labelsOf = (value: unknown): string =>
  (Array.isArray(value) ? value : [])
    .map((item) => (isObject(item) ? str(item.label) : ""))
    .filter(filled)
    .join(", ")

/** The main text of a node that becomes a note. */
const noteBody = (type: string, data: Json): string => {
  const parts: string[] = (() => {
    switch (type) {
      case "askUserQuestion":
        return [str(data.questionText), labelsOf(data.options)]
      case "switch":
        return [str(data.evaluationTarget), labelsOf(data.branches)]
      case "branch":
        return [labelsOf(data.branches)]
      case "skill":
        return [str(data.name), str(data.description)]
      case "mcp":
        return [str(data.toolName)]
      case "codex":
        return [str(data.label), str(data.prompt)]
      case "subAgentFlow":
      case "group":
        return [str(data.label)]
      case "branchSession":
        return [str(data.label), str(data.workDescription)]
      default:
        return []
    }
  })()
  return parts.filter(filled).join("\n")
}

const hasHooks = (options: unknown): boolean => {
  const hooks = isObject(options) ? options.hooks : undefined
  return (
    isObject(hooks) &&
    Object.values(hooks).some((entry) => (Array.isArray(entry) ? entry.length > 0 : entry != null))
  )
}

const convert = (source: Json): CcParse => {
  const name = str(source.name).trim()
  if (name === "") return failField("name")
  const owner = [...name].slice(0, WORKFLOW_NAME_MAX).join("")

  const nodes = readNodes(source.nodes as unknown[])
  if (!Array.isArray(nodes)) return nodes
  const places = canvasPlaces(nodes)
  if (!(places instanceof Map)) return places

  const notImported: NotImported[] = []
  const steps: WorkflowFileStep[] = []
  const notes: WorkflowFileNote[] = []
  /** The node number (from 1) of each node that became a step. */
  const stepOf = new Map<string, number>()
  /** The nodes that became a note, also those over the limit of notes. */
  const noteIds = new Set<string>()
  const subAgentFields = new Set<string>()

  const stepName = (primary: string, node: CcNode) =>
    [...(primary.trim() || node.name.trim() || node.id)].slice(0, WORKFLOW_NAME_MAX).join("")
  const limited = (value: string, max: number, label: string): string => {
    const result = cut(value, max)
    if (result.cut) notImported.push({ reason: "text_cut", owner, name: label })
    return result.text
  }

  for (const node of nodes) {
    const place = places.get(node.id) ?? { x: 0, y: 0 }
    const { data } = node
    switch (node.type) {
      case "start":
      case "end":
        break
      case "subAgent":
      case "prompt": {
        const sub = node.type === "subAgent"
        const label = stepName(str(sub ? data.description : data.label), node)
        const text = sub
          ? [str(data.agentDefinition), str(data.prompt)].filter(filled).join("\n\n")
          : fillVariables(str(data.prompt), data.variables)
        if (sub)
          for (const field of SUB_AGENT_FIELDS)
            if (data[field] !== undefined && data[field] !== null && data[field] !== "")
              subAgentFields.add(field)
        steps.push({
          kind: "agent",
          name: label,
          ...place,
          agent: "",
          prompt: limited(text, STEP_TEXT_MAX, label),
          effort: null,
          continueOnFailure: false,
        })
        stepOf.set(node.id, steps.length)
        break
      }
      case "ifElse": {
        const target = str(data.evaluationTarget)
        const first = Array.isArray(data.branches) ? data.branches[0] : undefined
        const label = stepName(target, node)
        steps.push({
          kind: "condition",
          name: label,
          ...place,
          mode: "ask",
          text: limited(
            [target, isObject(first) ? str(first.condition) : ""].filter(filled).join("\n"),
            STEP_TEXT_MAX,
            label,
          ),
        })
        stepOf.set(node.id, steps.length)
        break
      }
      default: {
        const label = node.name.trim() || str(data.label).trim() || node.id
        noteIds.add(node.id)
        notImported.push({ reason: "no_step", owner, nodeType: node.type, name: label })
        if (notes.length >= WORKFLOW_NOTES_MAX) break
        const text = [`Not imported: ${node.type} ${label}`, noteBody(node.type, data)]
          .filter(filled)
          .join("\n")
        notes.push({ text: limited(text, NOTE_TEXT_MAX, label), tone: "pink", ...place })
      }
    }
  }

  const connections: WorkflowFileConnection[] = []
  const lostInputs = new Set<number>()
  let lostConnections = false
  for (const [i, raw] of (source.connections as unknown[]).entries()) {
    if (!isObject(raw)) return failField(`connections[${i}]`)
    const from = str(raw.from)
    const to = str(raw.to)
    if (!nodes.some((n) => n.id === from) || !nodes.some((n) => n.id === to))
      return failGraph({
        workflow: owner,
        fault: "unknown_step",
        place: { kind: "connection", n: i + 1 },
      })
    const fromStep = stepOf.get(from)
    const toStep = stepOf.get(to)
    const lose = () => {
      lostConnections = true
      if (toStep !== undefined) lostInputs.add(toStep)
    }
    if (noteIds.has(from) || noteIds.has(to)) {
      lose()
      continue
    }
    // A connection to or from the start node or the end node is not a loss.
    if (fromStep === undefined || toStep === undefined) continue
    let branch: "yes" | "no" | null = null
    if (steps[fromStep - 1]?.kind === "condition") {
      const port = str(raw.fromPort)
      branch = port === "branch-0" ? "yes" : port === "branch-1" ? "no" : null
      if (branch === null) {
        lose()
        continue
      }
    }
    // The same connection twice means the same as once.
    if (!connections.some((c) => c.from === fromStep && c.to === toStep && c.branch === branch))
      connections.push({ from: fromStep, to: toStep, branch })
  }

  const fault = graphFault(owner, steps, connections)
  if (fault) return failGraph(fault)

  for (const field of SUB_AGENT_FIELDS)
    if (subAgentFields.has(field))
      notImported.push({ reason: "unknown_field", owner, field: `subAgent.${field}` })
  if (Array.isArray(source.subAgentFlows) && source.subAgentFlows.length > 0)
    notImported.push({ reason: "unknown_field", owner, field: "subAgentFlows" })
  if (hasHooks(source.slashCommandOptions))
    notImported.push({ reason: "unknown_field", owner, field: "hooks" })

  return {
    ok: true,
    file: { workflows: [{ name, trigger: { kind: "manual" }, steps, connections, notes }] },
    cc: {
      notImported,
      lostInputs: [...lostInputs].sort((a, b) => a - b),
      lostConnections,
      agentSteps: steps.filter((s) => s.kind === "agent").length,
    },
  }
}

/**
 * Reads the text of a CC Workflow Studio file, in the bare form or the wrapped form. Returns null
 * when the text is not in that form, so the caller can try a ROBot file. A file that breaks a
 * rule is refused as a whole, and the app makes nothing from it.
 */
export const parseCcWorkflowFile = (text: string): CcParse | null => {
  let root: unknown
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
  const source = findWorkflow(root)
  return source ? convert(source) : null
}
