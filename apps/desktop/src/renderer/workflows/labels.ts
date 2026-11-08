import {
  type ApprovalOutput,
  type DocumentSource,
  type MessageKey,
  type NodeKind,
  RUN_STATES,
  type Workflow,
} from "@robot/shared"

const knownState = (state: string): state is (typeof RUN_STATES)[number] =>
  (RUN_STATES as readonly string[]).includes(state)

/** The words of a run state, or none for a state that a later version wrote (spec 005). */
export const runStateKey = (state: string): MessageKey | undefined =>
  knownState(state) ? (`workflows.run.state.${state}` as MessageKey) : undefined

/** The state of the check on a card (spec 001, 010). */
export const checkStateKey = (flow: Pick<Workflow, "check">): MessageKey =>
  `workflows.check.${flow.check}` as MessageKey

export const documentSourceKey = (source: DocumentSource): MessageKey =>
  `workflows.document.source.${source}` as MessageKey

export const nodeKindKey = (kind: NodeKind): MessageKey => `graph.kind.${kind}` as MessageKey

export const approvalOutputKey = (output: ApprovalOutput): MessageKey =>
  `graph.option.${output}` as MessageKey
