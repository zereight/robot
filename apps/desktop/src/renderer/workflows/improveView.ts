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

export { GRAPH_FIELD_KEYS, type NodeDetail, nodeDetails } from "@robot/shared"

const WORKFLOW_TABS = ["graph", "document", "memory", "improvement", "settings"] as const
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
