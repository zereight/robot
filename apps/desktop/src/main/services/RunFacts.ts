import { randomUUID } from "node:crypto"
import {
  parseOutsideSource,
  type RunFact,
  type RunNodeFact,
  type RunNodeState,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { AppError } from "./errors.ts"

/**
 * The seam between the chat of a workflow (spec 003) and the runs (spec 010, 005).
 *
 * The chat only reads the facts of the runs and adds feedback to a run. It never starts or stops a
 * run. The default layer reads the tables `run` and `task`, so the engine of the runs (W6) feeds
 * the chat by writing those rows with these columns:
 *
 * - `run.state`: the state of the run, in the words of spec 005. `run.finished_at` is NULL while
 *   the run works or waits. `run.reason` is the reason that the run stopped, in words.
 * - `task.state`: one of queued, running, waiting, done, failed, blocked, cancelled.
 * - `task.error_code` and `task.error_detail`: the reason of the state.
 *   queued: `slot` (waits for a free slot) or `behind` (detail: the node that it waits behind).
 *   waiting: `approval` (detail: the step), `question`, or `pick` (detail: `threshold`, `timeout`
 *   or `off`). failed and blocked: the text of the reason in `error_detail`. cancelled: `user`
 *   or `run`.
 * - `task.result`, `task.decision` (JSON `{ "<option label>": probability }`) and `task.option_id`.
 *
 * The engine reads the feedback for a node with {@link RunFactsService.feedbackFor} when the node
 * starts, and adds it to the input of a text node. A decision node does not read it.
 *
 * An engine that keeps its state elsewhere can replace this layer.
 */
export interface RunFactsService {
  /** The runs of a workflow that work or wait, and the last run that ended, newest first. */
  readonly runs: (workflowId: string) => Effect.Effect<readonly RunFact[]>
  /**
   * Adds feedback to a run that works or waits (spec 003, "Feedback"). Returns the numbers of the
   * text nodes that will get it: the text nodes that have not started. Fails with `run_ended` when
   * the run is not active.
   */
  readonly addFeedback: (input: {
    runId: string
    nodeNumber: number | null
    text: string
    messageId: string | null
  }) => Effect.Effect<{ nodes: readonly number[] }, AppError>
  /** The feedback texts of a run, oldest first. A text node reads them with its input. */
  readonly feedbackFor: (runId: string) => Effect.Effect<readonly string[]>
}

export class RunFacts extends Context.Service<RunFacts, RunFactsService>()("robot/main/RunFacts") {
  static readonly layer = Layer.effect(
    RunFacts,
    Effect.gen(function* () {
      const db = yield* Database

      interface RunRow {
        id: string
        state: string
        source: string
        reason: string | null
        started_at: number
        finished_at: number | null
      }
      interface TaskRow {
        node_number: number
        node_name: string
        state: string
        error_code: string | null
        error_detail: string | null
        result: string
        decision: string | null
        option_id: string | null
        outside_mark: string | null
        program_mark: number
      }
      interface NodeRow {
        id: string
        number: number
        name: string
        kind: "text" | "decision"
      }

      const reasonOf = (t: TaskRow): string | null => {
        const detail = t.error_detail ?? ""
        switch (t.state) {
          case "queued":
            return t.error_code === "behind" ? `Waits behind ${detail}` : "Waits for a free slot"
          case "waiting":
            if (t.error_code === "approval")
              return `Waits for your approval${detail ? ` of the step: ${detail}` : ""}. The approval card is in the chat.`
            if (t.error_code === "question") return "Waits for your answer to a question."
            if (t.error_code === "pick")
              return `Waits for your pick of an option. ${
                detail === "timeout"
                  ? "The model gave no answer in 3 seconds."
                  : detail === "off"
                    ? "The choice by the model is off or has no key."
                    : "No option reached the threshold."
              }`
            return "Waits for the user."
          case "failed":
          case "blocked":
            return detail || null
          case "cancelled":
            return t.error_code === "run" ? "The run was stopped" : "Stopped by you"
          default:
            return null
        }
      }

      const factOf = (run: RunRow): RunFact => {
        const workflow = db.get<{ workflow_id: string }>(
          "SELECT workflow_id FROM run WHERE id = ?",
          run.id,
        )
        const nodes = db.all<NodeRow>(
          "SELECT id, number, name, kind FROM workflow_node WHERE workflow_id = ? ORDER BY number",
          workflow?.workflow_id ?? "",
        )
        const tasks = db.all<TaskRow>(
          // The newest task of a node counts: a retry makes a new task.
          `SELECT * FROM task WHERE run_id = ? ORDER BY created_at, rowid`,
          run.id,
        )
        const byNumber = new Map<number, TaskRow>()
        for (const t of tasks) byNumber.set(t.node_number, t)
        const ended = run.finished_at !== null
        const facts: RunNodeFact[] = []
        const seen = new Set<number>()
        const nodeFact = (number: number, name: string, kind: "text" | "decision"): RunNodeFact => {
          const task = byNumber.get(number)
          if (!task) {
            // A node with no task of a run that ended with success was not on the path: skipped.
            const state: RunNodeState = ended && run.state === "done" ? "skipped" : "not_reached"
            return {
              number,
              name,
              kind,
              state,
              reason: null,
              result: null,
              decision: null,
              outside: null,
              program: false,
            }
          }
          const finished = ["done", "failed", "blocked", "cancelled"].includes(task.state)
          let decision: RunNodeFact["decision"] = null
          if (task.decision) {
            try {
              const parsed = JSON.parse(task.decision) as Record<string, number>
              decision = {
                options: Object.entries(parsed).map(([label, probability]) => ({
                  label,
                  probability,
                })),
                taken: task.option_id
                  ? (db.get<{ label: string }>(
                      "SELECT label FROM workflow_option WHERE id = ?",
                      task.option_id,
                    )?.label ?? null)
                  : null,
              }
            } catch {
              decision = null
            }
          }
          return {
            number,
            name,
            kind,
            state: task.state as RunNodeState,
            reason: reasonOf(task),
            result: finished && task.result !== "" ? task.result : null,
            decision,
            outside: parseOutsideSource(task.outside_mark),
            program: task.program_mark === 1,
          }
        }
        for (const n of nodes) {
          seen.add(n.number)
          facts.push(nodeFact(n.number, n.name, n.kind))
        }
        // A node that is gone since the task was made still shows, with the name it had.
        for (const t of tasks)
          if (!seen.has(t.node_number)) {
            seen.add(t.node_number)
            facts.push(nodeFact(t.node_number, t.node_name, "text"))
          }
        facts.sort((a, b) => a.number - b.number)
        return {
          id: run.id,
          state: run.state,
          reason: run.reason,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          source: run.source,
          active: !ended,
          nodes: facts,
        }
      }

      const activeRun = (runId: string) =>
        db.get<RunRow & { workflow_id: string }>("SELECT * FROM run WHERE id = ?", runId)

      return RunFacts.of({
        runs: (workflowId) =>
          Effect.sync(() => {
            const active = db.all<RunRow>(
              "SELECT * FROM run WHERE workflow_id = ? AND finished_at IS NULL ORDER BY started_at DESC, rowid DESC",
              workflowId,
            )
            const last =
              active.length > 0
                ? []
                : db.all<RunRow>(
                    "SELECT * FROM run WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
                    workflowId,
                  )
            return [...active, ...last].map(factOf)
          }),
        addFeedback: (input) =>
          Effect.gen(function* () {
            const run = activeRun(input.runId)
            if (!run || run.finished_at !== null) return yield* new AppError({ code: "run_ended" })
            const fact = factOf(run)
            // A text node that has not started gets the feedback with its input (spec 003).
            const nodes = fact.nodes
              .filter(
                (n) => n.kind === "text" && (n.state === "not_reached" || n.state === "queued"),
              )
              .map((n) => n.number)
            db.run(
              `INSERT INTO run_feedback (id, run_id, workflow_id, node_number, text, message_id, created_at, nodes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              randomUUID(),
              run.id,
              run.workflow_id,
              input.nodeNumber,
              input.text,
              input.messageId,
              Date.now(),
              JSON.stringify(nodes),
            )
            return { nodes }
          }),
        feedbackFor: (runId) =>
          Effect.sync(() =>
            db
              .all<{ text: string; node_number: number | null }>(
                "SELECT text, node_number FROM run_feedback WHERE run_id = ? ORDER BY created_at, rowid",
                runId,
              )
              .map((f) =>
                f.node_number === null ? f.text : `About node ${f.node_number}: ${f.text}`,
              ),
          ),
      })
    }),
  )
}
