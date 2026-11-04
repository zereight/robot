import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  type CheckTurn,
  checkNowState,
  isRuntimeKind,
  MEMORY_CHECK_EVERY,
  MEMORY_CHECK_LABEL,
  MEMORY_CHECK_PROPOSALS_MAX,
  MEMORY_CHECK_REPLIES,
  MEMORY_CHECK_SYSTEM,
  MEMORY_CHECK_TOOL,
  MEMORY_CHECK_TOOL_DESCRIPTION,
  type MemoryCheckInfo,
  type MessagePart,
  memoryCheckRequest,
  messageText,
  programName,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall, ToolDef } from "../providers/chat.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Memory } from "./Memory.ts"
import { Platform } from "./Platform.ts"
import { Providers, toAppError } from "./Providers.ts"
import { SettingsStore } from "./Settings.ts"
import { closing, turnWatch } from "./silence.ts"
import { Tasks } from "./Tasks.ts"

export interface MemoryCheckService {
  /** The choice of the agent, its count, and what stops the check (spec 008). */
  info(agentId: string): Effect.Effect<MemoryCheckInfo>
  /**
   * Turns the choice on or off. The count is 0 when it goes on. An agent whose program cannot use
   * the check keeps the choice off.
   */
  setOn(agentId: string, on: boolean): Effect.Effect<void, AppError>
  /**
   * "Check now": adds a check at once, with the turns since the last check. It fails when there
   * are none, when the choice is off, when a check waits or runs, and when the queue is full.
   */
  checkNow(agentId: string): Effect.Effect<void, AppError>
}

/** The tool of the check, as the model reads it. */
const SUGGEST_DEF: ToolDef = {
  name: MEMORY_CHECK_TOOL,
  description: MEMORY_CHECK_TOOL_DESCRIPTION,
  schema: {
    type: "object",
    properties: { text: { type: "string", description: "The fact, in one sentence." } },
    required: ["text"],
  },
}

/** A model that keeps calling the tool is stopped after this many calls. */
const CALLS_MAX = MEMORY_CHECK_PROPOSALS_MAX * 3

interface AgentRow {
  memory_enabled: number
  memory_check: number
  model_account_id: string | null
  model_name: string | null
  model_effort: string | null
  kind: string | null
}

export class MemoryCheck extends Context.Service<MemoryCheck, MemoryCheckService>()(
  "robot/main/MemoryCheck",
) {
  static readonly layer = Layer.effect(
    MemoryCheck,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const memory = yield* Memory
      const platform = yield* Platform
      const providers = yield* Providers
      const settings = yield* SettingsStore
      const tasks = yield* Tasks

      const agentRow = (agentId: string) =>
        db.get<AgentRow>(
          `SELECT a.memory_enabled, a.memory_check, a.model_account_id, a.model_name,
                  a.model_effort, p.kind
           FROM agent a LEFT JOIN provider_account p ON p.id = a.model_account_id
           WHERE a.id = ?`,
          agentId,
        )

      const count = (agentId: string) =>
        db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM memory_check_turn WHERE agent_id = ?",
          agentId,
        )?.n ?? 0

      /** True while a check of this agent waits or runs on this computer. */
      const running = (agentId: string) =>
        db.get(
          `SELECT 1 AS x FROM task WHERE agent_id = ? AND source = 'memory_check'
             AND state IN ('queued', 'running', 'waiting') AND origin IS NULL LIMIT 1`,
          agentId,
        ) !== undefined

      /** The program of an agent that cannot use the check, or null (spec 008). */
      const programOf = (row: AgentRow) =>
        row.kind !== null && isRuntimeKind(row.kind) ? programName(row.kind) : null

      const infoOf = (agentId: string): MemoryCheckInfo | undefined => {
        const row = agentRow(agentId)
        if (!row) return undefined
        return {
          on: row.memory_check === 1,
          count: count(agentId),
          every: MEMORY_CHECK_EVERY,
          program: programOf(row),
          memory: row.memory_enabled === 1,
          running: running(agentId),
        }
      }

      const changed = (agentId: string) => bus.emit("memory.changed", { agentId })

      /** The check counts and runs only while the choice is on, memory is on, and the program can. */
      const active = (row: AgentRow | undefined): row is AgentRow =>
        row !== undefined &&
        row.memory_check === 1 &&
        row.memory_enabled === 1 &&
        programOf(row) === null

      // ---------------------------------------------------------------------- what the check reads

      const messageParts = (id: string | null): MessagePart[] => {
        if (!id) return []
        const found =
          db.get<{ parts: string }>("SELECT parts FROM message WHERE id = ?", id) ??
          db.get<{ parts: string }>("SELECT parts FROM channel_message WHERE id = ?", id)
        if (!found) return []
        try {
          return JSON.parse(found.parts) as MessagePart[]
        } catch {
          return []
        }
      }

      /**
       * One counted turn: the words of the user and the reply of the agent. Tool output, web pages
       * and files are no part of it (spec 008). A message of another agent, of an outside program or
       * of Teams is not a message of the user, so the turn gives its reply only.
       */
      const turnOf = (taskId: string): CheckTurn => {
        const row = db.get<{ message_id: string | null }>(
          "SELECT message_id FROM task WHERE id = ?",
          taskId,
        )
        return {
          user: tasks.userWords(taskId),
          reply: messageText({ parts: messageParts(row?.message_id ?? null) }),
        }
      }

      // ---------------------------------------------------------------------- the check itself

      const execute =
        (agentId: string, made: { n: number; calls: number }) =>
        async (call: ToolCall): Promise<ToolOutcome> => {
          if (call.name !== MEMORY_CHECK_TOOL)
            return { output: `Unknown tool: ${call.name}.`, failed: true }
          made.calls++
          if (made.n >= MEMORY_CHECK_PROPOSALS_MAX || made.calls > CALLS_MAX)
            return { output: MEMORY_CHECK_REPLIES.limit, failed: true }
          let text = ""
          try {
            const input = JSON.parse(call.input) as { text?: unknown }
            if (typeof input.text === "string") text = input.text
          } catch {
            // An input that is not JSON is an empty text.
          }
          const result = await Effect.runPromise(memory.suggest(agentId, text))
          switch (result.kind) {
            case "suggested":
              made.n++
              return { output: MEMORY_CHECK_REPLIES.suggested, failed: false }
            case "known":
              return { output: MEMORY_CHECK_REPLIES.known, failed: false }
            case "too_long":
              return { output: MEMORY_CHECK_REPLIES.tooLong, failed: true }
            case "secret":
              return { output: MEMORY_CHECK_REPLIES.secret, failed: true }
            case "empty":
              return { output: MEMORY_CHECK_REPLIES.empty, failed: true }
            case "off":
              return { output: MEMORY_CHECK_REPLIES.off, failed: true }
            case "saved":
              // The tool never saves: it only makes proposals.
              return { output: MEMORY_CHECK_REPLIES.suggested, failed: false }
          }
        }

      /** The turn of one check. It posts no message and asks nobody (spec 008). */
      const work = (taskId: string, agentId: string) =>
        Effect.gen(function* () {
          const row = agentRow(agentId)
          if (!row?.model_account_id || !row.model_name)
            return yield* new AppError({ code: "provider_not_connected" })
          // The state may have changed while the check waited in the queue.
          if (row.kind !== null && isRuntimeKind(row.kind))
            return yield* new AppError({ code: "memory_check_unavailable" })
          if (row.memory_enabled !== 1) return yield* new AppError({ code: "memory_off" })
          const account = (yield* providers.list).find((a) => a.id === row.model_account_id)
          if (!account?.connected) return yield* new AppError({ code: "provider_not_connected" })

          // The count goes to 0 when the check starts (spec 008).
          const counted = db.all<{ task_id: string }>(
            "SELECT task_id FROM memory_check_turn WHERE agent_id = ? ORDER BY at DESC, rowid DESC",
            agentId,
          )
          db.run("DELETE FROM memory_check_turn WHERE agent_id = ?", agentId)
          changed(agentId)

          const request = memoryCheckRequest({
            items: (yield* memory.list(agentId)).map((i) => i.text),
            proposals: (yield* memory.proposals(agentId)).map((p) => p.text),
            turns: counted.map((c) => turnOf(c.task_id)),
          })

          const scratch = join(platform.dataDir, "scratch")
          mkdirSync(scratch, { recursive: true })
          const controller = new AbortController()
          const watch = turnWatch({
            limitMinutes: (yield* settings.get).silentLimit,
            progress: () => {},
          })
          const made = { n: 0, calls: 0 }
          const events = yield* providers.events(
            account.id,
            {
              model: row.model_name,
              effort: row.model_effort,
              system: MEMORY_CHECK_SYSTEM,
              turns: [{ role: "user", content: request }],
              signal: controller.signal,
              workspace: scratch,
              permission: "ask_all",
              tools: [SUGGEST_DEF],
              useTools: true,
            },
            { execute: execute(agentId, made), approve: async () => false },
          )
          yield* Effect.raceFirst(
            Effect.tryPromise({
              try: async () => {
                for await (const event of closing(events, controller, watch)) {
                  watch.sense(event)
                  if (event.type === "spent") tasks.addSpent(taskId, event)
                }
              },
              catch: toAppError,
            }),
            watch.silent,
          ).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                watch.stop()
                controller.abort()
              }),
            ),
          )
        })

      /** Makes the task of a check and starts its turn in the queue of the agent. */
      const start = (agentId: string) =>
        Effect.gen(function* () {
          const full = tasks.queueFull(agentId)
          if (full) return yield* full
          const task = yield* tasks.create({
            agentId,
            prompt: MEMORY_CHECK_LABEL,
            label: MEMORY_CHECK_LABEL,
            source: "memory_check",
            sourceId: null,
            depth: 0,
          })
          // The turn runs in the background. A failure is on the task, and nobody is told.
          Effect.runFork(tasks.run(task.id, agentId, work(task.id, agentId)).pipe(Effect.ignore))
          changed(agentId)
        })

      /**
       * Adds a check when the count reached 10 and none waits or runs (spec 008). A queue that is
       * full takes none: the next turn that ends as done tries again.
       */
      const consider = (agentId: string) => {
        const row = agentRow(agentId)
        if (!active(row) || count(agentId) < MEMORY_CHECK_EVERY || running(agentId)) return
        Effect.runFork(start(agentId).pipe(Effect.ignore))
      }

      // A turn that ends as done adds 1 to the count of its agent: a chat, a part of a channel job,
      // a routine and a workflow step. A turn that fails, stops, is cancelled or is blocked adds
      // nothing, and neither does a turn of a check. A task that came by sync ran on the other
      // computer, which counts it (spec 008, 019).
      tasks.onEnd((task) => {
        if (task.state !== "done" || task.source === "memory_check" || task.originName !== null)
          return
        if (active(agentRow(task.agentId))) {
          db.run(
            "INSERT OR IGNORE INTO memory_check_turn (task_id, agent_id, at) VALUES (?, ?, ?)",
            task.id,
            task.agentId,
            Date.now(),
          )
          changed(task.agentId)
        }
        consider(task.agentId)
      })

      return MemoryCheck.of({
        info: (agentId) =>
          Effect.suspend(() => {
            const info = infoOf(agentId)
            return info
              ? Effect.succeed(info)
              : Effect.fail(new AppError({ code: "agent_not_found" }))
          }).pipe(Effect.orDie),
        setOn: (agentId, on) =>
          Effect.gen(function* () {
            const row = agentRow(agentId)
            if (!row) return yield* new AppError({ code: "agent_not_found" })
            // A program that cannot call the tools of the app keeps the choice off (spec 008).
            if (on && programOf(row) !== null)
              return yield* new AppError({ code: "memory_check_unavailable" })
            if ((row.memory_check === 1) === on) return
            db.run("UPDATE agent SET memory_check = ? WHERE id = ?", on ? 1 : 0, agentId)
            // The count is 0 when the choice goes on.
            if (on) db.run("DELETE FROM memory_check_turn WHERE agent_id = ?", agentId)
            changed(agentId)
          }),
        checkNow: (agentId) =>
          Effect.gen(function* () {
            const info = infoOf(agentId)
            if (!info) return yield* new AppError({ code: "agent_not_found" })
            if (checkNowState(info) !== "on")
              return yield* new AppError({ code: "memory_check_off" })
            yield* start(agentId)
          }),
      })
    }),
  )
}
