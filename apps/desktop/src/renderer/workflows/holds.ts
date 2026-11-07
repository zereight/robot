import type { NodeHold } from "@robot/shared"
import { createResource, onCleanup } from "solid-js"
import { call } from "../lib/rpc.ts"

/**
 * The holds of the main models of the text nodes of a workflow (spec 006, "Backup model"). The
 * computer that runs the workflow answers. A linked device and the phone get none: the call is not
 * allowed for them, and the list stays empty. The list reads again when a workflow changes, because
 * the engine tells it so when a hold starts, ends or is released.
 */
export const createHolds = (workflowId: () => string) => {
  const [holds, { refetch }] = createResource(
    workflowId,
    (id): Promise<readonly NodeHold[]> =>
      call("workflows.holds", { workflowId: id }).catch(() => []),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  onCleanup(window.robot.on("runs.changed", () => void refetch()))
  return (): readonly NodeHold[] => holds() ?? []
}
