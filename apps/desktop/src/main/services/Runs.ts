import { randomUUID } from "node:crypto"
import {
  addSpent,
  BLOCKED_REASON_MAX,
  blockedReason,
  type CardAnswer,
  catalogues,
  isLooser,
  keepGoingMessage,
  type ListedStep,
  MODEL_RETRY_WAIT_MS,
  MODEL_TRIES,
  NO_USAGE,
  NOTE_NAME_CHARS,
  nextKeepGoing,
  type OutsideSource,
  type PermissionLevel,
  parseOutsideSource,
  plainLine,
  RUN_QUEUE_MAX,
  type RunCard,
  type RunDetail,
  type RunNode,
  type RunStart,
  type RunSummary,
  type RunTask,
  redactSecrets,
  type SensitiveLabel,
  type TaskState,
  type WorkflowDetail,
  type WorkflowNode,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { PlanEvent } from "../providers/agent.ts"
import type { Turn } from "../providers/chat.ts"
import { ProviderFailure } from "../providers/client.ts"
import { ActionLog } from "./ActionLog.ts"
import { Cards } from "./Cards.ts"
import { Database } from "./Database.ts"
import { Decision } from "./Decision.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { FileClaims } from "./FileClaims.ts"
import { appendLog } from "./logs.ts"
import { Memory } from "./Memory.ts"
import { isMemoryTool, MEMORY_TOOL_DEFS, makeMemoryTool } from "./memoryTool.ts"
import { makeNodeTools, NODE_TOOL_DEFS, type NodeCard, type TaskMarks } from "./NodeTools.ts"
import { Platform } from "./Platform.ts"
import { Proposals } from "./Proposals.ts"
import { Providers } from "./Providers.ts"
import { Rules } from "./Rules.ts"
import { RunFacts } from "./RunFacts.ts"
import {
  feedbackBlock,
  nodeInput,
  nodeSystem,
  renderPrompt,
  silentText,
  stepLimitText,
} from "./runPrompt.ts"
import { SettingsStore } from "./Settings.ts"
import { WorkflowCheck } from "./WorkflowCheck.ts"
import { Workflows } from "./Workflows.ts"

/**
 * The engine of the runs (spec 010, 005, 007). It starts a run, walks the graph, runs each node
 * as a task, and writes the rows `run` and `task` that the chat reads (`RunFacts`).
 *
 * What the specs leave open is not decided here. Where the engine had to do something, it did the
 * safe thing, and the report of the slice lists it: a node with no provider fails; a decision
 * answer that is not usable asks the user; a graph with a loop does not start; the result of a
 * decision node is empty; the schedule and the other triggers are not built.
 */

/** The waits of the engine. A test makes them short. */
export const runClock = {
  /** The wait between two tries of a model call (spec 010). */
  retryWaitMs: MODEL_RETRY_WAIT_MS,
  /** The length of one minute of the silent limit. */
  minuteMs: 60_000,
}

export interface RunsService {
  /** Starts a run by hand. The run works on and the call returns at once (spec 010). */
  readonly start: (
    input: RunStart,
    source?: "hand" | "chat",
    /** The linked device that started the run: "Started by <device>" (spec 012). */
    device?: string | null,
  ) => Effect.Effect<RunSummary, AppError>
  /** Stops a run: its tasks are cancelled and a card that waits goes away (spec 005). */
  readonly stop: (runId: string) => Effect.Effect<void, AppError>
  readonly list: (workflowId: string) => Effect.Effect<readonly RunSummary[]>
  readonly get: (runId: string) => Effect.Effect<RunDetail, AppError>
  /** True while a run of the workflow works, waits or is queued. */
  readonly active: (workflowId: string) => boolean
  /**
   * Calls `listener` when a run has ended, whatever the state. The responsible document looks at
   * an ended run to propose a change (spec 002, "Self-improvement").
   */
  readonly onEnded: (listener: (workflowId: string, runId: string) => void) => void
}

interface RunRow {
  id: string
  workflow_id: string
  state: string
  source: string
  trigger_text: string
  reason: string | null
  reason_code: string | null
  started_at: number
  finished_at: number | null
}

interface TaskRow {
  id: string
  run_id: string
  workflow_id: string
  node_id: string | null
  node_name: string
  node_number: number
  retry_of: string | null
  input: string
  result: string
  state: string
  error_code: string | null
  error_detail: string | null
  progress: "not_sent" | "sent" | "started"
  decision: string | null
  option_id: string | null
  kept_going: number
  created_at: number
  started_at: number | null
  first_reply_at: number | null
  ended_at: number | null
  ended_as: string | null
  finished_at: number | null
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  cost_micros: number | null
  outside_mark: string | null
  program_mark: number
  sensitive_mark: string | null
  steps: number
}

/** How a task ended. */
interface End {
  readonly state: "done" | "failed" | "blocked" | "cancelled"
  readonly code: string | null
  readonly text: string | null
  readonly result: string
  /** For a decision node: the option taken. */
  readonly optionId?: string | null
}

const TASK_FINAL = ["done", "failed", "blocked", "cancelled"]

export class Runs extends Context.Service<Runs, RunsService>()("robot/main/Runs") {
  static readonly layer = Layer.effect(
    Runs,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform
      const providers = yield* Providers
      const workflows = yield* Workflows
      const check = yield* WorkflowCheck
      const decision = yield* Decision
      const settings = yield* SettingsStore
      const cards = yield* Cards
      const facts = yield* RunFacts
      const rules = yield* Rules
      const actionLog = yield* ActionLog
      const claims = yield* FileClaims
      const memory = yield* Memory
      const proposals = yield* Proposals
      const tools = makeNodeTools({ rules, actionLog, platform, claims })
      const memoryTool = makeMemoryTool({ memory, proposals, actionLog })
      const endListeners: ((workflowId: string, runId: string) => void)[] = []

      // --- after a restart ----------------------------------------------------------------

      // A run that was going is marked failed with the reason "The app stopped", and so are its
      // tasks. This includes a run that waited for the user (spec 010, 005, 007).
      {
        const now = Date.now()
        db.run(
          `UPDATE task SET state = 'failed', error_code = 'restart', error_detail = 'The app stopped',
             ended_at = ?, ended_as = 'failed', finished_at = ?
           WHERE state IN ('queued', 'running', 'waiting')`,
          now,
          now,
        )
        db.run(
          `UPDATE run SET state = 'failed', reason = 'The app stopped', reason_code = 'restart',
             finished_at = ? WHERE finished_at IS NULL`,
          now,
        )
      }

      const active = new Map<string, { workflowId: string; controller: AbortController }>()
      /** The runs of a workflow that wait for the run before them, oldest first. */
      const queues = new Map<string, string[]>()
      const busy = new Set<string>()

      const changed = (workflowId: string, runId: string | null) => {
        bus.emit("runs.changed", { workflowId, runId })
        bus.emit("chat.state", { workflowId })
      }
      const serverOf = (workflowId: string) =>
        db.get<{ server_id: string }>("SELECT server_id FROM workflow WHERE id = ?", workflowId)
          ?.server_id
      const workflowsChanged = (workflowId: string) => {
        const serverId = serverOf(workflowId)
        if (serverId) bus.emit("workflows.changed", { serverId })
      }

      const runRow = (id: string) => db.get<RunRow>("SELECT * FROM run WHERE id = ?", id)
      const taskRow = (id: string) => db.get<TaskRow>("SELECT * FROM task WHERE id = ?", id)

      // --- reading ------------------------------------------------------------------------

      /**
       * The steps of these tasks that a file claim of another workflow refused (spec 025), by task,
       * from one query. The texts are plain lines (spec 007, 025).
       */
      const refusalsOf = (
        taskIds: readonly string[],
      ): Map<string, RunTask["refusals"][number][]> => {
        const byTask = new Map<string, RunTask["refusals"][number][]>()
        for (const e of actionLog.refusedOf(taskIds)) {
          if (e.taskId === null) continue
          const list = byTask.get(e.taskId) ?? []
          list.push({
            path: plainLine(e.target),
            holder: plainLine(e.holder ?? "", NOTE_NAME_CHARS),
          })
          byTask.set(e.taskId, list)
        }
        return byTask
      }

      const toTask = (t: TaskRow, refusals: RunTask["refusals"] = []): RunTask => {
        let decisionView: RunTask["decision"] = null
        if (t.decision) {
          try {
            const parsed = JSON.parse(t.decision) as Record<string, number>
            decisionView = {
              options: Object.entries(parsed).map(([label, probability]) => ({
                label,
                probability,
              })),
              taken: t.option_id
                ? (db.get<{ label: string }>(
                    "SELECT label FROM workflow_option WHERE id = ?",
                    t.option_id,
                  )?.label ?? null)
                : null,
            }
          } catch {
            decisionView = null
          }
        } else if (t.option_id) {
          decisionView = {
            options: [],
            taken:
              db.get<{ label: string }>(
                "SELECT label FROM workflow_option WHERE id = ?",
                t.option_id,
              )?.label ?? null,
          }
        }
        return {
          id: t.id,
          retryOf: t.retry_of,
          state: t.state as TaskState,
          reasonCode: t.error_code,
          reasonText: t.error_detail,
          input: t.input,
          result: t.result,
          progress: t.progress,
          keptGoing: t.kept_going,
          usage: {
            input: t.input_tokens,
            output: t.output_tokens,
            cached: t.cached_tokens,
            costMicros: t.cost_micros,
          },
          createdAt: t.created_at,
          startedAt: t.started_at,
          firstReplyAt: t.first_reply_at,
          endedAt: t.ended_at,
          finishedAt: t.finished_at,
          decision: decisionView,
          outside: parseOutsideSource(t.outside_mark),
          program: t.program_mark === 1,
          sensitive: (t.sensitive_mark as SensitiveLabel | null) ?? null,
          steps: t.steps,
          memory: memory.ofTask(t.id),
          claims: claims.ofTask(t.id),
          refusals,
        }
      }

      const nodesOf = (workflowId: string) =>
        db.all<{ number: number; name: string; kind: "text" | "decision" }>(
          "SELECT number, name, kind FROM workflow_node WHERE workflow_id = ? ORDER BY number",
          workflowId,
        )

      const summaryOf = (r: RunRow): RunSummary => {
        const total = nodesOf(r.workflow_id).length
        const endedTasks = db.get<{ n: number }>(
          `SELECT COUNT(DISTINCT node_number) AS n FROM task WHERE run_id = ?
             AND state IN ('done', 'failed', 'blocked', 'cancelled')`,
          r.id,
        )?.n
        return {
          id: r.id,
          workflowId: r.workflow_id,
          state: r.state as TaskState,
          source: r.source as RunSummary["source"],
          triggerText: r.trigger_text,
          reasonCode: r.reason_code,
          reasonText: r.reason,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          ended: r.state === "done" ? total : (endedTasks ?? 0),
          total,
        }
      }

      const detailOf = (r: RunRow): RunDetail => {
        const nodes = nodesOf(r.workflow_id)
        const tasks = db.all<TaskRow>(
          "SELECT * FROM task WHERE run_id = ? ORDER BY created_at, rowid",
          r.id,
        )
        const refusals = refusalsOf(tasks.map((t) => t.id))
        const byNumber = new Map<number, TaskRow>()
        for (const t of tasks) byNumber.set(t.node_number, t)
        const ended = r.finished_at !== null
        const view: RunNode[] = nodes.map((n) => {
          const t = byNumber.get(n.number)
          if (!t)
            return {
              ...n,
              state: ended && r.state === "done" ? "skipped" : "not_reached",
              task: null,
            }
          const task = toTask(t, refusals.get(t.id))
          return { ...n, state: task.state, task }
        })
        let usage = NO_USAGE
        for (const t of tasks)
          usage = addSpent(usage, {
            ...(t.input_tokens !== null ? { input: t.input_tokens } : {}),
            ...(t.output_tokens !== null ? { output: t.output_tokens } : {}),
            ...(t.cached_tokens !== null ? { cached: t.cached_tokens } : {}),
            ...(t.cost_micros !== null ? { costMicros: t.cost_micros } : {}),
          })
        const stopped = [...view]
          .reverse()
          .find((n) => n.state === "failed" || n.state === "blocked")
        const feedback = db
          .all<{
            id: string
            text: string
            node_number: number | null
            created_at: number
            nodes: string
          }>(
            "SELECT id, text, node_number, created_at, nodes FROM run_feedback WHERE run_id = ? ORDER BY created_at, rowid",
            r.id,
          )
          .map((f) => ({
            id: f.id,
            text: f.text,
            nodeNumber: f.node_number,
            createdAt: f.created_at,
            nodes: JSON.parse(f.nodes) as number[],
          }))
        return {
          ...summaryOf(r),
          nodes: view,
          feedback,
          usage,
          stoppedAt:
            r.state === "failed" || r.state === "blocked" ? (stopped?.number ?? null) : null,
        }
      }

      // --- writing ------------------------------------------------------------------------

      const setRun = (
        runId: string,
        state: TaskState,
        reason?: { text: string | null; code: string | null },
        finished = false,
      ) => {
        const r = runRow(runId)
        if (!r) return
        db.run(
          `UPDATE run SET state = ?, reason = ?, reason_code = ?, finished_at = ? WHERE id = ?`,
          state,
          reason ? reason.text : r.reason,
          reason ? reason.code : r.reason_code,
          finished ? Date.now() : r.finished_at,
          runId,
        )
        changed(r.workflow_id, runId)
        if (finished) workflowsChanged(r.workflow_id)
      }

      // --- the engine -----------------------------------------------------------------------

      const failureText = (error: unknown): { code: string; text: string } => {
        if (error instanceof ProviderFailure)
          return {
            code: error.code,
            text:
              error.detail ??
              (error.code === "provider_limit"
                ? "The usage limit of the account is reached."
                : error.code === "provider_busy"
                  ? "The model is busy."
                  : error.code === "provider_auth"
                    ? "The account refused the key."
                    : error.code === "provider_unreachable"
                      ? "The provider could not be reached."
                      : error.code),
          }
        if (error instanceof AppError) {
          // The words of the app for the code, not the raw code (spec 005, "States and reasons").
          const known = (catalogues.en as Record<string, string>)[`error.${error.code}`]
          return { code: error.code, text: known ?? error.detail ?? error.code }
        }
        return { code: "model_error", text: error instanceof Error ? error.message : String(error) }
      }

      const sleep = (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(new Error("stopped"))
          const t = setTimeout(() => {
            signal.removeEventListener("abort", stop)
            resolve()
          }, ms)
          const stop = () => {
            clearTimeout(t)
            reject(new Error("stopped"))
          }
          signal.addEventListener("abort", stop, { once: true })
        })

      /** The numbers and the marks of the tasks whose results go into a node. */
      interface Done {
        readonly node: WorkflowNode
        readonly taskId: string
        readonly state: "done" | "failed" | "blocked"
        readonly result: string
        readonly optionId: string | null
        readonly marks: TaskMarks
      }

      const mergeMarks = (from: readonly Done[]): TaskMarks => {
        const marks: TaskMarks = { outside: null, program: false, sensitive: null }
        for (const d of from) {
          marks.outside ??= d.marks.outside
          marks.sensitive ??= d.marks.sensitive
          marks.program ||= d.marks.program
        }
        return marks
      }

      const execute = async (runId: string): Promise<void> => {
        const entry = active.get(runId)
        const r = runRow(runId)
        if (!entry || !r) return
        const { controller } = entry
        const runSignal = controller.signal
        const detail: WorkflowDetail = await Effect.runPromise(workflows.get(r.workflow_id))
        const graph = detail.graph
        setRun(runId, "running", { text: null, code: null })
        const incoming = new Map<string, typeof graph.connections>()
        for (const n of graph.nodes) incoming.set(n.id, [])
        for (const c of graph.connections) incoming.set(c.to, [...(incoming.get(c.to) ?? []), c])
        const ended = new Map<string, Done | "skipped">()
        const order = [...graph.nodes].sort((a, b) => a.number - b.number)
        const trigger = r.trigger_text

        let stop: { state: TaskState; text: string | null; code: string | null } | null = null

        const passes = (c: (typeof graph.connections)[number]): Done | null => {
          const from = ended.get(c.from)
          if (!from || from === "skipped") return null
          if (from.state === "failed" || from.state === "blocked")
            return from.node.continueOnFailure ? passesOption(c, from) : null
          return passesOption(c, from)
        }
        const passesOption = (c: (typeof graph.connections)[number], from: Done): Done | null =>
          from.node.kind === "decision" ? (c.optionId === from.optionId ? from : null) : from

        for (;;) {
          if (runSignal.aborted) break
          const ready = order.find(
            (n) => !ended.has(n.id) && (incoming.get(n.id) ?? []).every((c) => ended.has(c.from)),
          )
          if (!ready) break
          const inputs = (incoming.get(ready.id) ?? []).flatMap((c) => {
            const p = passes(c)
            return p ? [p] : []
          })
          // No input passes on: the node is skipped and makes no task (spec 010).
          if ((incoming.get(ready.id) ?? []).length > 0 && inputs.length === 0) {
            ended.set(ready.id, "skipped")
            continue
          }
          const results = [...new Map(inputs.map((i) => [i.taskId, i])).values()]
          const marks = mergeMarks(results)
          const done = await runNode({
            run: r,
            detail,
            node: ready,
            inputs: results,
            marks,
            trigger,
            signal: runSignal,
          })
          if (done.kind === "cancelled") {
            stop = { state: "cancelled", text: "Stopped by you", code: "user" }
            break
          }
          ended.set(ready.id, done.done)
          if (done.done.state !== "done" && !ready.continueOnFailure) {
            const t = taskRow(done.done.taskId)
            stop = {
              state: done.done.state,
              text: `Node ${ready.number} "${ready.name}" ${
                done.done.state === "blocked" ? "is blocked" : "failed"
              }: ${t?.error_detail ?? ""}`.trim(),
              code: done.done.state === "blocked" ? "node_blocked" : "node_failed",
            }
            break
          }
        }
        if (runSignal.aborted && stop === null)
          stop = { state: "cancelled", text: "Stopped by you", code: "user" }
        // No node is ready, and nodes that never ran remain: the run did not do its work. It must
        // not end as "done" (a loop that came through, a graph that changed during the run).
        if (stop === null && graph.nodes.some((n) => !ended.has(n.id)))
          stop = {
            state: "failed",
            text: "No node could start, and some nodes did not run",
            code: "run_no_ready_node",
          }
        if (stop) setRun(runId, stop.state, { text: stop.text, code: stop.code }, true)
        else setRun(runId, "done", { text: null, code: null }, true)
      }

      interface NodeRun {
        readonly run: RunRow
        readonly detail: WorkflowDetail
        readonly node: WorkflowNode
        readonly inputs: readonly Done[]
        readonly marks: TaskMarks
        readonly trigger: string
        readonly signal: AbortSignal
      }

      const insertTask = (n: NodeRun, input: string): string => {
        const id = randomUUID()
        const now = Date.now()
        db.run(
          `INSERT INTO task (id, run_id, workflow_id, node_id, node_name, node_number, input, state,
             created_at, started_at, outside_mark, program_mark, sensitive_mark)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
          id,
          n.run.id,
          n.run.workflow_id,
          n.node.id,
          n.node.name,
          n.node.number,
          input,
          now,
          now,
          n.marks.outside ? JSON.stringify(n.marks.outside) : null,
          n.marks.program ? 1 : 0,
          n.marks.sensitive,
        )
        changed(n.run.workflow_id, n.run.id)
        return id
      }

      const saveMarks = (taskId: string, marks: TaskMarks) => {
        db.run(
          "UPDATE task SET outside_mark = ?, program_mark = ?, sensitive_mark = ? WHERE id = ?",
          marks.outside ? JSON.stringify(marks.outside) : null,
          marks.program ? 1 : 0,
          marks.sensitive,
          taskId,
        )
      }

      const finishTask = (taskId: string, end: End) => {
        const now = Date.now()
        db.run(
          `UPDATE task SET state = ?, error_code = ?, error_detail = ?, result = ?, option_id = COALESCE(?, option_id),
             ended_at = ?, ended_as = ?, finished_at = ? WHERE id = ?`,
          end.state,
          end.code,
          end.text,
          end.result,
          end.optionId ?? null,
          now,
          end.state,
          now,
          taskId,
        )
      }

      const runNode = async (
        n: NodeRun,
      ): Promise<{ kind: "ended"; done: Done } | { kind: "cancelled"; done: Done }> => {
        const feedback =
          n.node.kind === "text" ? await Effect.runPromise(facts.feedbackFor(n.run.id)) : []
        const results = n.inputs.map((i) => i.result)
        const input =
          n.node.kind === "text"
            ? nodeInput(results, feedback)
            : results.filter((r) => r !== "").join("\n\n")
        const taskId = insertTask(n, input)
        const marks: TaskMarks = { ...n.marks }
        let end: End
        try {
          end =
            n.node.kind === "text"
              ? await runText(n, taskId, input, marks)
              : await runDecision(n, taskId, input, marks)
        } catch (error) {
          // The signal of the run aborted while the task waited or worked.
          end = n.signal.aborted
            ? {
                state: "cancelled",
                code: "user",
                text: "Stopped by you",
                result: taskRow(taskId)?.result ?? "",
              }
            : (() => {
                const f = failureText(error)
                return {
                  state: "failed" as const,
                  code: f.code,
                  text: f.text,
                  result: taskRow(taskId)?.result ?? "",
                }
              })()
        }
        saveMarks(taskId, marks)
        finishTask(taskId, end)
        // The claims of a task end when the task is final (spec 025, flow 4).
        claims.release(taskId)
        changed(n.run.workflow_id, n.run.id)
        const done: Done = {
          node: n.node,
          taskId,
          state: end.state === "cancelled" ? "failed" : end.state,
          result: end.state === "done" ? end.result : end.result,
          optionId: end.optionId ?? null,
          marks,
        }
        return end.state === "cancelled" ? { kind: "cancelled", done } : { kind: "ended", done }
      }

      /** A card of a task: the task waits for the user while it shows (spec 005, 007). */
      const askCard = async (
        n: NodeRun,
        taskId: string,
        marks: TaskMarks,
        pause: () => void,
        resume: () => void,
        card: Omit<
          Parameters<typeof cards.ask>[0],
          | "workflowId"
          | "runId"
          | "taskId"
          | "nodeNumber"
          | "nodeName"
          | "scope"
          | "signal"
          | "outside"
          | "sensitive"
        > & {
          outside?: OutsideSource | null
          sensitive?: SensitiveLabel | null
        },
        signal: AbortSignal,
        waiting: { code: string; detail: string },
      ) => {
        pause()
        db.run(
          "UPDATE task SET state = 'waiting', error_code = ?, error_detail = ?, first_reply_at = COALESCE(first_reply_at, ?) WHERE id = ?",
          waiting.code,
          waiting.detail.slice(0, 500),
          Date.now(),
          taskId,
        )
        setRun(n.run.id, "waiting")
        try {
          return await cards.ask({
            ...card,
            workflowId: n.run.workflow_id,
            runId: n.run.id,
            taskId,
            nodeNumber: n.node.number,
            nodeName: n.node.name,
            scope: "task",
            outside: card.outside ?? marks.outside,
            sensitive: card.sensitive ?? marks.sensitive,
            signal,
          })
        } finally {
          if (!signal.aborted) {
            db.run(
              "UPDATE task SET state = 'running', error_code = NULL, error_detail = NULL WHERE id = ?",
              taskId,
            )
            setRun(n.run.id, "running")
          }
          resume()
        }
      }

      // --- a decision node ----------------------------------------------------------------

      const runDecision = async (
        n: NodeRun,
        taskId: string,
        input: string,
        marks: TaskMarks,
      ): Promise<End> => {
        const options = n.node.options
        const labels = options.map((o) => o.label)
        const result = await Effect.runPromise(
          decision.choose({ question: n.node.question, options: labels, input }),
        )
        if (n.signal.aborted) throw new Error("stopped")
        const probabilities = result.probabilities
        const stored = probabilities
          ? JSON.stringify(Object.fromEntries(labels.map((l, i) => [l, probabilities[i] ?? 0])))
          : null
        if (stored) db.run("UPDATE task SET decision = ? WHERE id = ?", stored, taskId)
        db.run("UPDATE task SET progress = 'started' WHERE id = ?", taskId)
        let pickedId: string | null = null
        if (probabilities) {
          let best = 0
          for (let i = 1; i < probabilities.length; i++)
            if ((probabilities[i] ?? 0) > (probabilities[best] ?? 0)) best = i
          if ((probabilities[best] ?? 0) >= n.node.threshold) pickedId = options[best]?.id ?? null
        }
        if (pickedId === null) {
          // No option wins: the node asks the user to pick one (spec 010, "Flows", item 6).
          const why =
            result.reason === null
              ? "threshold"
              : result.reason === "timeout"
                ? "timeout"
                : result.reason === "not_set_up"
                  ? "off"
                  : result.reason === "network_error" || result.reason === "service_error"
                    ? "timeout"
                    : "invalid"
          const reply = await askCard(
            n,
            taskId,
            marks,
            () => {},
            () => {},
            {
              kind: "pick",
              summary: n.node.question,
              step: null,
              once: true,
              options: options.map((o, i) => ({
                id: o.id,
                label: o.label,
                probability: probabilities?.[i] ?? null,
              })),
              pickReason: why,
              threshold: n.node.threshold,
            },
            n.signal,
            { code: "pick", detail: why },
          )
          pickedId = reply.answer
        }
        return { state: "done", code: null, text: null, result: "", optionId: pickedId }
      }

      // --- a text node --------------------------------------------------------------------

      const strictLevel = (n: NodeRun): PermissionLevel => {
        const w = n.detail.permission
        const own = n.node.permission
        return own && isLooser(w, own) ? own : w
      }

      const runText = async (
        n: NodeRun,
        taskId: string,
        input: string,
        marks: TaskMarks,
      ): Promise<End> => {
        const node = n.node
        const setting = await Effect.runPromise(settings.get)
        const level = strictLevel(n)
        const result = { text: "" }
        const fail = (code: string, text: string): End => ({
          state: "failed",
          code,
          text,
          result: result.text,
        })
        if (!node.accountId || !node.model)
          return fail("no_model", "The node has no provider and no model. Pick them in the node.")
        if (!providers.isConnected(node.accountId))
          return fail("provider_not_connected", "The provider of this node is not connected.")
        const isProgram = providers.isRuntime(node.accountId)

        // One controller for the task: it aborts for Stop, for the silent limit and for the step limit.
        const controller = new AbortController()
        let endedBy: "user" | "silent" | "steps" | null = null
        const abort = (why: "user" | "silent" | "steps") => {
          endedBy ??= why
          controller.abort()
        }
        if (n.signal.aborted) abort("user")
        n.signal.addEventListener("abort", () => abort("user"), { once: true })
        const signal = controller.signal

        // The silent limit (spec 005): no sign of life for the limit stops the turn. The clock stops
        // while the task waits for the user and while a tool step runs.
        const limitMs = setting.silentLimit * runClock.minuteMs
        let paused = 0
        let timer: ReturnType<typeof setTimeout> | null = null
        const arm = () => {
          if (timer) clearTimeout(timer)
          timer = null
          if (limitMs > 0 && paused === 0 && !signal.aborted)
            timer = setTimeout(() => {
              appendLog(platform.dataDir, "workflows", {
                workflowId: n.run.workflow_id,
                runId: n.run.id,
                node: node.number,
                event: "no_answer",
                minutes: setting.silentLimit,
              })
              abort("silent")
            }, limitMs)
        }
        const pause = () => {
          paused++
          arm()
        }
        const resume = () => {
          paused--
          arm()
        }

        let steps = 0
        const observed = new Set<string>()
        let usage = NO_USAGE
        let plan: readonly ListedStep[] | null = null
        const flush = (() => {
          let t: ReturnType<typeof setTimeout> | null = null
          const write = () => {
            t = null
            db.run("UPDATE task SET result = ?, steps = ? WHERE id = ?", result.text, steps, taskId)
            changed(n.run.workflow_id, n.run.id)
          }
          return {
            soon: () => {
              t ??= setTimeout(write, 120)
            },
            now: () => {
              if (t) clearTimeout(t)
              write()
            },
          }
        })()
        const markStarted = () => {
          db.run(
            `UPDATE task SET progress = 'started', first_reply_at = COALESCE(first_reply_at, ?) WHERE id = ?`,
            Date.now(),
            taskId,
          )
        }

        const ctx = {
          workflowId: n.run.workflow_id,
          workspace: n.detail.folder,
          level,
          signal,
          taskId,
          marks,
          onMarks: () => saveMarks(taskId, marks),
          ask: (card: NodeCard) =>
            askCard(
              n,
              taskId,
              marks,
              pause,
              resume,
              {
                kind: card.kind,
                summary: card.summary,
                step: card.step,
                once: card.once,
                outside: card.outside ?? null,
                sensitive: card.sensitive ?? null,
                ...(card.unreadable ? { unreadable: true } : {}),
                ...(card.choices ? { choices: card.choices } : {}),
              },
              signal,
              {
                code: card.kind === "question" ? "question" : "approval",
                detail: card.summary,
              },
            ),
        }

        // A text node on an API account has the memory tool while memory is on for the workflow. A
        // vendor program has tools of its own and none of the app (spec 008, 007).
        const memoryOn = !isProgram && memory.settings(n.run.workflow_id)?.enabled === true
        // The shared folder note is made again at the start of each turn, so it holds the claims of
        // that moment (spec 025). A program gets it too: the note is its only guard.
        const systemNow = () =>
          nodeSystem({
            document: n.detail.document,
            workflowName: n.detail.name,
            nodeNumber: node.number,
            nodeName: node.name,
            folder: n.detail.folder,
            tools: true,
            memory: memoryOn,
            sharedFolderNote: claims.note(n.run.workflow_id),
          })
        const prompt = renderPrompt(node.prompt, input, n.trigger)
        const turns: Turn[] = [
          { role: "user", content: prompt === "" ? "Do the work of this node." : prompt },
        ]

        let continuation = 0
        let previousOpen: string[] | null = null
        const model = node.model
        const accountId = node.accountId
        let tries = 0
        try {
          // One attempt is one reply to the turns, with the tool steps in it.
          for (;;) {
            let attemptSteps = 0
            try {
              db.run(
                "UPDATE task SET progress = CASE progress WHEN 'not_sent' THEN 'sent' ELSE progress END WHERE id = ?",
                taskId,
              )
              arm()
              const events = await Effect.runPromise(
                providers.events(
                  accountId,
                  {
                    model,
                    effort: node.effort,
                    system: systemNow(),
                    turns,
                    signal,
                    workspace: n.detail.folder,
                    permission: level,
                    ...(isProgram
                      ? {}
                      : {
                          tools: memoryOn
                            ? [...NODE_TOOL_DEFS, ...MEMORY_TOOL_DEFS]
                            : NODE_TOOL_DEFS,
                        }),
                    useTools: true,
                    busy: {
                      wait: (k) => {
                        appendLog(platform.dataDir, "workflows", {
                          workflowId: n.run.workflow_id,
                          runId: n.run.id,
                          node: node.number,
                          event: "busy",
                          n: k,
                        })
                        arm()
                      },
                      again: () => arm(),
                    },
                  },
                  {
                    execute: async (call) => {
                      if (steps >= setting.stepLimit) {
                        abort("steps")
                        throw new Error("stopped")
                      }
                      steps++
                      attemptSteps++
                      pause()
                      try {
                        if (memoryOn && isMemoryTool(call.name))
                          return (
                            await memoryTool.execute(
                              {
                                workflowId: n.run.workflow_id,
                                taskId,
                                level,
                                outside: marks.outside,
                                program: marks.program,
                                source: { kind: "run", id: n.run.id },
                                mayPress: true,
                                signal,
                                ask: (text) =>
                                  ctx.ask({
                                    kind: "approval",
                                    summary: text,
                                    step: "memory",
                                    once: true,
                                  }),
                              },
                              call,
                            )
                          ).outcome
                        return await tools.execute(ctx, call)
                      } finally {
                        resume()
                        flush.soon()
                      }
                    },
                    approve: (request) => tools.approval(ctx, request),
                  },
                ),
              )
              for await (const event of events) {
                arm()
                if (event.type === "text") {
                  markStarted()
                  result.text += event.text
                  flush.soon()
                } else if (event.type === "thinking") {
                  markStarted()
                } else if (event.type === "tool") {
                  markStarted()
                  // A program runs its own tools: the app reads each step it reports, once, for
                  // the marks of the task and for the action log (spec 007).
                  if (isProgram && (event.call.id === "" || !observed.has(event.call.id))) {
                    observed.add(event.call.id)
                    tools.observe(ctx, event.call)
                  }
                  if (event.state === "running" && isProgram) {
                    if (steps >= setting.stepLimit) {
                      abort("steps")
                      break
                    }
                    steps++
                    attemptSteps++
                    flush.soon()
                  }
                } else if (event.type === "spent") {
                  usage = addSpent(usage, event)
                  db.run(
                    "UPDATE task SET input_tokens = ?, output_tokens = ?, cached_tokens = ?, cost_micros = ? WHERE id = ?",
                    usage.input,
                    usage.output,
                    usage.cached,
                    usage.costMicros,
                    taskId,
                  )
                } else if (event.type === "plan") {
                  plan = (event as PlanEvent).steps
                }
              }
              if (signal.aborted) throw new Error("stopped")
              // A turn ended with no error: it may be blocked, or the app may ask it to go on.
              const blocked = blockedReason(result.text)
              if (blocked !== null) {
                flush.now()
                return {
                  state: "blocked",
                  code: "blocked",
                  text: blocked.slice(0, BLOCKED_REASON_MAX),
                  result: result.text,
                }
              }
              const open = nextKeepGoing({
                enabled: setting.keepGoing && isProgram,
                plan,
                blocked: false,
                waiting: false,
                count: continuation,
                previous: previousOpen,
              })
              if (open === null) break
              continuation++
              previousOpen = open
              db.run("UPDATE task SET kept_going = ? WHERE id = ?", continuation, taskId)
              turns.push({ role: "assistant", content: result.text })
              turns.push({ role: "user", content: keepGoingMessage(open) })
              result.text += "\n\n"
              changed(n.run.workflow_id, n.run.id)
            } catch (error) {
              if (signal.aborted || endedBy !== null) throw error
              // A plain failure is tried again: 3 tries, 2 seconds apart. A usage limit and a busy
              // model end the call at once. A try that made a tool step is not repeated: the step
              // may have changed things (spec 010, "Rules"; spec 005).
              const f = failureText(error)
              const plain =
                !(error instanceof AppError) &&
                (!(error instanceof ProviderFailure) ||
                  error.code === "provider_error" ||
                  error.code === "provider_unreachable")
              tries++
              if (plain && attemptSteps === 0 && tries < MODEL_TRIES) {
                appendLog(platform.dataDir, "workflows", {
                  workflowId: n.run.workflow_id,
                  runId: n.run.id,
                  node: node.number,
                  event: "retry",
                  try: tries,
                  of: MODEL_TRIES,
                  // The error text of a provider can hold a key: it is hidden as results are
                  // (spec 014).
                  reason: redactSecrets(f.text),
                })
                result.text = ""
                await sleep(runClock.retryWaitMs, signal)
                continue
              }
              flush.now()
              return fail(f.code, f.text)
            }
          }
          flush.now()
          return { state: "done", code: null, text: null, result: result.text }
        } catch {
          flush.now()
          // The task stopped: Stop, the silent limit or the step limit.
          if (endedBy === "silent")
            return fail(`silent:${setting.silentLimit}`, silentText(setting.silentLimit))
          if (endedBy === "steps")
            return fail(`steps:${setting.stepLimit}`, stepLimitText(setting.stepLimit))
          return { state: "cancelled", code: "user", text: "Stopped by you", result: result.text }
        } finally {
          if (timer) clearTimeout(timer)
          signal.aborted || controller.abort()
        }
      }

      // --- starting and stopping ----------------------------------------------------------

      const begin = (runId: string) => {
        const r = runRow(runId)
        if (!r) return
        busy.add(r.workflow_id)
        const entry = { workflowId: r.workflow_id, controller: new AbortController() }
        active.set(runId, entry)
        void execute(runId)
          .catch((error) => {
            // An engine fault ends the run as failed with the text of the fault.
            setRun(
              runId,
              "failed",
              { text: error instanceof Error ? error.message : String(error), code: "engine" },
              true,
            )
          })
          .finally(() => {
            active.delete(runId)
            busy.delete(r.workflow_id)
            for (const listener of endListeners) {
              try {
                listener(r.workflow_id, runId)
              } catch (error) {
                console.error("runs: a listener of the end of a run failed:", error)
              }
            }
            const next = queues.get(r.workflow_id)?.shift()
            if (next) begin(next)
          })
      }

      const start = (
        input: RunStart,
        source: "hand" | "chat" = "hand",
        device: string | null = null,
      ) =>
        Effect.gen(function* () {
          const detail = yield* workflows.get(input.workflowId)
          const nodes = detail.graph.nodes
          if (nodes.length === 0) return yield* new AppError({ code: "run_empty" })
          // A loop never starts, whatever the checker says: this test does not use the checker,
          // so a check that stopped or failed cannot let a loop through.
          if (hasLoop(detail)) return yield* new AppError({ code: "run_loop" })
          // A run does not start when the check finds a problem (spec 010, "Check"). A check that
          // stopped at a limit or could not read the form does not hold back a graph with no loop
          // (docs/spec-questions.md, W1: the rows for the check before a run).
          const outcome = yield* check.check(input.workflowId)
          if (outcome.state === "problem") return yield* new AppError({ code: "run_check_problem" })
          const queued = queues.get(input.workflowId) ?? []
          if (busy.has(input.workflowId) && queued.length >= RUN_QUEUE_MAX)
            return yield* new AppError({ code: "run_queue_full", detail: detail.name })
          const id = randomUUID()
          const waits = busy.has(input.workflowId)
          db.run(
            `INSERT INTO run (id, workflow_id, state, source, trigger_text, device, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            input.workflowId,
            waits ? "queued" : "running",
            source,
            input.trigger ?? "",
            device,
            Date.now(),
          )
          changed(input.workflowId, id)
          workflowsChanged(input.workflowId)
          if (waits) queues.set(input.workflowId, [...queued, id])
          else begin(id)
          return summaryOf(runRow(id) as RunRow)
        })

      const stop = (runId: string) =>
        Effect.gen(function* () {
          const r = runRow(runId)
          if (!r) return yield* new AppError({ code: "run_not_found" })
          if (r.finished_at !== null) return
          const entry = active.get(runId)
          if (entry) {
            entry.controller.abort()
            return
          }
          // A run that still waits behind another run: it ends as cancelled at once.
          const queue = queues.get(r.workflow_id) ?? []
          queues.set(
            r.workflow_id,
            queue.filter((q) => q !== runId),
          )
          setRun(runId, "cancelled", { text: "The run was stopped", code: "run" }, true)
        })

      return Runs.of({
        start,
        stop,
        list: (workflowId) =>
          Effect.sync(() =>
            db
              .all<RunRow>(
                "SELECT * FROM run WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 100",
                workflowId,
              )
              .map(summaryOf),
          ),
        get: (runId) => {
          const r = runRow(runId)
          return r
            ? Effect.sync(() => detailOf(r))
            : Effect.fail(new AppError({ code: "run_not_found" }))
        },
        active: (workflowId) => busy.has(workflowId) || (queues.get(workflowId)?.length ?? 0) > 0,
        onEnded: (listener) => {
          endListeners.push(listener)
        },
      })
    }),
  )
}

/** True when the connections of the graph make a loop of nodes (docs/spec-questions.md, 010). */
const hasLoop = (detail: WorkflowDetail): boolean => {
  const next = new Map<string, string[]>()
  for (const c of detail.graph.connections) next.set(c.from, [...(next.get(c.from) ?? []), c.to])
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    for (const to of next.get(id) ?? []) if (visit(to)) return true
    state.set(id, 2)
    return false
  }
  return detail.graph.nodes.some((n) => visit(n.id))
}

export type { CardAnswer, RunCard }
export { feedbackBlock, TASK_FINAL }
