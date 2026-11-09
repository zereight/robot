import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  type ApprovalOutput,
  addSpent,
  approvalResultOf,
  BLOCKED_REASON_MAX,
  blockedReason,
  type CardAnswer,
  catalogues,
  isLooser,
  keepGoingMessage,
  type ListedStep,
  MODEL_RETRY_WAIT_MS,
  MODEL_TRIES,
  type ModelPick,
  NO_TASK_CONNECTIONS,
  NO_USAGE,
  NOTE_NAME_CHARS,
  type NodeKind,
  nextKeepGoing,
  type OutsideSource,
  type PermissionLevel,
  parseOutsideSource,
  plainLine,
  QUEUE_BEHIND,
  QUEUE_SLOT,
  quietTimeMs,
  RUN_QUEUE_MAX,
  type RunCard,
  type RunDetail,
  type RunNode,
  type RunSource,
  type RunStart,
  type RunSummary,
  type RunTask,
  type RunWorktree,
  redactSecrets,
  type SensitiveLabel,
  TASK_CONNECTION_STEPS_MAX,
  type TaskConnectionStep,
  type TaskConnections,
  type TaskState,
  verdictAnswerOf,
  verdictJsonOf,
  type WorkflowDetail,
  type WorkflowNode,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { PlanEvent } from "../providers/agent.ts"
import type { Turn } from "../providers/chat.ts"
import { ProviderFailure } from "../providers/client.ts"
import { goOnTurns } from "../providers/resume.ts"
import { ActionLog } from "./ActionLog.ts"
import { Browsers } from "./Browsers.ts"
import {
  addModelUsage,
  type BackupDeps,
  isBackupChoice,
  limitSwitch,
  mainAnswered,
  noteOf,
  readNote,
  startsOnBackup,
  workLog,
  writeNote,
} from "./backupRun.ts"
import { Cards } from "./Cards.ts"
import { Connections, type ConnectionTurn } from "./Connections.ts"
import type { ConnectionTaskContext } from "./connectionTools.ts"
import { Database } from "./Database.ts"
import { Decision } from "./Decision.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { FileClaims } from "./FileClaims.ts"
import {
  branchExists,
  createWorktree,
  isWorktreeDirty,
  removeWorktree as removeGitWorktree,
  slugOfName,
  worktreeStamp,
} from "./GitWorktrees.ts"
import { appendLog } from "./logs.ts"
import { Memory } from "./Memory.ts"
import { ModelHolds } from "./ModelHolds.ts"
import { isMemoryTool, MEMORY_TOOL_DEFS, makeMemoryTool } from "./memoryTool.ts"
import { makeNodeTools, NODE_TOOL_DEFS, type NodeCard, type TaskMarks } from "./NodeTools.ts"
import { Platform } from "./Platform.ts"
import { Proposals } from "./Proposals.ts"
import { Providers } from "./Providers.ts"
import { Rules } from "./Rules.ts"
import { RunFacts } from "./RunFacts.ts"
import { readyNode, stalled } from "./runGraph.ts"
import {
  feedbackBlock,
  nodeInput,
  nodeSystem,
  renderPrompt,
  silentText,
  stepLimitText,
} from "./runPrompt.ts"
import { SettingsStore } from "./Settings.ts"
import { TaskQueue } from "./TaskQueue.ts"
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
  /** The longest quiet time (spec 005, "Quiet line"). */
  quietMs: 90_000,
}

export interface RunsService {
  /** Starts a run. The run works on and the call returns at once (spec 010). */
  readonly start: (
    input: RunStart,
    source?: RunSource,
    /** The linked device that started the run: "Started by <device>" (spec 012). */
    device?: string | null,
  ) => Effect.Effect<RunSummary, AppError>
  /** Stops a run: its tasks are cancelled and a card that waits goes away (spec 005). */
  readonly stop: (runId: string) => Effect.Effect<void, AppError>
  /** Stops one task. This ends its run (spec 005, "Tasks page"). */
  readonly stopTask: (taskId: string) => Effect.Effect<void, AppError>
  /**
   * Tries a failed, blocked or cancelled task again: a new run of that one node, with the same
   * input, linked to the old task. The nodes after it do not run (docs/spec-questions.md, B2).
   */
  readonly retryTask: (
    taskId: string,
    /** The linked device that tries again: the retry run is "Started by <device>" (spec 012). */
    device?: string | null,
  ) => Effect.Effect<string, AppError>
  readonly list: (workflowId: string) => Effect.Effect<readonly RunSummary[]>
  readonly get: (runId: string) => Effect.Effect<RunDetail, AppError>
  /** Shows the new worktree of a run in the system file browser (spec 007). */
  readonly openWorktree: (runId: string) => Effect.Effect<void, AppError>
  /**
   * Removes the folder of the new worktree of a run and keeps its branch (spec 007). With
   * changes that are not committed and `confirmed` false it removes nothing and says so.
   */
  readonly removeWorktree: (
    runId: string,
    confirmed: boolean,
  ) => Effect.Effect<"removed" | "needs_confirm", AppError>
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
  worktree_path: string | null
  worktree_branch: string | null
  worktree_removed: number
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
  /** An approval node: the stored answer as JSON (the answer, the comment and the time). */
  verdict: string | null
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
  /** The notice lines and tool lines of the connections that the task used (spec 018). */
  connection_notes: string | null
  backup_note: string | null
}

/** How a task ended. */
interface End {
  readonly state: "done" | "failed" | "blocked" | "cancelled"
  readonly code: string | null
  readonly text: string | null
  readonly result: string
  /** For a decision node: the option taken. */
  readonly optionId?: string | null
  /** For an approval node that the user answered: the answer, the comment and the time. */
  readonly verdict?: {
    readonly verdict: ApprovalOutput
    readonly comment: string | null
    readonly answeredAt: number
  }
}

const TASK_FINAL = ["done", "failed", "blocked", "cancelled"]

/** The notes of a task as the row keeps them. Text that is not valid reads as no note. */
const readConnectionNotes = (text: string | null): TaskConnections => {
  if (!text) return NO_TASK_CONNECTIONS
  try {
    const v = JSON.parse(text) as Partial<TaskConnections>
    const list = (x: unknown) =>
      Array.isArray(x) ? x.filter((n): n is string => typeof n === "string") : []
    return {
      down: list(v.down),
      held: list(v.held),
      steps: Array.isArray(v.steps) ? (v.steps as TaskConnections["steps"]) : [],
    }
  } catch {
    return NO_TASK_CONNECTIONS
  }
}

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
      const browsers = yield* Browsers
      const connections = yield* Connections
      const holds = yield* ModelHolds
      const memory = yield* Memory
      const proposals = yield* Proposals
      const queue = yield* TaskQueue
      const backupDeps: BackupDeps = {
        holds,
        ready: (accountId) => Effect.runPromise(providers.verify(accountId)),
      }
      const tools = makeNodeTools({ rules, actionLog, platform, claims, browsers })
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

      /** `only`: a retry runs one node alone, with the input of the first try. */
      interface OnlyNode {
        readonly nodeNumber: number
        readonly input: string
        readonly retryOf: string
        /** The marks of the task that is tried again: the retry holds them too (spec 007). */
        readonly marks: TaskMarks
      }
      const active = new Map<
        string,
        { workflowId: string; controller: AbortController; seq: number; only?: OnlyNode }
      >()
      let runCounter = 0
      /** The tasks that the user stopped one by one: their reason is "Stopped by you". */
      const stoppedTasks = new Set<string>()

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
        const approvalView = verdictAnswerOf(t.verdict)
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
          approval: approvalView,
          outside: parseOutsideSource(t.outside_mark),
          program: t.program_mark === 1,
          sensitive: (t.sensitive_mark as SensitiveLabel | null) ?? null,
          steps: t.steps,
          backupNote: readNote(t.backup_note),
          memory: memory.ofTask(t.id),
          claims: claims.ofTask(t.id),
          refusals,
          connections: readConnectionNotes(t.connection_notes),
        }
      }

      const nodesOf = (workflowId: string) =>
        db.all<{ number: number; name: string; kind: NodeKind }>(
          "SELECT number, name, kind FROM workflow_node WHERE workflow_id = ? ORDER BY number",
          workflowId,
        )

      /** A run made by Retry holds one node alone: its first task links to the task it tries again. */
      const isRetryRun = (runId: string) =>
        db.get(
          "SELECT 1 AS x FROM task WHERE run_id = ? AND retry_of IS NOT NULL LIMIT 1",
          runId,
        ) !== undefined

      const summaryOf = (r: RunRow): RunSummary => {
        const total = isRetryRun(r.id) ? 1 : nodesOf(r.workflow_id).length
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
          worktree:
            r.worktree_path !== null && r.worktree_branch !== null
              ? {
                  path: r.worktree_path,
                  branch: r.worktree_branch,
                  removed: r.worktree_removed === 1,
                }
              : null,
          ended: r.state === "done" ? total : (endedTasks ?? 0),
          total,
        }
      }

      const detailOf = (r: RunRow): RunDetail => {
        const retryRun = isRetryRun(r.id)
        const nodes = nodesOf(r.workflow_id).filter(
          (n) =>
            !retryRun ||
            db.get(
              "SELECT 1 AS x FROM task WHERE run_id = ? AND node_number = ? LIMIT 1",
              r.id,
              n.number,
            ) !== undefined,
        )
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
        // A run that has ended stays as it ended (a stop can end a queued run at once).
        if (!r || r.finished_at !== null) return
        db.run(
          `UPDATE run SET state = ?, reason = ?, reason_code = ?, finished_at = ? WHERE id = ?`,
          state,
          reason ? reason.text : r.reason,
          reason ? reason.code : r.reason_code,
          finished ? Date.now() : r.finished_at,
          runId,
        )
        changed(r.workflow_id, runId)
        // The working mark of the workflow follows the run state (spec 039): tell the lists
        // when the state moves, never for a write that changes nothing.
        if (finished || r.state !== state) workflowsChanged(r.workflow_id)
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
        readonly output: ApprovalOutput | null
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
        const only = entry.only
        const incoming = new Map<string, typeof graph.connections>()
        for (const n of graph.nodes) incoming.set(n.id, [])
        if (!only)
          for (const c of graph.connections) incoming.set(c.to, [...(incoming.get(c.to) ?? []), c])
        const ended = new Map<string, Done | "skipped">()
        const order = [...graph.nodes]
          .filter((n) => !only || n.number === only.nodeNumber)
          .sort((a, b) => a.number - b.number)
        const trigger = r.trigger_text
        // Every text node of a run with a new worktree works in it as its folder (spec 007,
        // "New worktree"): the tools, the permission rules and the vendor programs all read it.
        const runDetail = { ...detail, folder: r.worktree_path ?? detail.folder }

        let stop: { state: TaskState; text: string | null; code: string | null } | null = null

        const passes = (c: (typeof graph.connections)[number]): Done | null => {
          const from = ended.get(c.from)
          if (!from || from === "skipped") return null
          if (from.state === "failed" || from.state === "blocked")
            return from.node.continueOnFailure ? passesOption(c, from) : null
          return passesOption(c, from)
        }
        const passesOption = (c: (typeof graph.connections)[number], from: Done): Done | null => {
          const s = c.source
          if (s.kind === "option") return s.optionId === from.optionId ? from : null
          if (s.kind === "verdict") return s.verdict === from.output ? from : null
          return from
        }

        for (;;) {
          if (runSignal.aborted) break
          const ready = readyNode(order, incoming, ended)
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
          // A retry has no input tasks: it takes over the marks of the task that it tries again.
          const marks = only ? { ...only.marks } : mergeMarks(results)
          const done = await runNode({
            run: r,
            detail: runDetail,
            node: ready,
            inputs: results,
            marks,
            trigger,
            signal: runSignal,
            ...(only ? { fixedInput: only.input, retryOf: only.retryOf } : {}),
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
        if (stop === null && stalled(order, incoming, ended))
          stop = {
            state: "failed",
            text: "No node could start, and some nodes did not run",
            code: "run_no_ready_node",
          }
        if (stop) setRun(runId, stop.state, { text: stop.text, code: stop.code }, true)
        else setRun(runId, "done", { text: null, code: null }, true)
      }

      // --- the queue and the slots (spec 005, "Queue"; the order is in `taskScheduler.ts`) --------

      /** The reason of each queued task: behind a task of its workflow, or no free slot. */
      const refreshWaits = () => {
        const slots = queue.slots()
        for (const [taskId, why] of queue.scheduler.reasons()) {
          const row = taskRow(taskId)
          if (row?.state !== "queued") continue
          const code = why.kind === "behind" ? QUEUE_BEHIND : QUEUE_SLOT
          const detail = why.kind === "behind" ? why.holder.nodeName : String(slots)
          if (row.error_code === code && row.error_detail === detail) continue
          db.run(
            "UPDATE task SET error_code = ?, error_detail = ? WHERE id = ?",
            code,
            detail,
            taskId,
          )
          changed(row.workflow_id, row.run_id)
        }
      }
      queue.scheduler.onChange(refreshWaits)

      /** The task got a slot: it runs (and so does its run). */
      const markRunning = (runId: string, taskId: string) => {
        db.run(
          "UPDATE task SET state = 'running', started_at = ?, error_code = NULL, error_detail = NULL WHERE id = ?",
          Date.now(),
          taskId,
        )
        setRun(runId, "running", { text: null, code: null })
      }

      interface NodeRun {
        readonly run: RunRow
        readonly detail: WorkflowDetail
        readonly node: WorkflowNode
        readonly inputs: readonly Done[]
        readonly marks: TaskMarks
        readonly trigger: string
        readonly signal: AbortSignal
        /** A retry: the input of the first try, and the task that it tries again. */
        readonly fixedInput?: string
        readonly retryOf?: string
      }

      const insertTask = (n: NodeRun, input: string): string => {
        const id = randomUUID()
        const now = Date.now()
        db.run(
          `INSERT INTO task (id, run_id, workflow_id, node_id, node_name, node_number, input, state,
             created_at, retry_of, outside_mark, program_mark, sensitive_mark)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          id,
          n.run.id,
          n.run.workflow_id,
          n.node.id,
          n.node.name,
          n.node.number,
          input,
          now,
          n.retryOf ?? null,
          n.marks.outside ? JSON.stringify(n.marks.outside) : null,
          n.marks.program ? 1 : 0,
          n.marks.sensitive,
        )
        changed(n.run.workflow_id, n.run.id)
        return id
      }

      /** The marks that a task row holds (spec 007). */
      const marksOf = (t: TaskRow): TaskMarks => ({
        outside: parseOutsideSource(t.outside_mark),
        program: t.program_mark === 1,
        sensitive: (t.sensitive_mark as SensitiveLabel | null) ?? null,
      })

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
             verdict = COALESCE(?, verdict),
             ended_at = ?, ended_as = ?, finished_at = ?
           WHERE id = ? AND state IN ('queued', 'running', 'waiting')`,
          end.state,
          end.code,
          end.text,
          end.result,
          end.optionId ?? null,
          end.verdict ? verdictJsonOf(end.verdict) : null,
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
          n.node.kind === "text" && n.fixedInput === undefined
            ? await Effect.runPromise(facts.feedbackFor(n.run.id))
            : []
        const results = n.inputs.map((i) => i.result)
        const input =
          n.fixedInput ??
          (n.node.kind === "text"
            ? nodeInput(results, feedback)
            : results.filter((r) => r !== "").join("\n\n"))
        const none: Done = {
          node: n.node,
          taskId: "",
          state: "failed",
          result: "",
          optionId: null,
          output: null,
          marks: n.marks,
        }
        // The run was stopped while the node got its input: it makes no task.
        if (n.signal.aborted) return { kind: "cancelled", done: none }
        const taskId = insertTask(n, input)
        const marks: TaskMarks = { ...n.marks }
        let end: End
        try {
          // The task joins the queue of its workflow and waits for a free slot (spec 005, "Queue").
          const place = queue.scheduler.enter(
            {
              taskId,
              workflowId: n.run.workflow_id,
              runId: n.run.id,
              source: n.run.source as RunSource,
              runSeq: active.get(n.run.id)?.seq ?? 0,
              nodeNumber: n.node.number,
              nodeName: n.node.name,
              runStartedAt: n.run.started_at,
            },
            n.signal,
          )
          if (!place.granted) {
            setRun(n.run.id, "queued", { text: null, code: null })
            refreshWaits()
          }
          await place.ready
          markRunning(n.run.id, taskId)
          const runners = { text: runText, decision: runDecision, approval: runApproval }
          end = await runners[n.node.kind](n, taskId, input, marks)
        } catch (error) {
          // The signal of the run aborted while the task waited or worked. A task that still
          // waited for a start when the user stopped its run shows "The run was stopped".
          end = n.signal.aborted
            ? taskRow(taskId)?.state === "queued" && !stoppedTasks.has(taskId)
              ? {
                  state: "cancelled",
                  code: "run",
                  text: "The run was stopped",
                  result: taskRow(taskId)?.result ?? "",
                }
              : {
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
        try {
          saveMarks(taskId, marks)
          finishTask(taskId, end)
          // The claims of a task end when the task is final (spec 025, flow 4).
          claims.release(taskId)
        } finally {
          // The slot is free for the next task in the order, also when a write fails. The run keeps
          // the workflow until it ends (`endRun`).
          queue.scheduler.release(taskId)
          stoppedTasks.delete(taskId)
        }
        changed(n.run.workflow_id, n.run.id)
        const done: Done = {
          node: n.node,
          taskId,
          state: end.state === "cancelled" ? "failed" : end.state,
          result: end.state === "done" ? end.result : end.result,
          optionId: end.optionId ?? null,
          output: end.verdict?.verdict ?? null,
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
        // A task that waits for the user uses no slot. Its workflow stays held (spec 005, "Queue").
        queue.scheduler.suspend(taskId)
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
            // The user answered: the task needs a slot again, at the front of the order.
            const back = queue.scheduler.resume(taskId, signal)
            if (queue.scheduler.isWaiting(taskId)) {
              db.run(
                "UPDATE task SET state = 'queued', error_code = ?, error_detail = ? WHERE id = ?",
                QUEUE_SLOT,
                String(queue.slots()),
                taskId,
              )
              setRun(n.run.id, "queued")
              refreshWaits()
            }
            await back.catch(() => undefined)
            if (!signal.aborted) {
              db.run(
                "UPDATE task SET state = 'running', error_code = NULL, error_detail = NULL WHERE id = ?",
                taskId,
              )
              setRun(n.run.id, "running")
            }
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

      const runApproval = async (
        n: NodeRun,
        taskId: string,
        input: string,
        marks: TaskMarks,
      ): Promise<End> => {
        const reply = await askCard(
          n,
          taskId,
          marks,
          () => {},
          () => {},
          {
            kind: "verdict",
            summary: n.node.question,
            input,
            step: null,
            once: true,
          },
          n.signal,
          { code: "verdict", detail: "" },
        )
        const verdict =
          reply.answer === "approve" || reply.answer === "reject" ? reply.answer : null
        if (verdict === null)
          return {
            state: "failed",
            code: "invalid_input",
            text: "The answer is not Approve or Reject.",
            result: "",
          }
        const comment = reply.comment ?? ""
        return {
          state: "done",
          code: null,
          text: null,
          result: approvalResultOf(input, comment),
          verdict: {
            verdict,
            comment: comment === "" ? null : comment,
            answeredAt: reply.answeredAt,
          },
        }
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
        // The backup model (spec 006): while the hold of the main model lasts, the task starts on
        // the backup. A limit of the main model moves it there later (see the catch below).
        let current: ModelPick = (await startsOnBackup(backupDeps, node))
          ? (node.backup as ModelPick)
          : { accountId: node.accountId, model: node.model, effort: node.effort }
        let onBackup = isBackupChoice(current, node)
        if (!providers.isConnected(current.accountId))
          return fail("provider_not_connected", "The provider of this node is not connected.")
        let isProgram = providers.isRuntime(current.accountId)

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
        // while the task waits for the user and while a tool step runs. A turn of a node takes the
        // limit of the node, or the setting when the node follows it (spec 010). The turn keeps it:
        // a change during the turn counts for the next turn only.
        const minutes = node.silentLimit === "follow" ? setting.silentLimit : node.silentLimit
        const limitMs = minutes * runClock.minuteMs
        let paused = 0
        let timer: ReturnType<typeof setTimeout> | null = null
        // The quiet line shows when the turn shows no sign of life for the quiet time. Its clock
        // is the clock of the silent limit and stops in the same cases (spec 005, "Quiet line").
        const watchQuiet = async () =>
          queue.quiet.watch(taskId, {
            workflowId: n.run.workflow_id,
            name:
              (await Effect.runPromise(providers.accounts)).find((a) => a.id === current.accountId)
                ?.name ?? "",
            quietMs: quietTimeMs(limitMs, runClock.quietMs),
          })
        let quiet = await watchQuiet()
        const arm = () => {
          quiet.set(paused > 0)
          if (timer) clearTimeout(timer)
          timer = null
          if (limitMs > 0 && paused === 0 && !signal.aborted)
            timer = setTimeout(() => {
              appendLog(platform.dataDir, "workflows", {
                workflowId: n.run.workflow_id,
                runId: n.run.id,
                node: node.number,
                event: "no_answer",
                minutes,
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
        /** True when the try that runs now got a sign back: it is "Started" (spec 005, 006). */
        let startedTry = false
        const work = workLog()
        const markStarted = () => {
          startedTry = true
          db.run(
            `UPDATE task SET progress = 'started', first_reply_at = COALESCE(first_reply_at, ?) WHERE id = ?`,
            Date.now(),
            taskId,
          )
        }

        // A text node on an API account gets the tools of the connections that its workflow may
        // use, once for the task: the connections start now and the count is made now (spec 018,
        // "Many tools"). A vendor program has none (spec 018, "Rules"). The wait is not silence.
        const notes: { down: string[]; held: string[]; steps: TaskConnectionStep[] } = {
          down: [],
          held: [],
          steps: [],
        }
        const saveNotes = () => {
          db.run("UPDATE task SET connection_notes = ? WHERE id = ?", JSON.stringify(notes), taskId)
          changed(n.run.workflow_id, n.run.id)
        }
        let connectionTurn: ConnectionTurn | null = null
        if (!isProgram) {
          pause()
          let stoppedAtStart = false
          try {
            // Stop ends the wait for the start at once (the start itself may take up to 20
            // seconds). A connection that is still starting is not kept by this task: it ends
            // when it is idle (spec 018).
            connectionTurn = await Effect.runPromise(connections.forTurn(n.run.workflow_id), {
              signal,
            })
          } catch (error) {
            if (!signal.aborted) throw error
            stoppedAtStart = true
          } finally {
            resume()
          }
          if (stoppedAtStart) {
            flush.now()
            if (timer) clearTimeout(timer)
            quiet.stop()
            return { state: "cancelled", code: "user", text: "Stopped by you", result: result.text }
          }
          if (!connectionTurn) throw new Error("The connections did not start.")
          notes.down = connectionTurn.down.map((name) => plainLine(name, NOTE_NAME_CHARS))
          notes.held = connectionTurn.held.map((name) => plainLine(name, NOTE_NAME_CHARS))
          if (notes.down.length > 0 || notes.held.length > 0) saveNotes()
        }
        const turnOfConnections = connectionTurn
        const connectionsOf: ConnectionTaskContext | undefined =
          turnOfConnections && turnOfConnections.count > 0
            ? {
                turn: turnOfConnections,
                note: (line) => {
                  if (notes.steps.length >= TASK_CONNECTION_STEPS_MAX) return
                  notes.steps.push(line)
                  saveNotes()
                },
              }
            : undefined

        const ctx = {
          workflowId: n.run.workflow_id,
          workspace: n.detail.folder,
          level,
          signal,
          taskId,
          marks,
          ...(connectionsOf ? { connections: connectionsOf } : {}),
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
                ...(card.hidden ? { hidden: card.hidden } : {}),
                ...(card.choices ? { choices: card.choices } : {}),
                ...(card.control ? { control: card.control } : {}),
              },
              signal,
              {
                code:
                  card.kind === "question"
                    ? "question"
                    : card.kind === "control"
                      ? "control"
                      : "approval",
                detail: card.summary,
              },
            ),
        }

        // A text node on an API account has the memory tool while memory is on for the workflow. A
        // vendor program has tools of its own and none of the app (spec 008, 007).
        const memoryFor = () => !isProgram && memory.settings(n.run.workflow_id)?.enabled === true
        let memoryOn = memoryFor()
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
            // A run with a new worktree works where no other workflow does: no note (025).
            sharedFolderNote: n.run.worktree_path !== null ? null : claims.note(n.run.workflow_id),
            // A program has no tools of the app (spec 018). After a switch to a backup of another
            // kind the rule follows the model that answers now, not the one that began the task.
            connectionRule: connectionsOf && !isProgram ? connectionsOf.turn.rule() : "",
          })
        const prompt = renderPrompt(node.prompt, input, n.trigger)
        const turns: Turn[] = [
          { role: "user", content: prompt === "" ? "Do the work of this node." : prompt },
        ]

        let continuation = 0
        let previousOpen: string[] | null = null
        let tries = 0
        try {
          // One attempt is one reply to the turns, with the tool steps in it.
          for (;;) {
            let attemptSteps = 0
            startedTry = false
            work.reset()
            try {
              db.run(
                "UPDATE task SET progress = CASE progress WHEN 'not_sent' THEN 'sent' ELSE progress END WHERE id = ?",
                taskId,
              )
              arm()
              const events = await Effect.runPromise(
                providers.events(
                  current.accountId,
                  {
                    model: current.model,
                    effort: current.effort,
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
                          // The tools of the connections can grow during the task: a tool that
                          // the node found by search opens to it (spec 018, "Many tools").
                          ...(connectionsOf ? { moreTools: () => connectionsOf.turn.defs() } : {}),
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
                  work.text(event.text)
                  result.text += event.text
                  flush.soon()
                } else if (event.type === "thinking") {
                  markStarted()
                } else if (event.type === "tool") {
                  markStarted()
                  work.tool(event)
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
                  addModelUsage(db, taskId, current, event)
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
              if (!onBackup) mainAnswered(backupDeps, node)
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
              // A limit of the main model moves the turn to the backup model, in the same task
              // (spec 006). The failed try ran steps ("Started"): the backup gets a short message
              // that asks it to go on. It ran none: the backup runs the turn from the start.
              const switched = await limitSwitch(backupDeps, node, error, onBackup, signal)
              // The task ended while the backup was checked: it is over, no hold and no line.
              if (signal.aborted || endedBy !== null) throw error
              if (switched) {
                const main = current.model
                current = switched.backup
                onBackup = true
                isProgram = providers.isRuntime(current.accountId)
                memoryOn = memoryFor()
                quiet.stop()
                quiet = await watchQuiet()
                if (switched.fresh) writeNote(db, taskId, noteOf(main, switched))
                if (startedTry) {
                  turns.splice(
                    0,
                    turns.length,
                    ...goOnTurns(turns, work.parts(), { steps: isProgram }),
                  )
                  result.text += "\n\n"
                } else result.text = ""
                changed(n.run.workflow_id, n.run.id)
                continue
              }
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
          if (endedBy === "silent") return fail(`silent:${minutes}`, silentText(minutes))
          if (endedBy === "steps")
            return fail(`steps:${setting.stepLimit}`, stepLimitText(setting.stepLimit))
          return { state: "cancelled", code: "user", text: "Stopped by you", result: result.text }
        } finally {
          if (timer) clearTimeout(timer)
          quiet.stop()
          signal.aborted || controller.abort()
        }
      }

      // --- starting and stopping ----------------------------------------------------------

      /**
       * Makes the new worktree of a run with the switch on (spec 007, "New worktree"): a folder
       * in the default workspace folder named after the workflow and the run time, on a new
       * branch `robot/<slug>-<stamp>` from HEAD. Two runs in one second share a branch name: the
       * next free number wins. A failure throws the reason from git.
       */
      const makeRunWorktree = async (
        detail: WorkflowDetail,
        runId: string,
      ): Promise<RunWorktree> => {
        const setting = await Effect.runPromise(settings.get)
        const root = setting.workspaceRoot || platform.defaultWorkspaceRoot
        mkdirSync(root, { recursive: true })
        const slug = slugOfName(detail.name) || "workflow"
        const stamp = worktreeStamp(new Date())
        const path = join(root, `${slug}-${stamp}-${runId.slice(0, 6)}`)
        let branch = `robot/${slug}-${stamp}`
        for (let n = 2; ; n++) {
          try {
            await createWorktree(detail.folder, path, branch)
            return { path, branch, removed: false }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            // The branch is taken but the path is this run's own: try the next number.
            if (
              n <= 10 &&
              /already exists/.test(reason) &&
              (await branchExists(detail.folder, branch))
            ) {
              branch = `robot/${slug}-${stamp}-${n}`
              continue
            }
            throw new Error(reason)
          }
        }
      }

      const begin = (runId: string, only?: OnlyNode) => {
        const r = runRow(runId)
        if (!r) return
        const entry = {
          workflowId: r.workflow_id,
          controller: new AbortController(),
          seq: ++runCounter,
          ...(only ? { only } : {}),
        }
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
            // The workflow is free for the next run, whatever way this run ended.
            queue.scheduler.endRun(runId)
            for (const listener of endListeners) {
              try {
                listener(r.workflow_id, runId)
              } catch (error) {
                console.error("runs: a listener of the end of a run failed:", error)
              }
            }
          })
      }

      /** Makes a run and lets it work. A run that must wait starts as "queued" (spec 005). */
      const launch = async (
        workflowId: string,
        name: string,
        source: RunSource,
        trigger: string,
        device: string | null,
        only?: OnlyNode,
        /**
         * The worktree of the run: made by `make` after the row exists, or the worktree of the
         * run that a retry tries again. When `make` fails the run is failed and starts no task.
         */
        worktree?: RunWorktree | ((runId: string) => Promise<RunWorktree>) | null,
      ) => {
        const waiting =
          db.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM run WHERE workflow_id = ? AND state = 'queued' AND finished_at IS NULL",
            workflowId,
          )?.n ?? 0
        const id = randomUUID()
        const now = Date.now()
        if (waiting >= RUN_QUEUE_MAX) {
          // The queue of the workflow is full (spec 005, "Queue"): no task is made. A run that a
          // schedule starts is Failed with the reason; any other start shows the reason.
          if (source !== "schedule")
            return { ok: false as const, name, code: "run_queue_full" as const }
          db.run(
            `INSERT INTO run (id, workflow_id, state, source, trigger_text, reason, reason_code, started_at, finished_at)
             VALUES (?, ?, 'failed', ?, ?, ?, 'run_queue_full', ?, ?)`,
            id,
            workflowId,
            source,
            trigger,
            name,
            now,
            now,
          )
          changed(workflowId, id)
          workflowsChanged(workflowId)
          return { ok: true as const, id }
        }
        const another = [...active.values()].some((e) => e.workflowId === workflowId)
        const state = another || queue.scheduler.wouldWait(workflowId) ? "queued" : "running"
        if (typeof worktree === "function") {
          // The row exists while the worktree is made (spec 007, "New worktree"): the run shows,
          // the editor is read-only, and a worktree is never left without its row.
          db.run(
            `INSERT INTO run (id, workflow_id, state, source, trigger_text, device, started_at,
               worktree_path, worktree_branch, worktree_removed)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
            id,
            workflowId,
            state,
            source,
            trigger,
            device,
            now,
          )
          changed(workflowId, id)
          workflowsChanged(workflowId)
          let made: RunWorktree
          try {
            made = await worktree(id)
          } catch (error) {
            // The run does not start: no task is made (spec 007, "New worktree").
            const reason = error instanceof Error ? error.message : String(error)
            setRun(
              id,
              "failed",
              { text: `Could not make a new worktree: ${reason}`, code: "worktree_failed" },
              true,
            )
            return { ok: true as const, id }
          }
          db.run(
            "UPDATE run SET worktree_path = ?, worktree_branch = ? WHERE id = ?",
            made.path,
            made.branch,
            id,
          )
          changed(workflowId, id)
          // A stop while the worktree was made ends the run: no task starts (spec 005).
          const stopped = runRow(id)
          if (stopped && stopped.finished_at !== null) return { ok: true as const, id }
        } else {
          const reused = worktree ?? null
          // A stored worktree whose folder is gone refuses the start with no run (spec 007,
          // "New worktree"). The retry maps the refusal to `worktree_unavailable`.
          if (reused && !existsSync(reused.path))
            return { ok: false as const, name, code: "worktree_unavailable" as const }
          db.run(
            `INSERT INTO run (id, workflow_id, state, source, trigger_text, device, started_at,
               worktree_path, worktree_branch, worktree_removed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            workflowId,
            state,
            source,
            trigger,
            device,
            now,
            reused?.path ?? null,
            reused?.branch ?? null,
            reused?.removed === true ? 1 : 0,
          )
          changed(workflowId, id)
          workflowsChanged(workflowId)
        }
        begin(id, only)
        return { ok: true as const, id }
      }

      /**
       * The checks before a run starts, for a start and for a Retry alike (a retry is a run): the
       * workflow has a node, its graph has no loop, and the check finds no problem.
       */
      const preflight = (workflowId: string) =>
        Effect.gen(function* () {
          const detail = yield* workflows.get(workflowId)
          if (detail.graph.nodes.length === 0) return yield* new AppError({ code: "run_empty" })
          // A loop never starts, whatever the checker says: this test does not use the checker,
          // so a check that stopped or failed cannot let a loop through.
          if (hasLoop(detail)) return yield* new AppError({ code: "run_loop" })
          // A run does not start when the check finds a problem (spec 010, "Check"). A check that
          // stopped at a limit or could not read the form does not hold back a graph with no loop
          // (docs/spec-questions.md, W1: the rows for the check before a run).
          const outcome = yield* check.check(workflowId)
          if (outcome.state === "problem") return yield* new AppError({ code: "run_check_problem" })
          return detail
        })

      const start = (input: RunStart, source: RunSource = "hand", device: string | null = null) =>
        Effect.gen(function* () {
          const detail = yield* preflight(input.workflowId)
          // With the switch on, the run works in its own new worktree, made before the first
          // task. A failure fails the run and starts no task (spec 007, "New worktree").
          const made = yield* Effect.promise(() =>
            launch(
              input.workflowId,
              detail.name,
              source,
              input.trigger ?? "",
              device,
              undefined,
              detail.newWorktree ? (runId: string) => makeRunWorktree(detail, runId) : null,
            ),
          )
          if (!made.ok) return yield* new AppError({ code: "run_queue_full", detail: made.name })
          return summaryOf(runRow(made.id) as RunRow)
        })

      /**
       * Ends the tasks of a run that still wait for a start, at once. A run that has no task that
       * works or waits for the user ends with them. `byTask` is the task that the user stopped.
       */
      const endWaiting = (runId: string, byTask?: string) => {
        for (const taskId of queue.scheduler.cancelRun(runId)) {
          const user = taskId === byTask
          const now = Date.now()
          db.run(
            `UPDATE task SET state = 'cancelled', error_code = ?, error_detail = ?, ended_at = ?,
               ended_as = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'`,
            user ? "user" : "run",
            user ? "Stopped by you" : "The run was stopped",
            now,
            now,
            taskId,
          )
        }
        const r = runRow(runId)
        if (!r || r.finished_at !== null || r.state !== "queued") return
        const works = db.get(
          "SELECT 1 AS x FROM task WHERE run_id = ? AND state IN ('running', 'waiting') LIMIT 1",
          runId,
        )
        if (works) return
        setRun(
          runId,
          "cancelled",
          byTask
            ? { text: "Stopped by you", code: "user" }
            : { text: "The run was stopped", code: "run" },
          true,
        )
      }

      const stop = (runId: string) =>
        Effect.gen(function* () {
          const r = runRow(runId)
          if (!r) return yield* new AppError({ code: "run_not_found" })
          if (r.finished_at !== null) return
          active.get(runId)?.controller.abort()
          endWaiting(runId)
        })

      const stopTask = (taskId: string) =>
        Effect.gen(function* () {
          const t = taskRow(taskId)
          if (!t) return yield* new AppError({ code: "task_not_found" })
          if (!["queued", "running", "waiting"].includes(t.state)) return
          stoppedTasks.add(taskId)
          active.get(t.run_id)?.controller.abort()
          endWaiting(t.run_id, taskId)
        })

      const retryTask = (taskId: string, device: string | null = null) =>
        Effect.gen(function* () {
          const t = taskRow(taskId)
          if (!t) return yield* new AppError({ code: "task_not_found" })
          if (!["failed", "blocked", "cancelled"].includes(t.state))
            return yield* new AppError({ code: "cannot_retry_task" })
          const r = runRow(t.run_id)
          if (!r) return yield* new AppError({ code: "run_not_found" })
          const detail = yield* preflight(r.workflow_id)
          if (!detail.graph.nodes.some((node) => node.number === t.node_number))
            return yield* new AppError({ code: "cannot_retry_task" })
          // A retry of a removed worktree is refused with no run (spec 007, "New worktree"). A
          // worktree whose folder is gone is refused on the reuse path of `launch` below.
          if (r.worktree_path !== null && r.worktree_branch !== null && r.worktree_removed === 1)
            return yield* new AppError({ code: "worktree_unavailable" })
          // Retry follows the rule of the source of the run (spec 005, "Queue"). It holds the
          // marks of the task that it tries again (spec 007, "Outside content"), and it uses the
          // same worktree as the run it tries again (spec 007, "New worktree").
          const made = yield* Effect.promise(() =>
            launch(
              r.workflow_id,
              detail.name,
              r.source as RunSource,
              r.trigger_text,
              device,
              {
                nodeNumber: t.node_number,
                input: t.input,
                retryOf: t.id,
                marks: marksOf(t),
              },
              r.worktree_path !== null && r.worktree_branch !== null
                ? {
                    path: r.worktree_path,
                    branch: r.worktree_branch,
                    removed: r.worktree_removed === 1,
                  }
                : null,
            ),
          )
          if (!made.ok)
            return yield* made.code === "worktree_unavailable"
              ? new AppError({ code: "worktree_unavailable" })
              : new AppError({ code: "run_queue_full", detail: made.name })
          return made.id
        })

      /** The run with its worktree, or the reason it has none to show or remove. */
      const worktreeRow = (runId: string) =>
        Effect.gen(function* () {
          const r = runRow(runId)
          if (!r) return yield* new AppError({ code: "run_not_found" })
          if (r.worktree_path === null || r.worktree_branch === null)
            return yield* new AppError({ code: "worktree_not_found" })
          return r as RunRow & { worktree_path: string; worktree_branch: string }
        })

      const removeFailed = (error: unknown) =>
        new AppError({
          code: "worktree_remove_failed",
          detail: error instanceof Error ? error.message : String(error),
        })

      const openWorktree = (runId: string) =>
        Effect.gen(function* () {
          const r = yield* worktreeRow(runId)
          if (r.worktree_removed === 1) return yield* new AppError({ code: "worktree_removed" })
          yield* Effect.promise(() => platform.openPath(r.worktree_path))
        })

      const removeWorktree = (runId: string, confirmed: boolean) =>
        Effect.gen(function* () {
          const r = yield* worktreeRow(runId)
          if (r.worktree_removed === 1) return "removed" as const
          // A folder that is already gone counts as removed.
          if (existsSync(r.worktree_path)) {
            const dirty = yield* Effect.tryPromise({
              try: () => isWorktreeDirty(r.worktree_path),
              catch: removeFailed,
            })
            if (dirty && !confirmed) return "needs_confirm" as const
            // The removal anchors in the worktree itself, not in the folder of the workflow,
            // which the user may have changed since the run. The branch stays.
            yield* Effect.tryPromise({
              try: () => removeGitWorktree(r.worktree_path, r.worktree_path),
              catch: removeFailed,
            })
          }
          db.run("UPDATE run SET worktree_removed = 1 WHERE id = ?", runId)
          changed(r.workflow_id, runId)
          return "removed" as const
        })

      return Runs.of({
        start,
        stop,
        stopTask,
        retryTask,
        openWorktree,
        removeWorktree,
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
        active: (workflowId) => [...active.values()].some((e) => e.workflowId === workflowId),
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
