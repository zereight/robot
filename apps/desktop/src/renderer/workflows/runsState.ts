import type { RunSummary } from "@robot/shared"
import { createResource, onCleanup } from "solid-js"
import { call } from "../lib/rpc.ts"

/** The runs of a workflow, read again when the main process says that a run changed. */
export const createRunsState = (workflowId: () => string) => {
  const [runs, { refetch }] = createResource(
    workflowId,
    (id): Promise<readonly RunSummary[]> =>
      call("runs.list", { workflowId: id }).catch(() => [] as readonly RunSummary[]),
  )
  onCleanup(
    window.robot.on("runs.changed", (payload) => {
      if (payload.workflowId === workflowId()) void refetch()
    }),
  )
  /** The runs that work, wait or queue, oldest first. */
  const active = () => (runs() ?? []).filter((r) => r.finishedAt === null).reverse()
  return { runs, refetch, active }
}
