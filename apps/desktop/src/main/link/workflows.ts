import {
  STEP_TEXT_MAX,
  type Step,
  type Workflow,
  WorkflowInput,
  WorkflowPatch,
} from "@robot/shared"
import { Effect as E, Schema } from "effect"
import { AppError } from "../services/errors.ts"
import { Servers } from "../services/Servers.ts"
import { Workflows } from "../services/Workflows.ts"
import { allowed, type ChangeHandler, checkModel, Id, ownServer, strict } from "./changes.ts"

/**
 * What a linked device may do with the workflows of this computer (spec 012, "Workflows").
 * Reading, running, stopping and answering an approval step need only the link. A change needs
 * the switch "Can create and change agents". Each request is untrusted: a strict schema refuses a
 * field it does not know, and every agent and model account that a change names must be
 * one of this computer. The file of a workflow and "Run on this computer" are not here.
 */

/** The workflow, when it is one of this computer. */
const ownWorkflow = (id: string) =>
  E.gen(function* () {
    const local = yield* Servers.use((s) => s.local)
    const list = yield* Workflows.use((w) => w.list(local.id))
    const found = list.find((w) => w.id === id)
    if (!found) return yield* new AppError({ code: "workflow_not_found" })
    return found
  })

const modelsOf = (steps: readonly Step[]) =>
  steps.flatMap((s) =>
    s.kind === "condition" && s.provider ? [`${s.provider.accountId}\n${s.provider.model}`] : [],
  )

/**
 * The parts of a change that the window checks with its own pickers. The agents of agent steps
 * are checked by the service. A model that a step had before is not
 * checked again, so a model account that went away later does not block other changes.
 */
const checkRefs = (next: { readonly steps?: readonly Step[] }, before?: Workflow) =>
  E.gen(function* () {
    if (!next.steps) return
    const known = new Set(before ? modelsOf(before.steps) : [])
    for (const pair of new Set(modelsOf(next.steps))) {
      if (known.has(pair)) continue
      const [accountId = "", model = ""] = pair.split("\n")
      yield* checkModel({ accountId, model, effort: null })
    }
  })

const RunInput = Schema.Struct({
  id: Id,
  triggerText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(STEP_TEXT_MAX))),
})

export const workflowHandlers: Record<string, ChangeHandler> = {
  "workflows.list": (input) =>
    E.gen(function* () {
      const { serverId } = yield* strict(Schema.Struct({ serverId: Id }))(input)
      yield* ownServer(serverId)
      return yield* Workflows.use((w) => w.list(serverId))
    }),

  "workflows.runs": (input) =>
    E.gen(function* () {
      const { workflowId } = yield* strict(Schema.Struct({ workflowId: Id }))(input)
      yield* ownWorkflow(workflowId)
      return yield* Workflows.use((w) => w.runs(workflowId))
    }),

  "workflows.runDetail": (input) =>
    E.gen(function* () {
      const { runId } = yield* strict(Schema.Struct({ runId: Id }))(input)
      return yield* Workflows.use((w) => w.runDetail(runId))
    }),

  // The service refuses a workflow that runs on another computer (spec 019) and names the device.
  "workflows.run": (input) =>
    E.gen(function* () {
      const { id, triggerText } = yield* strict(RunInput)(input)
      yield* ownWorkflow(id)
      return yield* Workflows.use((w) => w.run(id, triggerText))
    }),

  "workflows.stop": (input) =>
    E.gen(function* () {
      const { runId } = yield* strict(Schema.Struct({ runId: Id }))(input)
      yield* Workflows.use((w) => w.stop(runId))
    }),

  "workflows.approve": (input) =>
    E.gen(function* () {
      const { runId, stepId, approved } = yield* strict(
        Schema.Struct({ runId: Id, stepId: Id, approved: Schema.Boolean }),
      )(input)
      yield* Workflows.use((w) => w.approve(runId, stepId, approved))
    }),

  "workflows.create": (input) =>
    E.gen(function* () {
      yield* allowed
      const data = yield* strict(WorkflowInput)(input)
      yield* ownServer(data.serverId)
      yield* checkRefs(data)
      return yield* Workflows.use((w) => w.create(data))
    }),

  "workflows.update": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id, patch } = yield* strict(Schema.Struct({ id: Id, patch: WorkflowPatch }))(input)
      const current = yield* ownWorkflow(id)
      yield* checkRefs(patch, current)
      return yield* Workflows.use((w) => w.update(id, patch))
    }),

  "workflows.delete": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id } = yield* strict(Schema.Struct({ id: Id }))(input)
      yield* ownWorkflow(id)
      yield* Workflows.use((w) => w.remove(id))
    }),
}
