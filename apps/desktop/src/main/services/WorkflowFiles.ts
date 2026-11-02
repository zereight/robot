import { readFileSync, statSync, writeFileSync } from "node:fs"
import {
  type Edge,
  graphFault,
  mapFileTexts,
  missingAgentNames,
  nameKey,
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
  writeWorkflowFile,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Agents } from "./Agents.ts"
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
  /** Asks for a workflow file and reads it. Returns what an import would make, or null if cancelled. */
  open(serverId: string): Effect.Effect<WorkflowFilePreview | null, AppError>
  /** Makes the workflows of the file that `open` read. All of them are off. */
  import(input: { serverId: string }): Effect.Effect<WorkflowFileImported, AppError>
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
        const parsed = parseWorkflowFile(text)
        if (!parsed.ok) return yield* refusal(parsed)
        const hide = yield* hider
        const file: WorkflowFile = mapFileTexts(parsed.file, hide)
        const taken = (yield* workflows.list(serverId)).map((w) => w.name)
        return {
          file,
          names: planNames(
            file.workflows.map((w) => w.name),
            taken,
            WORKFLOW_NAME_MAX,
          ),
          agentIds: yield* activeAgents(serverId),
        }
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
        const names = new Map(
          [
            ...(yield* agents.list(input.serverId, false)),
            ...(yield* agents.list(input.serverId, true)),
          ].map((a) => [a.id, a.name]),
        )
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

      const open = Effect.fn("WorkflowFiles.open")(function* (serverId: string) {
        const path = yield* Effect.promise(() => platform.pickWorkflowFile())
        if (!path) return null
        const loaded = yield* load(path, serverId)
        pending = path
        return {
          workflows: loaded.file.workflows.map((w, i) => {
            const name = loaded.names[i] ?? w.name
            return {
              name,
              fileName: name === w.name ? null : w.name,
              trigger: w.trigger.kind,
              steps: w.steps.length,
              notes: w.notes.length,
            }
          }),
          missingAgents: missingAgentNames(loaded.file, (key) => loaded.agentIds.has(key)),
          postSteps: loaded.file.workflows.reduce(
            (sum, w) => sum + w.steps.filter((s) => s.kind === "post").length,
            0,
          ),
        } satisfies WorkflowFilePreview
      })

      const importWorkflows = Effect.fn("WorkflowFiles.apply")(function* (input: {
        serverId: string
      }) {
        if (!pending) return yield* new AppError({ code: "invalid_input" })
        const loaded = yield* load(pending, input.serverId)
        let made = 0
        for (const [i, workflow] of loaded.file.workflows.entries()) {
          const name = loaded.names[i] ?? workflow.name
          const exit = yield* Effect.exit(
            // Every imported workflow is off: its schedule does not fire until the user says so.
            workflows.create(
              toWorkflowInput(input.serverId, workflow, name, (key) => loaded.agentIds.get(key)),
              { enabled: false },
            ),
          )
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

      return WorkflowFiles.of({ export: exportWorkflows, open, import: importWorkflows })
    }),
  )
}
