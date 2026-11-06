import type { Workflow } from "@robot/shared"
import { createResource, onCleanup } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useUi } from "../state/ui.tsx"

/** The workflows of this computer, for a filter or a label in a settings section. */
export const useWorkflowList = () => {
  const ui = useUi()
  const [list, { refetch }] = createResource(
    () => ui.localServer()?.id,
    (serverId) => call("workflows.list", { serverId }),
    { initialValue: [] as readonly Workflow[] },
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  return {
    list: () => list.latest ?? ([] as readonly Workflow[]),
    byId: (id: string | null | undefined) =>
      id ? (list.latest ?? []).find((w) => w.id === id) : undefined,
  }
}
