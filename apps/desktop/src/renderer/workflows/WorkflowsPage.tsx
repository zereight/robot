import { createResource, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useUi } from "../state/ui.tsx"
import { WorkflowList } from "./WorkflowList.tsx"
import { WorkflowView } from "./WorkflowView.tsx"

/** The page "Workflows": the list of the workflows of the open server, or the open workflow. */
export const WorkflowsPage = () => {
  const ui = useUi()
  const [ids, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId): Promise<readonly string[]> =>
      call("workflows.list", { serverId })
        .then((list) => list.map((w) => w.id))
        .catch(() => []),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  const open = () => {
    const ref = ui.place()
    return ref && ids()?.includes(ref.id) ? ref.id : undefined
  }
  return (
    <Show when={open()} keyed fallback={<WorkflowList />}>
      {(id) => <WorkflowView id={id} />}
    </Show>
  )
}
