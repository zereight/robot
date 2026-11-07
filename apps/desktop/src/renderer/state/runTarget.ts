import { createSignal } from "solid-js"

/**
 * A request to open a run in the view of its workflow (spec 005, "Tasks page": the action "open
 * the run"). The Tasks page and the workflow view do not share a parent, so they share this signal.
 */
export interface RunRequest {
  readonly workflowId: string
  readonly runId: string
}

const [request, setRequest] = createSignal<RunRequest | null>(null)

export const runRequest = request
export const openRun = (workflowId: string, runId: string) => setRequest({ workflowId, runId })
export const clearRunRequest = () => setRequest(null)
