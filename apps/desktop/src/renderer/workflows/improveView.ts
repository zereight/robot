import type { CheckProblem, GraphNodeRef, MessageKey, MessageParams } from "@robot/shared"

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
