import { type DocumentSource, type MessageKey, RUN_STATES, type Workflow } from "@robot/shared"

const knownState = (state: string): state is (typeof RUN_STATES)[number] =>
  (RUN_STATES as readonly string[]).includes(state)

/** The words of a run state, or none for a state that a later version wrote (spec 005). */
export const runStateKey = (state: string): MessageKey | undefined =>
  knownState(state) ? (`workflows.run.state.${state}` as MessageKey) : undefined

/** The state of the check on a card (spec 001). The check on the TLA form is not built yet. */
export const checkStateKey = (flow: Pick<Workflow, "problems">): MessageKey =>
  flow.problems > 0 ? "workflows.check.problem" : "workflows.check.not_checked"

export const documentSourceKey = (source: DocumentSource): MessageKey =>
  `workflows.document.source.${source}` as MessageKey
