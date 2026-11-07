import type {
  CheckProblem,
  GraphNodeChange,
  GraphNodeRef,
  GraphNodeValues,
  MessageKey,
  MessageParams,
} from "@robot/shared"

type Translate = (key: MessageKey, params?: MessageParams) => string

/** The name of a node of the new graph of a proposal, for a line of the check. */
const nodeText = (t: Translate, nodes: readonly GraphNodeRef[], id: string) => {
  const n = nodes.find((x) => x.id === id)
  return n ? t("check.node", { number: n.number, name: n.name }) : ""
}

/** One line for a problem that the check found in the new graph of a proposal (spec 010). */
export const problemLine = (
  t: Translate,
  nodes: readonly GraphNodeRef[],
  problem: CheckProblem,
): string => {
  if (problem.code === "deadlock")
    return t("check.problem.deadlock", {
      nodes: problem.nodeIds.map((id) => nodeText(t, nodes, id)).join(", "),
    })
  if (problem.code === "never_runs") {
    const n = nodes.find((x) => x.id === problem.nodeIds[0])
    return n ? t("check.problem.never_runs", { number: n.number, name: n.name }) : ""
  }
  // A fault of the form of the graph. The proposal compiles the graph before it makes a card, so
  // these do not happen; the line stays short and does not guess.
  return t("improve.check.problem")
}

export const GRAPH_FIELD_KEYS = {
  name: "improve.graph.field.name",
  prompt: "improve.graph.field.prompt",
  account: "improve.graph.field.account",
  model: "improve.graph.field.model",
  effort: "improve.graph.field.effort",
  continueOnFailure: "improve.graph.field.continueOnFailure",
  question: "improve.graph.field.question",
  threshold: "improve.graph.field.threshold",
  options: "improve.graph.field.options",
  number: "improve.graph.field.number",
} as const satisfies Record<string, MessageKey>

/** One value of a node that the card shows. A changed field has the old value and the new value. */
export interface NodeDetail {
  readonly field: keyof typeof GRAPH_FIELD_KEYS
  /** The value before the change, for a changed field; null for an added or a removed node. */
  readonly old: string | null
  readonly now: string
  /** True for a text that the card shows in its own block: a prompt, a question, options. */
  readonly long: boolean
}

type Shown = Exclude<keyof typeof GRAPH_FIELD_KEYS, "number">

const SHOWN: readonly Shown[] = [
  "name",
  "prompt",
  "question",
  "options",
  "account",
  "model",
  "effort",
  "continueOnFailure",
  "threshold",
]

const LONG: ReadonlySet<string> = new Set(["prompt", "question", "options"])

const fieldValue = (t: Translate, v: GraphNodeValues, field: Shown): string => {
  switch (field) {
    case "name":
      return v.name
    case "prompt":
      return v.prompt
    case "question":
      return v.question
    case "options":
      return v.options.join("\n")
    case "account":
      return v.account ?? ""
    case "model":
      return v.model ?? ""
    case "effort":
      return v.effort ?? ""
    case "continueOnFailure":
      return t(v.continueOnFailure ? "improve.graph.yes" : "improve.graph.no")
    case "threshold":
      return String(v.threshold)
  }
}

/**
 * The values that the card of a graph change shows for a node (spec 002, "Card"): for an added or a
 * removed node, every value that is set; for a changed node, each changed field with the old value
 * and the new value. The card shows these as text, so the user reads the new text before "Accept".
 */
export const nodeDetails = (t: Translate, n: GraphNodeChange): NodeDetail[] => {
  const none = t("improve.graph.value.none")
  const out: NodeDetail[] = []
  if (n.was) {
    for (const field of SHOWN) {
      if (!n.fields.includes(field)) continue
      out.push({
        field,
        old: fieldValue(t, n.was, field) || none,
        now: fieldValue(t, n.now, field) || none,
        long: LONG.has(field),
      })
    }
    return out
  }
  for (const field of SHOWN) {
    if (field === "continueOnFailure" || field === "threshold") {
      if (n.kind === "decision" ? field === "threshold" : field === "continueOnFailure")
        out.push({ field, old: null, now: fieldValue(t, n.now, field), long: false })
      continue
    }
    const value = fieldValue(t, n.now, field)
    if (value !== "") out.push({ field, old: null, now: value, long: LONG.has(field) })
  }
  return out
}

const WORKFLOW_TABS = ["graph", "runs", "document", "memory", "improvement", "settings"] as const
export type WorkflowTab = (typeof WORKFLOW_TABS)[number]

/**
 * The tabs of a workflow. The page "Self-improvement" is on the computer that holds the proposals:
 * a linked device does not show it (spec 002, "Surfaces").
 */
export const workflowTabs = (local: boolean): readonly WorkflowTab[] =>
  local ? WORKFLOW_TABS : WORKFLOW_TABS.filter((name) => name !== "improvement")

/**
 * The tabs of the memory page. The history and its Undo stay on the computer that holds the memory:
 * the link does not route them (spec 008, 012), so a linked device shows the items only.
 */
export const memoryTabs = (local: boolean): readonly ("items" | "history")[] =>
  local ? ["items", "history"] : ["items"]

/** True when the window shows the proposals of a server: the line "N proposals wait", the link. */
export const showsProposals = (serverKind: string | undefined): boolean => serverKind === "local"
