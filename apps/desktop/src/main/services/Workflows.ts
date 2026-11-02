import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  conditionMode,
  dueRuns,
  type Edge,
  fillTemplate,
  graphProblem,
  type ModelInfo,
  type Note,
  nearestAgentStep,
  type RunState,
  type RunStep,
  type Schedule,
  type Step,
  type StepState,
  type Trigger,
  type Workflow,
  type WorkflowInput,
  type WorkflowPatch,
  type WorkflowRun,
  type WorkflowRunDetail,
} from "@robot/shared"
import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberMap, Layer } from "effect"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Notifier } from "./Notifier.ts"
import { Platform } from "./Platform.ts"
import { Providers, toAppError } from "./Providers.ts"
import { Tasks } from "./Tasks.ts"
import {
  ASK_SYSTEM,
  askPrompt,
  canAnswerPlainPrompt,
  readVerdict,
  withTries,
} from "./workflowAsk.ts"

export interface WorkflowsService {
  list(serverId: string): Effect.Effect<readonly Workflow[]>
  /** `enabled` is on unless it says otherwise. A workflow from a file is made off. */
  create(
    input: WorkflowInput,
    options?: { readonly enabled?: boolean },
  ): Effect.Effect<Workflow, AppError>
  update(id: string, patch: WorkflowPatch): Effect.Effect<Workflow, AppError>
  remove(id: string): Effect.Effect<void, AppError>
  /** Starts a run. The text is what a `{{trigger}}` in a prompt becomes. */
  run(id: string, triggerText?: string): Effect.Effect<WorkflowRun, AppError>
  /** Moves a workflow of the other computer here: it runs here from now on (spec 017). */
  runHere(id: string): Effect.Effect<Workflow, AppError>
  stop(runId: string): Effect.Effect<void>
  /** Answers an approval step that waits. */
  approve(runId: string, stepId: string, approved: boolean): Effect.Effect<void>
  runs(workflowId: string): Effect.Effect<readonly WorkflowRun[]>
  runDetail(runId: string): Effect.Effect<WorkflowRunDetail, AppError>
  /** Fires the schedule triggers that are due at `now`. */
  tick(now: number): Effect.Effect<void>
}

interface WorkflowRow {
  id: string
  server_id: string
  name: string
  trigger: string
  steps: string
  edges: string
  notes: string
  enabled: number
  last_checked_at: number
  created_at: number
  runs_on: string | null
}
interface RunRow {
  id: string
  workflow_id: string
  state: RunState
  trigger: string
  trigger_text: string
  started_at: number
  finished_at: number | null
}
interface StepRow {
  run_id: string
  step_id: string
  name: string
  kind: RunStep["kind"]
  state: StepState
  input: string
  result: string
  error: string
  branch: string
  task_id: string | null
}

const TICK_MS = 15_000
const POLL_MS = 100
const RUNS_MAX = 100
const TEXT_MAX = 20_000
const TERMINAL = ["done", "failed", "cancelled"]

const toRun = (r: RunRow): WorkflowRun => ({
  id: r.id,
  workflowId: r.workflow_id,
  state: r.state,
  trigger: r.trigger,
  triggerText: r.trigger_text,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

interface StepOutcome {
  readonly state: "done" | "failed"
  readonly result: string
  readonly error: string
  readonly branch: string
}

export class Workflows extends Context.Service<Workflows, WorkflowsService>()(
  "robot/main/Workflows",
) {
  static readonly layer = Layer.effect(
    Workflows,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const tasks = yield* Tasks
      const chat = yield* Chat
      const channels = yield* Channels
      const notifier = yield* Notifier
      const providers = yield* Providers
      const platform = yield* Platform
      const fibers = yield* FiberMap.make<string>()
      const approvals = new Map<string, Deferred.Deferred<boolean>>()

      // A run that was going when the app closed did not finish.
      // A run of the other computer (spec 017) is not ours to end: its own computer does.
      const ours = "SELECT id FROM workflow_run WHERE origin IS NULL"
      db.run(
        `UPDATE workflow_run_step SET state = 'failed', error = 'app_stopped' WHERE state IN ('running', 'waiting') AND run_id IN (${ours})`,
      )
      db.run(
        `UPDATE workflow_run_step SET state = 'skipped' WHERE state = 'pending' AND run_id IN (SELECT id FROM workflow_run WHERE state = 'running' AND origin IS NULL)`,
      )
      db.run(
        "UPDATE workflow_run SET state = 'failed', finished_at = ? WHERE state = 'running' AND origin IS NULL",
        Date.now(),
      )

      const toWorkflow = (r: WorkflowRow): Workflow => ({
        id: r.id,
        serverId: r.server_id,
        name: r.name,
        trigger: JSON.parse(r.trigger) as Trigger,
        steps: JSON.parse(r.steps) as Step[],
        edges: JSON.parse(r.edges) as Edge[],
        notes: JSON.parse(r.notes ?? "[]") as Note[],
        enabled: r.enabled === 1,
        running: isRunning(r.id),
        createdAt: r.created_at,
        runsOn: r.runs_on === null ? null : tasks.computerName(r.runs_on),
      })
      function isRunning(workflowId: string) {
        return (
          db.get(
            "SELECT 1 AS x FROM workflow_run WHERE workflow_id = ? AND state = 'running'",
            workflowId,
          ) !== undefined
        )
      }
      const row = (id: string) => db.get<WorkflowRow>("SELECT * FROM workflow WHERE id = ?", id)
      const changed = (serverId: string) => bus.emit("workflows.changed", { serverId })
      const runChanged = (runId: string) => bus.emit("workflows.run", { runId })

      const checkGraph = (
        steps: readonly Step[],
        edges: readonly Edge[],
        { needSteps }: { needSteps: boolean },
      ) =>
        Effect.suspend(() => {
          const problem = graphProblem(steps, edges)
          if (problem && (problem !== "no_steps" || needSteps))
            return Effect.fail(new AppError({ code: `graph_${problem}` }))
          for (const step of steps) {
            // An empty id is a step that still needs its agent or its place: it saves, and a run
            // fails at the step.
            if (
              step.kind === "agent" &&
              step.agentId !== "" &&
              !db.get("SELECT 1 AS x FROM agent WHERE id = ? AND archived_at IS NULL", step.agentId)
            )
              return Effect.fail(new AppError({ code: "agent_not_found", detail: step.name }))
            if (
              step.kind === "post" &&
              step.channelId !== "" &&
              !db.get("SELECT 1 AS x FROM channel WHERE id = ?", step.channelId)
            )
              return Effect.fail(new AppError({ code: "channel_not_found", detail: step.name }))
          }
          return Effect.void
        })

      const setStep = (runId: string, stepId: string, patch: Partial<StepRow>) => {
        const keys = Object.keys(patch) as (keyof StepRow)[]
        db.run(
          `UPDATE workflow_run_step SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE run_id = ? AND step_id = ?`,
          ...keys.map((k) => patch[k] as never),
          runId,
          stepId,
        )
        runChanged(runId)
      }

      /** Waits until a task ends. Stopping the run stops the task. */
      const awaitTask = (taskId: string) =>
        Effect.gen(function* () {
          for (;;) {
            const task = db.get<{
              state: string
              error_code: string | null
              error_detail: string | null
            }>("SELECT state, error_code, error_detail FROM task WHERE id = ?", taskId)
            if (task && TERMINAL.includes(task.state)) return task
            yield* Effect.sleep(POLL_MS)
          }
        })

      const execAgent = (run: RunRow, step: Extract<Step, { kind: "agent" }>, prompt: string) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<string>()
          const sent = yield* chat
            .send(
              { agentId: step.agentId, text: prompt, replyTo: null },
              {
                source: "workflow",
                sourceId: run.id,
                ...(step.effort ? { effort: step.effort } : {}),
                onStart: (taskId) => {
                  setStep(run.id, step.id, { task_id: taskId })
                  Deferred.doneUnsafe(started, Effect.succeed(taskId))
                },
              },
            )
            .pipe(Effect.exit)
          if (sent._tag === "Failure")
            return { ok: false as const, error: "agent_not_found", result: "" }
          const taskId = yield* Deferred.await(started)
          const end = yield* awaitTask(taskId).pipe(Effect.onInterrupt(() => tasks.stop(taskId)))
          if (end.state === "done") {
            const detail = yield* tasks.get(taskId).pipe(Effect.orElseSucceed(() => null))
            return { ok: true as const, error: "", result: detail?.result ?? "" }
          }
          return {
            ok: false as const,
            error: end.error_code ?? end.state,
            result: "",
          }
        })

      const failed = (error: string): StepOutcome => ({
        state: "failed",
        result: "",
        error,
        branch: "",
      })

      /** Where the scratch files of a model call with no tools go. */
      const scratch = () => {
        const dir = join(platform.dataDir, "scratch")
        mkdirSync(dir, { recursive: true })
        return dir
      }

      /**
       * The model that answers a condition. A step that names a model gets it as it is, so a wrong
       * choice fails where the user made it. Otherwise the preferred provider is the one of the
       * agent in the nearest agent step before the condition. Then the default is the first account
       * that is connected, in the order they were added. Both skip an account that cannot answer a
       * prompt with no tools and no chat (Muse Code).
       */
      const pickModel = (wf: Workflow, step: Extract<Step, { kind: "condition" }>) =>
        Effect.gen(function* () {
          if (step.provider) return step.provider
          const usable = new Map(
            (yield* providers.list)
              .filter((a) => a.connected && canAnswerPlainPrompt(a.kind))
              .map((a) => [a.id, a]),
          )
          const near = nearestAgentStep(wf.steps, wf.edges, step.id)
          const agent = near?.agentId
            ? db.get<{ model_account_id: string | null; model_name: string | null }>(
                "SELECT model_account_id, model_name FROM agent WHERE id = ? AND archived_at IS NULL",
                near.agentId,
              )
            : undefined
          if (agent?.model_account_id && agent.model_name && usable.has(agent.model_account_id))
            return { accountId: agent.model_account_id, model: agent.model_name }
          for (const account of usable.values()) {
            const models = yield* providers
              .models(account.id)
              .pipe(Effect.orElseSucceed((): readonly ModelInfo[] => []))
            const first = models[0]
            if (first) return { accountId: account.id, model: first.id }
          }
          return yield* new AppError({ code: "provider_not_connected" })
        })

      /** One call of a model with no tools and no chat. It gives the text of the answer. */
      const askOnce = (target: { accountId: string; model: string }, content: string) =>
        Effect.gen(function* () {
          const controller = new AbortController()
          const events = yield* providers.events(
            target.accountId,
            {
              model: target.model,
              effort: null,
              system: ASK_SYSTEM,
              turns: [{ role: "user", content }],
              signal: controller.signal,
              workspace: scratch(),
              permission: "ask_all",
              useTools: false,
            },
            {
              execute: async () => ({ output: "", failed: true }),
              approve: async () => false,
            },
          )
          return yield* Effect.tryPromise({
            try: async () => {
              let text = ""
              for await (const event of events) if (event.type === "text") text += event.text
              return text
            },
            catch: toAppError,
          }).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
        })

      /** A condition in mode "ask": the model answers yes or no about the input. */
      const execAsk = (
        wf: Workflow,
        step: Extract<Step, { kind: "condition" }>,
        input: string,
      ): Effect.Effect<StepOutcome> =>
        Effect.gen(function* () {
          if (!step.contains.trim()) return failed("no_question")
          const target = yield* pickModel(wf, step).pipe(Effect.exit)
          if (target._tag === "Failure") {
            const error = Cause.squash(target.cause)
            return failed(error instanceof AppError ? error.code : "provider_not_connected")
          }
          const tried = yield* withTries(askOnce(target.value, askPrompt(step.contains, input)))
          if (!tried.ok) return failed(tried.error.code)
          const verdict = readVerdict(tried.value)
          if ("error" in verdict) return failed(verdict.error)
          return { state: "done", result: input, error: "", branch: verdict.branch }
        })

      const execStep = (
        run: RunRow,
        wf: Workflow,
        step: Step,
        input: string,
      ): Effect.Effect<StepOutcome> =>
        Effect.gen(function* () {
          const trigger = run.trigger_text
          switch (step.kind) {
            case "agent": {
              if (step.agentId === "") return failed("no_agent")
              let prompt = fillTemplate(step.prompt, input, trigger)
              if (input && !step.prompt.includes("{{input}}")) prompt += `\n\nInput:\n${input}`
              else if (!input && trigger && !step.prompt.includes("{{trigger}}"))
                prompt += `\n\nTrigger:\n${trigger}`
              const r = yield* execAgent(run, step, prompt)
              return r.ok
                ? {
                    state: "done" as const,
                    result: r.result.slice(0, TEXT_MAX),
                    error: "",
                    branch: "",
                  }
                : { state: "failed" as const, result: "", error: r.error, branch: "" }
            }
            case "condition": {
              if (conditionMode(step) === "ask") return yield* execAsk(wf, step, input)
              const yes = input.toLowerCase().includes(step.contains.toLowerCase())
              return {
                state: "done" as const,
                result: input,
                error: "",
                branch: yes ? "yes" : "no",
              }
            }
            case "approval": {
              const key = `${run.id}:${step.id}`
              const gate = yield* Deferred.make<boolean>()
              approvals.set(key, gate)
              setStep(run.id, step.id, { state: "waiting" })
              const ok = yield* Deferred.await(gate).pipe(
                Effect.ensuring(Effect.sync(() => approvals.delete(key))),
              )
              setStep(run.id, step.id, { state: "running" })
              return ok
                ? { state: "done" as const, result: input, error: "", branch: "" }
                : { state: "failed" as const, result: "", error: "rejected", branch: "" }
            }
            case "notify": {
              notifier.notify({
                kind: "workflow_notice",
                serverId: wf.serverId,
                title: step.title.trim() || step.name,
                body: input,
                page: "workflows",
              })
              return { state: "done" as const, result: input, error: "", branch: "" }
            }
            case "post": {
              if (step.channelId === "") return failed("no_place")
              const text = fillTemplate(step.text, input, trigger)
              const posted = yield* channels.post(step.channelId, text).pipe(Effect.exit)
              return posted._tag === "Success"
                ? { state: "done" as const, result: text, error: "", branch: "" }
                : { state: "failed" as const, result: "", error: "channel_not_found", branch: "" }
            }
          }
        })

      const engine = (runId: string, wf: Workflow) =>
        Effect.gen(function* () {
          const run = db.get<RunRow>("SELECT * FROM workflow_run WHERE id = ?", runId) as RunRow
          const byId = new Map(wf.steps.map((s) => [s.id, s]))
          const continues = (id: string) => {
            const s = byId.get(id)
            return s?.kind === "agent" && s.continueOnFailure
          }
          let failed = false
          for (;;) {
            const recs = new Map(
              db
                .all<StepRow>("SELECT * FROM workflow_run_step WHERE run_id = ?", runId)
                .map((r) => [r.step_id, r]),
            )
            const pending = [...recs.values()].filter((r) => r.state === "pending")
            if (pending.length === 0) break
            const ready: { step: Step; input: string }[] = []
            let skipped = false
            for (const rec of pending) {
              const step = byId.get(rec.step_id) as Step
              const incoming = wf.edges.filter((e) => e.to === rec.step_id)
              if (incoming.length === 0) {
                ready.push({ step, input: "" })
                continue
              }
              const sources = incoming.map((e) => ({ e, src: recs.get(e.from) as StepRow }))
              if (sources.some(({ src }) => ["pending", "running", "waiting"].includes(src.state)))
                continue
              const active = sources.filter(({ e, src }) => {
                const passes =
                  src.state === "done" || (src.state === "failed" && continues(src.step_id))
                if (!passes) return false
                return src.kind !== "condition" || src.branch === e.branch
              })
              if (active.length === 0) {
                setStep(runId, rec.step_id, { state: "skipped" })
                skipped = true
                continue
              }
              ready.push({
                step,
                input: active
                  .map(({ src }) => src.result)
                  .filter(Boolean)
                  .join("\n\n"),
              })
            }
            if (skipped) continue
            if (ready.length === 0) break
            const outcomes = yield* Effect.forEach(
              ready,
              ({ step, input }) =>
                Effect.gen(function* () {
                  setStep(runId, step.id, { state: "running", input })
                  const out = yield* execStep(run, wf, step, input)
                  setStep(runId, step.id, {
                    state: out.state,
                    result: out.result,
                    error: out.error,
                    branch: out.branch,
                  })
                  return { step, out }
                }),
              { concurrency: "unbounded" },
            )
            if (outcomes.some(({ step, out }) => out.state === "failed" && !continues(step.id))) {
              failed = true
              db.run(
                "UPDATE workflow_run_step SET state = 'skipped' WHERE run_id = ? AND state = 'pending'",
                runId,
              )
              break
            }
          }
          return failed
        })

      const finish = (runId: string, state: RunState) => {
        if (state === "cancelled")
          db.run(
            "UPDATE workflow_run_step SET state = CASE WHEN state = 'pending' THEN 'skipped' ELSE 'failed' END, error = CASE WHEN state = 'pending' THEN error ELSE 'stopped' END WHERE run_id = ? AND state IN ('pending', 'running', 'waiting')",
            runId,
          )
        db.run(
          "UPDATE workflow_run SET state = ?, finished_at = ? WHERE id = ?",
          state,
          Date.now(),
          runId,
        )
        const wf = db.get<{ server_id: string }>(
          "SELECT w.server_id FROM workflow w JOIN workflow_run r ON r.workflow_id = w.id WHERE r.id = ?",
          runId,
        )
        runChanged(runId)
        if (wf) changed(wf.server_id)
      }

      const start = (wf: Workflow, trigger: string, triggerText: string) =>
        Effect.gen(function* () {
          yield* checkGraph(wf.steps, wf.edges, { needSteps: true })
          if (isRunning(wf.id)) return yield* new AppError({ code: "workflow_running" })
          const runId = randomUUID()
          db.transaction(() => {
            db.run(
              "INSERT INTO workflow_run (id, workflow_id, state, trigger, trigger_text, started_at) VALUES (?, ?, 'running', ?, ?, ?)",
              runId,
              wf.id,
              trigger,
              triggerText,
              Date.now(),
            )
            for (const s of wf.steps)
              db.run(
                "INSERT INTO workflow_run_step (run_id, step_id, name, kind, state) VALUES (?, ?, ?, ?, 'pending')",
                runId,
                s.id,
                s.name,
                s.kind,
              )
          })
          // onExit also runs when Stop interrupts the run.
          const work = engine(runId, wf).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() =>
                finish(
                  runId,
                  Exit.isSuccess(exit) ? (exit.value ? "failed" : "done") : "cancelled",
                ),
              ),
            ),
          )
          yield* FiberMap.run(fibers, runId, work)
          changed(wf.serverId)
          return toRun(db.get<RunRow>("SELECT * FROM workflow_run WHERE id = ?", runId) as RunRow)
        })

      const tick = (now: number) =>
        Effect.gen(function* () {
          // A workflow runs on one computer only (spec 017).
          for (const r of db.all<WorkflowRow>(
            "SELECT * FROM workflow WHERE enabled = 1 AND runs_on IS NULL",
          )) {
            const wf = toWorkflow(r)
            if (wf.trigger.kind !== "schedule") continue
            const { start: at } = dueRuns(wf.trigger.schedule as Schedule, r.last_checked_at, now)
            db.run("UPDATE workflow SET last_checked_at = ? WHERE id = ?", now, r.id)
            if (at !== null && !wf.running) yield* start(wf, "schedule", "").pipe(Effect.ignore)
          }
        })

      // A message in a channel can start a workflow, when it holds the text of the trigger.
      channels.onUserMessage((channelId, text) => {
        for (const r of db.all<WorkflowRow>(
          "SELECT * FROM workflow WHERE enabled = 1 AND runs_on IS NULL",
        )) {
          const wf = toWorkflow(r)
          const t = wf.trigger
          if (
            t.kind === "channel" &&
            t.channelId === channelId &&
            text.toLowerCase().includes(t.contains.toLowerCase()) &&
            !wf.running
          )
            Effect.runFork(start(wf, "channel", text).pipe(Effect.ignore))
        }
      })

      yield* Effect.forkDetach(
        Effect.forever(
          Effect.sleep(TICK_MS).pipe(Effect.andThen(Effect.suspend(() => tick(Date.now())))),
        ),
      )

      const stepRow = (r: StepRow): RunStep => ({
        stepId: r.step_id,
        name: r.name,
        kind: r.kind,
        state: r.state,
        input: r.input,
        result: r.result,
        error: r.error,
        taskId: r.task_id,
      })

      return Workflows.of({
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<WorkflowRow>(
                "SELECT * FROM workflow WHERE server_id = ? ORDER BY created_at",
                serverId,
              )
              .map(toWorkflow),
          ),
        create: (input, options) =>
          Effect.gen(function* () {
            yield* checkGraph(input.steps as Step[], input.edges as Edge[], { needSteps: false })
            const id = randomUUID()
            const now = Date.now()
            db.run(
              `INSERT INTO workflow (id, server_id, name, trigger, steps, edges, notes, enabled, last_checked_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              input.serverId,
              input.name.trim(),
              JSON.stringify(input.trigger),
              JSON.stringify(input.steps),
              JSON.stringify(input.edges),
              JSON.stringify(input.notes ?? []),
              options?.enabled === false ? 0 : 1,
              now,
              now,
              now,
            )
            changed(input.serverId)
            return toWorkflow(row(id) as WorkflowRow)
          }),
        update: (id, patch) =>
          Effect.gen(function* () {
            const current = row(id)
            if (!current) return yield* new AppError({ code: "workflow_not_found" })
            const touchesGraph =
              patch.steps !== undefined ||
              patch.edges !== undefined ||
              patch.notes !== undefined ||
              patch.trigger !== undefined ||
              patch.name !== undefined
            // A workflow cannot be edited while it runs.
            if (touchesGraph && isRunning(id))
              return yield* new AppError({ code: "workflow_running" })
            const steps = (patch.steps ?? JSON.parse(current.steps)) as Step[]
            const edges = (patch.edges ?? JSON.parse(current.edges)) as Edge[]
            yield* checkGraph(steps, edges, { needSteps: false })
            db.run(
              `UPDATE workflow SET name = ?, trigger = ?, steps = ?, edges = ?, notes = ?, enabled = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
              patch.name?.trim() ?? current.name,
              patch.trigger ? JSON.stringify(patch.trigger) : current.trigger,
              JSON.stringify(steps),
              JSON.stringify(edges),
              patch.notes ? JSON.stringify(patch.notes) : current.notes,
              patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
              Date.now(),
              Date.now(),
              id,
            )
            changed(current.server_id)
            return toWorkflow(row(id) as WorkflowRow)
          }),
        remove: (id) =>
          Effect.gen(function* () {
            const current = row(id)
            if (!current) return
            if (isRunning(id)) return yield* new AppError({ code: "workflow_running" })
            db.run("DELETE FROM workflow WHERE id = ?", id)
            changed(current.server_id)
          }),
        run: (id, triggerText = "") =>
          Effect.gen(function* () {
            const current = row(id)
            if (!current) return yield* new AppError({ code: "workflow_not_found" })
            if (current.runs_on !== null) return yield* new AppError({ code: "workflow_elsewhere" })
            return yield* start(toWorkflow(current), "manual", triggerText)
          }),
        runHere: (id) =>
          Effect.gen(function* () {
            const current = row(id)
            if (!current) return yield* new AppError({ code: "workflow_not_found" })
            if (current.runs_on !== null) {
              const now = Date.now()
              db.run(
                "UPDATE workflow SET runs_on = NULL, last_checked_at = ?, updated_at = ? WHERE id = ?",
                now,
                now,
                id,
              )
              changed(current.server_id)
            }
            return toWorkflow(row(id) as WorkflowRow)
          }),
        stop: (runId) =>
          Effect.gen(function* () {
            const fiber = yield* FiberMap.get(fibers, runId)
            if (fiber._tag === "Some") yield* Fiber.interrupt(fiber.value)
          }),
        approve: (runId, stepId, approved) =>
          Effect.sync(() => {
            const gate = approvals.get(`${runId}:${stepId}`)
            if (gate) Deferred.doneUnsafe(gate, Effect.succeed(approved))
          }),
        runs: (workflowId) =>
          Effect.sync(() =>
            db
              .all<RunRow>(
                "SELECT * FROM workflow_run WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
                workflowId,
                RUNS_MAX,
              )
              .map(toRun),
          ),
        runDetail: (runId) =>
          Effect.gen(function* () {
            const r = db.get<RunRow>("SELECT * FROM workflow_run WHERE id = ?", runId)
            if (!r) return yield* new AppError({ code: "workflow_not_found" })
            const wf = row(r.workflow_id)
            const order = new Map(
              (wf ? (JSON.parse(wf.steps) as Step[]) : []).map((s, i) => [s.id, i]),
            )
            const steps = db
              .all<StepRow>("SELECT * FROM workflow_run_step WHERE run_id = ?", runId)
              .sort((a, b) => (order.get(a.step_id) ?? 0) - (order.get(b.step_id) ?? 0))
            return { run: toRun(r), steps: steps.map(stepRow) }
          }),
        tick,
      })
    }),
  )
}
