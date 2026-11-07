import type { RunSummary } from "@robot/shared"
import { createEffect, createResource, createSignal, onCleanup } from "solid-js"
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
  /** True while a run really works. A run that waits for the user or in the queue does not. */
  const working = () => active().some((r) => r.state === "running")
  /**
   * The numbers of the nodes that work now in the runs that are not final (specs/039: the canvas
   * shows a spinner on each). A node that waits for the user or in the queue does not work.
   */
  const [runningNodes, setRunningNodes] = createSignal<ReadonlySet<number>>(new Set())
  createEffect(() => {
    const ids = active().map((r) => r.id)
    let stale = false
    onCleanup(() => {
      stale = true
    })
    if (ids.length === 0) return setRunningNodes(new Set<number>())
    void Promise.all(ids.map((runId) => call("runs.get", { runId }).catch(() => undefined))).then(
      (details) => {
        if (stale) return
        const working = new Set<number>()
        for (const run of details)
          for (const node of run?.nodes ?? [])
            if (node.state === "running") working.add(node.number)
        setRunningNodes(working)
      },
    )
  })
  return { runs, refetch, active, working, runningNodes }
}
