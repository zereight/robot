import { createSignal } from "solid-js"

/**
 * A request to open a card of the page "Self-improvement" (spec 002, "Flows" 2): the link "Review"
 * in the chat, the link "Review" of a run, and the link "Proposals (N)" of the memory page. The
 * chat is a column beside the workflow view, so the two share this signal and not a parent.
 */
export interface ImproveRequest {
  readonly workflowId: string
  /** The proposal to show, or null for the tab "Waiting" as it is. */
  readonly proposalId: string | null
  /** Counts up so that a second click on the same link opens the page again. */
  readonly n: number
}

const [request, setRequest] = createSignal<ImproveRequest | null>(null)
let count = 0

export const improveRequest = request

export const openImprovement = (workflowId: string, proposalId: string | null = null) => {
  setRequest({ workflowId, proposalId, n: ++count })
}
