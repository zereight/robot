import type { WorkflowConnection, WorkflowNode } from "@robot/shared"

/**
 * The first node of `order` that has not ended and whose input nodes all ended (spec 010). It is
 * undefined when no node can start. If nodes that never ran remain then, the run did not do its
 * work: a loop that came through, or a graph that changed during the run.
 */
export const readyNode = (
  order: readonly WorkflowNode[],
  incoming: ReadonlyMap<string, readonly WorkflowConnection[]>,
  ended: ReadonlyMap<string, unknown>,
): WorkflowNode | undefined =>
  order.find((n) => !ended.has(n.id) && (incoming.get(n.id) ?? []).every((c) => ended.has(c.from)))

/** True when no node is ready and nodes that never ran remain. */
export const stalled = (
  order: readonly WorkflowNode[],
  incoming: ReadonlyMap<string, readonly WorkflowConnection[]>,
  ended: ReadonlyMap<string, unknown>,
): boolean => readyNode(order, incoming, ended) === undefined && order.some((n) => !ended.has(n.id))
