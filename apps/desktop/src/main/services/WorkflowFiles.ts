import { readFileSync, statSync, writeFileSync } from "node:fs"
import {
  type CcNotExported,
  type ChecklistItem,
  ccFileName,
  type Edge,
  graphFault,
  ignoredWorkflowFields,
  mapFileTexts,
  missingAgentNames,
  type NotImported,
  nameKey,
  parseCcWorkflowFile,
  parseWorkflowFile,
  planNames,
  redactSecrets,
  type Step,
  toWorkflowInput,
  WORKFLOW_FILE_MAX_BYTES,
  WORKFLOW_FILE_MAX_WORKFLOWS,
  WORKFLOW_NAME_MAX,
  type Workflow,
  type WorkflowFile,
  type WorkflowFileConnection,
  type WorkflowFileFailure,
  type WorkflowFileImported,
  type WorkflowFilePreview,
  type WorkflowFileStep,
  type WorkflowFileWorkflow,
  writeCcWorkflowFile,
  writeWorkflowFile,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Agents } from "./Agents.ts"
import { Checklists } from "./Checklists.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Workflows } from "./Workflows.ts"

export interface WorkflowFilesService {
  /** Writes one file with these workflows. `path` is null when cancelled. */
  export(input: {
    serverId: string
    workflowIds: readonly string[]
  }): Effect.Effect<{ path: string | null; count: number }, AppError>
  /**
   * Asks where to save, then writes one workflow as a file of CC Workflow Studio. `path` is null
   * when cancelled. `notExported` lists what the file does not hold.
   */
  exportCc(input: {
    serverId: string
    workflowId: string
  }): Effect.Effect<{ path: string | null; notExported: readonly CcNotExported[] }, AppError>
  /** Asks for a workflow file and reads it. Returns what an import would make, or null if cancelled. */
  open(serverId: string): Effect.Effect<WorkflowFilePreview | null, AppError>
  /**
   * Makes the workflows of the file that `open` read that the user ticked (`pick`: their places
   * in the file). All of them are off. A new workflow with something left to do gets a checklist.
   */
  import(input: {
    serverId: string
    pick: readonly number[]
    /**
     * For a file of CC Workflow Studio: the agent of every agent step. The file names no agent.
     * An agent that does not exist or is archived is refused.
     */
    agentId?: string | undefined
  }): Effect.Effect<WorkflowFileImported, AppError>
}

/**
 * A row of "Not imported" from a CC Workflow Studio file, for the workflow `owner` (the name that
 * the new workflow gets). The names of nodes come from the file, so the hiding of secrets
 * reaches them too.
 */
const hideNotImported = (
  item: NotImported,
  owner: string,
  hide: (text: string) => string,
): NotImported => {
  switch (item.reason) {
    case "no_step":
      return { ...item, owner, name: hide(item.name), nodeType: hide(item.nodeType) }
    case "text_cut":
      return { ...item, owner, name: hide(item.name) }
    case "unknown_field":
      return { ...item, owner }
    default:
      return item
  }
}

export class WorkflowFiles extends Context.Service<WorkflowFiles, WorkflowFilesService>()(
  "robot/main/WorkflowFiles",
) {
  static readonly layer = Layer.effect(
    WorkflowFiles,
    Effect.gen(function* () {
      const workflows = yield* Workflows
      const agents = yield* Agents
      const providers = yield* Providers
      const secrets = yield* Secrets
      const platform = yield* Platform
      const checklists = yield* Checklists
      /** The file that `open` read last. `import` makes its workflows. */
      let pending: string | undefined

      /** Hides what looks like a secret, and every key that is stored on this computer. */
      const hider = Effect.gen(function* () {
        const known = (yield* providers.list)
          .map((a) => secrets.get(secretKey(a.id)))
          .filter((k): k is string => k !== null)
        return (text: string) => redactSecrets(text, known)
      })

      const refusal = (parsed: { code: string; detail?: string | undefined }) =>
        new AppError({ code: parsed.code, ...(parsed.detail ? { detail: parsed.detail } : {}) })

      /** The agents of a server that are not archived, by `nameKey`. */
      const activeAgents = (serverId: string) =>
        Effect.gen(function* () {
          const list = yield* agents.list(serverId, false)
          return new Map(list.map((a) => [nameKey(a.name), a.id]))
        })

      /** Reads, checks and cleans a file. The names are the ones that the workflows will get. */
      const load = Effect.fn("WorkflowFiles.load")(function* (path: string, serverId: string) {
        const text = yield* Effect.try({
          try: () =>
            statSync(path).size > WORKFLOW_FILE_MAX_BYTES
              ? null
              : new TextDecoder().decode(readFileSync(path)),
          catch: (e) => new AppError({ code: "file_unreadable", detail: String(e) }),
        })
        if (text === null) return yield* new AppError({ code: "workflow_file_too_large" })
        // A file of CC Workflow Studio becomes one workflow in the shape of a ROBot file.
        const parsedCc = parseCcWorkflowFile(text)
        const parsed = parsedCc ?? parseWorkflowFile(text)
        if (!parsed.ok) return yield* refusal(parsed)
        const cc = parsedCc?.ok ? parsedCc.cc : undefined
        const hide = yield* hider
        const file: WorkflowFile = mapFileTexts(parsed.file, hide)
        // A workflow where the app hid a secret in one of its texts starts not ticked.
        const secrets = parsed.file.workflows.map((w) => {
          let found = false
          mapFileTexts({ workflows: [w] }, (text) => {
            if (hide(text) !== text) found = true
            return text
          })
          return found
        })
        const taken = (yield* workflows.list(serverId)).map((w) => w.name)
        return {
          file,
          secrets,
          cc,
          ignored: cc ? [] : ignoredWorkflowFields(text),
          taken,
          names: planNames(
            file.workflows.map((w) => w.name),
            taken,
            WORKFLOW_NAME_MAX,
          ),
          agentIds: yield* activeAgents(serverId),
          hide,
        }
      })

      /** The names of all agents of a server, also the archived ones, by id. */
      const agentNames = (serverId: string) =>
        Effect.gen(function* () {
          const all = [
            ...(yield* agents.list(serverId, false)),
            ...(yield* agents.list(serverId, true)),
          ]
          return new Map(all.map((a) => [a.id, a.name]))
        })

      /** A workflow of the app as the entry of a file. */
      const toFileWorkflow = (
        workflow: Workflow,
        agentName: (id: string) => string | undefined,
        hide: (text: string) => string,
      ): WorkflowFileWorkflow => {
        const number = new Map(workflow.steps.map((s, i) => [s.id, i + 1]))
        const steps = workflow.steps.map((s: Step): WorkflowFileStep => {
          const base = { name: hide(s.name), x: Math.round(s.x), y: Math.round(s.y) }
          switch (s.kind) {
            case "agent":
              return {
                ...base,
                kind: "agent",
                // An agent that is gone has no name: the step is written with no agent.
                agent: hide(agentName(s.agentId) ?? ""),
                prompt: hide(s.prompt),
                effort: s.effort ?? null,
                continueOnFailure: s.continueOnFailure,
              }
            case "condition":
              return {
                ...base,
                kind: "condition",
                mode: s.mode ?? "contains",
                text: hide(s.contains),
              }
            case "approval":
              return { ...base, kind: "approval", message: hide(s.message) }
            case "post":
              // The file holds no channel: the step is written with no place.
              return { ...base, kind: "post", text: hide(s.text) }
            default:
              return { ...base, kind: "notify", title: hide(s.title) }
          }
        })
        const connections = workflow.edges.flatMap((e: Edge): WorkflowFileConnection[] => {
          const from = number.get(e.from)
          const to = number.get(e.to)
          if (from === undefined || to === undefined) return []
          return [
            { from, to, branch: steps[from - 1]?.kind === "condition" ? (e.branch ?? null) : null },
          ]
        })
        return {
          name: hide(workflow.name),
          // A message trigger is written as the manual trigger.
          trigger:
            workflow.trigger.kind === "schedule"
              ? { kind: "schedule", schedule: workflow.trigger.schedule }
              : { kind: "manual" },
          steps,
          connections,
          notes: workflow.notes.map((n) => ({
            text: hide(n.text),
            tone: n.tone,
            x: Math.round(n.x),
            y: Math.round(n.y),
          })),
        }
      }

      const exportWorkflows = Effect.fn("WorkflowFiles.export")(function* (input: {
        serverId: string
        workflowIds: readonly string[]
      }) {
        const ids = [...new Set(input.workflowIds)]
        if (ids.length === 0) return yield* new AppError({ code: "workflow_file_empty" })
        if (ids.length > WORKFLOW_FILE_MAX_WORKFLOWS)
          return yield* new AppError({
            code: "workflow_file_too_many",
            detail: String(ids.length),
          })
        const all = yield* workflows.list(input.serverId)
        const chosen: Workflow[] = []
        for (const id of ids) {
          const found = all.find((w) => w.id === id)
          if (!found) return yield* new AppError({ code: "workflow_not_found" })
          chosen.push(found)
        }
        // The file keeps the order of the list of workflows.
        chosen.sort((a, b) => all.indexOf(a) - all.indexOf(b))
        const hide = yield* hider
        const names = yield* agentNames(input.serverId)
        const written = chosen.map((w) => toFileWorkflow(w, (id) => names.get(id), hide))
        // Two names can look alike once hidden. The file may not hold two of one name.
        const unique = planNames(
          written.map((w) => w.name),
          [],
          WORKFLOW_NAME_MAX,
        )
        const file = written.map((w, i) => ({ ...w, name: unique[i] ?? w.name }))
        // A file that the import would refuse is not written.
        for (const w of file) {
          const fault = graphFault(w.name, w.steps, w.connections)
          if (fault)
            return yield* new AppError({
              code: "workflow_file_graph",
              detail: JSON.stringify(fault),
            })
        }
        const text = writeWorkflowFile(file)
        if (Buffer.byteLength(text) > WORKFLOW_FILE_MAX_BYTES)
          return yield* new AppError({ code: "workflow_file_too_large" })
        const stamp = new Date().toISOString().slice(0, 10)
        const target = yield* Effect.promise(() =>
          platform.pickWorkflowFileSave(`ROBot-workflows-${stamp}.json`),
        )
        if (!target) return { path: null, count: 0 }
        yield* Effect.try({
          try: () => writeFileSync(target, text),
          catch: (e) => new AppError({ code: "workflow_file_write", detail: String(e) }),
        })
        return { path: target, count: chosen.length }
      })

      const exportCc = Effect.fn("WorkflowFiles.exportCc")(function* (input: {
        serverId: string
        workflowId: string
      }) {
        const found = (yield* workflows.list(input.serverId)).find((w) => w.id === input.workflowId)
        if (!found) return yield* new AppError({ code: "workflow_not_found" })
        const hide = yield* hider
        const names = yield* agentNames(input.serverId)
        const entry = toFileWorkflow(found, (id) => names.get(id), hide)
        const result = writeCcWorkflowFile({
          workflow: entry,
          trigger: found.trigger.kind,
          now: new Date(),
        })
        if (Buffer.byteLength(result.text) > WORKFLOW_FILE_MAX_BYTES)
          return yield* new AppError({ code: "workflow_file_too_large" })
        const target = yield* Effect.promise(() =>
          platform.pickWorkflowFileSave(`${ccFileName(entry.name)}.json`),
        )
        if (!target) return { path: null, notExported: [] as readonly CcNotExported[] }
        yield* Effect.try({
          try: () => writeFileSync(target, result.text),
          catch: (e) => new AppError({ code: "workflow_file_write", detail: String(e) }),
        })
        return { path: target, notExported: result.notExported }
      })

      const open = Effect.fn("WorkflowFiles.open")(function* (serverId: string) {
        const path = yield* Effect.promise(() => platform.pickWorkflowFile())
        if (!path) return null
        const loaded = yield* load(path, serverId)
        pending = path
        const notImported: NotImported[] = loaded.ignored.map((f) => ({
          reason: "unknown_field",
          ...f,
        }))
        // The file holds one workflow. Its rows name it as the new workflow will be named.
        for (const item of loaded.cc?.notImported ?? [])
          notImported.push(hideNotImported(item, loaded.names[0] ?? item.owner ?? "", loaded.hide))
        // The file holds no channel: the place of each post step is not made.
        for (const [i, w] of loaded.file.workflows.entries())
          for (const [j, step] of w.steps.entries())
            if (step.kind === "post")
              notImported.push({
                reason: "no_place",
                owner: loaded.names[i] ?? w.name,
                step: j + 1,
                name: step.name,
              })
        return {
          form: loaded.cc ? "cc" : "robot",
          workflows: loaded.file.workflows.map((w, i) => {
            const name = loaded.names[i] ?? w.name
            return {
              name,
              fileName: name === w.name ? null : w.name,
              trigger: w.trigger.kind,
              steps: w.steps.length,
              notes: w.notes.length,
              missingAgents: missingAgentNames({ workflows: [w] }, (key) =>
                loaded.agentIds.has(key),
              ),
              secretRemoved: loaded.secrets[i] ?? false,
              lostConnections: loaded.cc?.lostConnections ?? false,
              needAgent: loaded.cc?.agentSteps ?? 0,
            }
          }),
          notImported,
        } satisfies WorkflowFilePreview
      })

      const importWorkflows = Effect.fn("WorkflowFiles.apply")(function* (input: {
        serverId: string
        pick: readonly number[]
        agentId?: string | undefined
      }) {
        if (!pending) return yield* new AppError({ code: "invalid_input" })
        const loaded = yield* load(pending, input.serverId)
        const picked = new Set(input.pick)
        if (
          picked.size !== input.pick.length ||
          input.pick.some((i) => loaded.file.workflows[i] === undefined)
        )
          return yield* new AppError({ code: "invalid_input" })
        if (picked.size === 0) return yield* new AppError({ code: "import_nothing_picked" })
        const chosenAgent = input.agentId ?? ""
        if (chosenAgent !== "" && ![...loaded.agentIds.values()].includes(chosenAgent))
          return yield* new AppError({ code: "invalid_input" })
        const needConnect = new Set(loaded.cc?.lostInputs ?? [])
        const chosen = loaded.file.workflows.filter((_, i) => picked.has(i))
        // Only the workflows that are made take a name.
        const names = planNames(
          chosen.map((w) => w.name),
          loaded.taken,
          WORKFLOW_NAME_MAX,
        )
        /** Makes one workflow, off, and the checklist of what it still needs. */
        const makeOne = Effect.fn("WorkflowFiles.makeOne")(function* (
          workflow: WorkflowFileWorkflow,
          name: string,
        ) {
          // Every imported workflow is off: its schedule does not fire until the user says so.
          const created = yield* workflows.create(
            toWorkflowInput(
              input.serverId,
              workflow,
              name,
              (key) => loaded.agentIds.get(key),
              // Only a file of CC Workflow Studio has agent steps that name no agent.
              loaded.cc ? chosenAgent : "",
            ),
            { enabled: false },
          )
          const todo: ChecklistItem[] = []
          for (const [i, step] of created.steps.entries()) {
            if (step.kind === "agent" && step.agentId === "")
              todo.push({ kind: "stepAgent", stepId: step.id, name: step.name })
            if (step.kind === "post" && step.channelId === "")
              todo.push({ kind: "stepPlace", stepId: step.id, name: step.name })
            if (needConnect.has(i + 1))
              todo.push({ kind: "stepConnect", stepId: step.id, name: step.name })
          }
          if (created.trigger.kind === "schedule") todo.push({ kind: "workflowOn" })
          yield* checklists.create({ workflowId: created.id }, todo)
        })
        let made = 0
        for (const [i, workflow] of chosen.entries()) {
          const name = names[i] ?? workflow.name
          const exit = yield* Effect.exit(makeOne(workflow, name))
          if (Exit.isFailure(exit)) {
            // The workflows made so far stay. The error names the one that stopped the import.
            const failed = exit.cause.reasons.find(Cause.isFailReason)
            const failure: WorkflowFileFailure = {
              name,
              made,
              code: failed ? failed.error.code : "internal",
              detail: failed?.error.detail ?? null,
            }
            return yield* new AppError({
              code: "workflow_file_failed",
              detail: JSON.stringify(failure),
            })
          }
          made++
        }
        pending = undefined
        return { workflows: made }
      })

      return WorkflowFiles.of({
        export: exportWorkflows,
        exportCc,
        open,
        import: importWorkflows,
      })
    }),
  )
}
