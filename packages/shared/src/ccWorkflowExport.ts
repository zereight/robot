/**
 * Writes a workflow as a file of CC Workflow Studio (spec 010, "CC Workflow Studio files"). The
 * table of steps and nodes is in `docs/cc-wf-studio-format.md`. The input is the entry of a ROBot
 * workflow file, so its texts are already free of secrets. That tool has no node for a post step,
 * a notify step, a note, a trigger, or the settings of a step, so those are left out and named in
 * the list `notExported`.
 */
import type { WorkflowFileStep, WorkflowFileWorkflow } from "./workflowFile.ts"
import type { Trigger } from "./workflows.ts"

/** Something that the file does not hold. The window shows it under "Not exported". */
export type CcNotExported =
  /** A post step or a notify step: the tool has no node for it. `step` counts from 1. */
  | {
      readonly kind: "step"
      readonly step: number
      readonly stepKind: "post" | "notify"
      readonly name: string
    }
  /** A trigger that is not "manual". `trigger` is the kind of the trigger in the app. */
  | { readonly kind: "trigger"; readonly trigger: Exclude<Trigger["kind"], "manual"> }
  | { readonly kind: "notes"; readonly count: number }
  /** The steps that had an agent, an effort or the mark "Continue on failure". */
  | { readonly kind: "stepSettings"; readonly count: number }
  /** A text of a step that the tool's limit cut. */
  | { readonly kind: "cut"; readonly step: number; readonly name: string }

export interface CcExportResult {
  /** The text of the file. */
  readonly text: string
  readonly notExported: readonly CcNotExported[]
}

/** The limits of the tool for the texts that the export writes. */
const PROMPT_MAX = 10_000
const CONDITION_MAX = 500
const QUESTION_MAX = 500
const DESCRIPTION_MAX = 200
const NAME_MAX = 100
/** The space between the start node or the end node and the step next to it. */
const EDGE_GAP = 250

const filled = (value: string): boolean => value.trim() !== ""

/** The name of the file for a workflow: lower case, and only `a-z`, `0-9`, `-` and `_`. */
export const ccFileName = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
  const cut = [...slug].slice(0, NAME_MAX).join("").replace(/^-|-$/g, "")
  return cut === "" ? "workflow" : cut
}

type Target = number | "end"

export const writeCcWorkflowFile = (input: {
  readonly workflow: WorkflowFileWorkflow
  /** The kind of the trigger in the app. The entry of the file writes some kinds as "manual". */
  readonly trigger: Trigger["kind"]
  readonly now: Date
}): CcExportResult => {
  const { workflow } = input
  const steps = workflow.steps
  const isWritten = (step: WorkflowFileStep | undefined) =>
    step !== undefined && step.kind !== "post" && step.kind !== "notify"
  const writtenNumbers = steps.flatMap((step, i) => (isWritten(step) ? [i + 1] : []))
  const stepAt = (n: number) => steps[n - 1]

  const cuts: CcNotExported[] = []
  /** The text, cut to `max` characters. A cut is listed once for the step. */
  const limited = (value: string, max: number, n: number, name: string): string => {
    const chars = [...value]
    if (chars.length <= max) return value
    if (!cuts.some((c) => c.kind === "cut" && c.step === n))
      cuts.push({ kind: "cut", step: n, name })
    return chars.slice(0, max).join("")
  }

  const node = (n: number, step: WorkflowFileStep) => {
    const base = { id: `step-${n}`, name: `step-${n}`, position: { x: step.x, y: step.y } }
    switch (step.kind) {
      case "agent":
        return {
          ...base,
          type: "subAgent",
          data: {
            description: limited(step.name, DESCRIPTION_MAX, n, step.name),
            // The tool reads this text as a part of the prompt, so a name here would come back into
            // the prompt. The agent of the step is named in "Not exported".
            agentDefinition: "",
            prompt: limited(
              filled(step.prompt) ? step.prompt : step.name,
              PROMPT_MAX,
              n,
              step.name,
            ),
            outputPorts: 1,
          },
        }
      case "condition": {
        const first =
          step.mode === "contains"
            ? `The input contains "${step.text}", ignoring case`
            : filled(step.text)
              ? step.text
              : "True"
        return {
          ...base,
          type: "ifElse",
          data: {
            evaluationTarget: "The input of this step",
            branches: [
              { label: "Yes", condition: limited(first, CONDITION_MAX, n, step.name) },
              { label: "No", condition: "Otherwise" },
            ],
            outputPorts: 2,
          },
        }
      }
      case "approval":
        return {
          ...base,
          type: "askUserQuestion",
          data: {
            questionText: limited(
              filled(step.message) ? step.message : "Do you approve?",
              QUESTION_MAX,
              n,
              step.name,
            ),
            options: [
              { id: "approve", label: "Approve", description: "Go on" },
              { id: "reject", label: "Reject", description: "Stop" },
            ],
            outputPorts: 2,
          },
        }
      default:
        throw new Error("a step that is not written has no node")
    }
  }

  /** The port where a connection leaves a step: "Approve" and "yes" are the first port. */
  const portOf = (n: number, branch: "yes" | "no" | null): string => {
    const kind = stepAt(n)?.kind
    if (kind === "condition") return branch === "no" ? "branch-1" : "branch-0"
    return kind === "approval" ? "branch-0" : "output"
  }

  /**
   * The steps that a connection reaches, when the step at its end is not written: the steps after
   * it, and so on. A step that is not written and has nothing after it reaches the end node.
   */
  const reach = (n: number, path: readonly number[] = []): Target[] => {
    if (isWritten(stepAt(n))) return [n]
    if (path.includes(n)) return []
    const after = workflow.connections.filter((c) => c.from === n)
    if (after.length === 0) return ["end"]
    return after.flatMap((c) => reach(c.to, [...path, n]))
  }

  interface Edge {
    readonly from: string
    readonly port: string
    readonly to: string
  }
  /** Adds the edge to the list, unless the list has it. The same connection twice is one. */
  const addTo = (list: Edge[], edge: Edge) => {
    if (!list.some((e) => e.from === edge.from && e.port === edge.port && e.to === edge.to))
      list.push(edge)
  }
  const idOf = (target: Target) => (target === "end" ? "end" : `step-${target}`)

  const middle: Edge[] = []
  for (const n of writtenNumbers)
    for (const c of workflow.connections.filter((x) => x.from === n))
      for (const target of reach(c.to))
        addTo(middle, { from: `step-${n}`, port: portOf(n, c.branch), to: idOf(target) })
  const hasInput = new Set(middle.map((e) => e.to))
  const hasOutput = new Set(middle.map((e) => e.from))
  // The start node comes first and the end node last, so the list reads from start to end.
  const edges: Edge[] = []
  for (const n of writtenNumbers)
    if (!hasInput.has(`step-${n}`)) addTo(edges, { from: "start", port: "output", to: `step-${n}` })
  for (const edge of middle) addTo(edges, edge)
  for (const n of writtenNumbers)
    if (!hasOutput.has(`step-${n}`))
      addTo(edges, { from: `step-${n}`, port: portOf(n, "yes"), to: "end" })
  if (writtenNumbers.length === 0) addTo(edges, { from: "start", port: "output", to: "end" })

  const written = writtenNumbers.flatMap((n) => {
    const step = stepAt(n)
    return step ? [{ n, step }] : []
  })
  const first = written[0]
  const last = written[written.length - 1]
  const left = Math.min(...written.map((w) => w.step.x))
  const right = Math.max(...written.map((w) => w.step.x))
  const iso = input.now.toISOString()
  const file = {
    id: `workflow-${input.now.getTime()}`,
    name: ccFileName(workflow.name),
    version: "1.0.0",
    nodes: [
      {
        id: "start",
        type: "start",
        name: "start",
        position: first ? { x: left - EDGE_GAP, y: first.step.y } : { x: 0, y: 0 },
        data: { label: "Start" },
      },
      ...written.map(({ n, step }) => node(n, step)),
      {
        id: "end",
        type: "end",
        name: "end",
        position: last ? { x: right + EDGE_GAP, y: last.step.y } : { x: EDGE_GAP, y: 0 },
        data: { label: "End" },
      },
    ],
    connections: edges.map((e, i) => ({
      id: `c-${i + 1}`,
      from: e.from,
      to: e.to,
      fromPort: e.port,
      toPort: "input",
    })),
    createdAt: iso,
    updatedAt: iso,
  }

  const settings = steps.filter(
    (s) => s.kind === "agent" && (s.agent !== "" || s.effort !== null || s.continueOnFailure),
  ).length
  const notExported: CcNotExported[] = [
    ...steps.flatMap((s, i): CcNotExported[] =>
      s.kind === "post" || s.kind === "notify"
        ? [{ kind: "step", step: i + 1, stepKind: s.kind, name: s.name }]
        : [],
    ),
    ...(input.trigger === "manual" ? [] : [{ kind: "trigger", trigger: input.trigger } as const]),
    ...(workflow.notes.length > 0
      ? [{ kind: "notes", count: workflow.notes.length } as const]
      : []),
    ...(settings > 0 ? [{ kind: "stepSettings", count: settings } as const] : []),
    ...cuts,
  ]
  return { text: `${JSON.stringify(file, null, 2)}\n`, notExported }
}
