import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  CHAT_ATTACH_BYTES,
  CHAT_ATTACH_MAX,
  CHAT_QUEUE_MAX,
  type ChatBlock,
  type ChatNotice,
  type ChatPart,
  type ChatStatus,
  chatFiles,
  chatText,
  type QueuedChatMessage,
  resolveLocale,
  translate,
  type WorkflowChatHistory,
  type WorkflowChatMessage,
  type WorkflowChatSend,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall } from "../providers/chat.ts"
import { ProviderFailure } from "../providers/client.ts"
import type { JoinedMessage, TurnInbox } from "../providers/turn.ts"
import { chatSystem, FEEDBACK_TOOL } from "./chatPrompt.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { Providers, storedFailure, toAppError } from "./Providers.ts"
import { RunFacts } from "./RunFacts.ts"
import { SettingsStore } from "./Settings.ts"
import { Skills } from "./Skills.ts"
import { Workflows } from "./Workflows.ts"

/** The model that answers in the chat of a workflow. */
export interface AnswerModel {
  readonly accountId: string
  readonly model: string
  readonly effort: string | null
}

export interface ChatService {
  /** The one chat of a workflow: messages, queue, notice, and whether a turn works. */
  readonly history: (workflowId: string) => Effect.Effect<WorkflowChatHistory, AppError>
  /**
   * Sends a message (spec 003, flows 1 and 3). With no turn working, a turn starts. While a turn
   * works, the message joins it or waits in the queue, as the setting says.
   */
  readonly send: (input: WorkflowChatSend) => Effect.Effect<WorkflowChatMessage, AppError>
  /** Ends the turn that works. The partial reply stays and is marked as stopped. Not a run stop. */
  readonly stop: (workflowId: string) => Effect.Effect<void>
  /**
   * Deletes a message that no turn has read yet, or a queued message. Returns its text, so that
   * the box can take it back (edit of a queued message).
   */
  readonly deleteWaiting: (messageId: string) => Effect.Effect<{ text: string }, AppError>
  /** "Send now" on a queued message: it joins the turn that works, or starts a turn. */
  readonly sendNow: (messageId: string) => Effect.Effect<void, AppError>
  /** Retry on a failed reply: asks again with the same conversation. */
  readonly retry: (workflowId: string) => Effect.Effect<void, AppError>
  /** The two buttons of the notice after a restart (spec 003, "Rules"). */
  readonly resume: (workflowId: string, mode: "continue" | "again") => Effect.Effect<void, AppError>
}

interface MessageRow {
  id: string
  workflow_id: string
  author: "user" | "assistant" | "app"
  parts: string
  status: string
  error_code: string | null
  error_detail: string | null
  reply_to: string | null
  model: string | null
  joined_to: string | null
  created_at: number
  finished_at: number | null
  read_at: number | null
}

interface Working {
  readonly assistantId: string
  readonly controller: AbortController
  readonly since: number
  readonly ready: Set<() => void>
}

const FLUSH_MS = 80

export class Chat extends Context.Service<Chat, ChatService>()("robot/main/Chat") {
  static readonly layer = Layer.effect(
    Chat,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform
      const providers = yield* Providers
      const workflows = yield* Workflows
      const skills = yield* Skills
      const settings = yield* SettingsStore
      const facts = yield* RunFacts

      // A reply that was streaming when the app closed is marked as stopped (spec 003, "Rules").
      db.run(
        `UPDATE chat_message SET status = 'stopped', error_code = 'restart', finished_at = ?
         WHERE status = 'streaming'`,
        Date.now(),
      )
      // A message that no turn had read stays in the chat as a plain message.
      db.run(
        "UPDATE chat_message SET joined_to = NULL WHERE joined_to IS NOT NULL AND read_at IS NULL",
      )

      const working = new Map<string, Working>()

      const toMessage = (r: MessageRow): WorkflowChatMessage => ({
        id: r.id,
        workflowId: r.workflow_id,
        author: r.author === "assistant" ? "assistant" : "user",
        parts: JSON.parse(r.parts) as ChatPart[],
        status: r.status as ChatStatus,
        error:
          r.status === "failed"
            ? { code: r.error_code ?? "unknown", detail: r.error_detail }
            : null,
        replyTo: r.reply_to,
        pending: r.joined_to !== null && r.read_at === null,
        model: r.model,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
      })
      const row = (id: string) => db.get<MessageRow>("SELECT * FROM chat_message WHERE id = ?", id)
      const emitMessage = (id: string) => {
        const r = row(id)
        if (r) bus.emit("chat.message", { workflowId: r.workflow_id, message: toMessage(r) })
      }
      const emitState = (workflowId: string) => bus.emit("chat.state", { workflowId })

      const insert = (m: {
        id: string
        workflowId: string
        author: "user" | "assistant"
        parts: readonly ChatPart[]
        status: string
        replyTo?: string | null
        joinedTo?: string | null
        model?: string | null
        createdAt?: number
      }) =>
        db.run(
          `INSERT INTO chat_message (id, workflow_id, author, parts, status, reply_to, joined_to, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          m.id,
          m.workflowId,
          m.author,
          JSON.stringify(m.parts),
          m.status,
          m.replyTo ?? null,
          m.joinedTo ?? null,
          m.model ?? null,
          m.createdAt ?? Date.now(),
        )

      /**
       * The model that answers in the chat. The spec does not say which model answers
       * (docs/spec-questions.md), so for now: the model of the first node that names an account and
       * a model, when that account is connected; else the first connected account and its first
       * model that the user did not hide.
       */
      const resolveModel = (workflowId: string) =>
        Effect.gen(function* () {
          const node = db.get<{ account_id: string; model: string; effort: string | null }>(
            `SELECT account_id, model, effort FROM workflow_node
             WHERE workflow_id = ? AND account_id IS NOT NULL AND model IS NOT NULL
             ORDER BY number LIMIT 1`,
            workflowId,
          )
          if (node && providers.isConnected(node.account_id))
            return {
              accountId: node.account_id,
              model: node.model,
              effort: node.effort,
            } satisfies AnswerModel
          const accounts = yield* providers.list
          for (const account of accounts) {
            if (!account.connected) continue
            const models = yield* providers.models(account.id).pipe(Effect.orElseSucceed(() => []))
            const first = models.find((m) => m.hidden !== true)
            if (first) return { accountId: account.id, model: first.id, effort: null }
          }
          return null
        })

      const blockOf = (workflowId: string): Effect.Effect<ChatBlock> =>
        resolveModel(workflowId).pipe(
          Effect.map((m) => (m ? null : "no_provider")),
          Effect.orElseSucceed((): ChatBlock => "no_provider"),
        )

      const findWorkflow = (id: string) => workflows.get(id)

      /** The text that the model reads for a message of the user. */
      const modelText = (m: WorkflowChatMessage): string => {
        const out: string[] = []
        for (const p of m.parts)
          if (p.kind === "skill")
            out.push(`The user picked the skill "${p.name}". Follow it:\n${p.instructions}`)
        if (m.replyTo) {
          const quoted = row(m.replyTo)
          if (quoted) {
            const quote = chatText(toMessage(quoted)).slice(0, 400)
            out.push(
              `The user replies to this earlier message:\n> ${quote.replaceAll("\n", "\n> ")}`,
            )
          }
        }
        const text = chatText(m)
        if (text) out.push(text)
        const files = chatFiles(m)
        if (files.length > 0)
          out.push(
            `Attached files, in the folder of the workflow:\n${files.map((f) => `- ${f.path}`).join("\n")}`,
          )
        return out.join("\n\n")
      }

      const visibleRows = (workflowId: string) =>
        db.all<MessageRow>(
          "SELECT * FROM chat_message WHERE workflow_id = ? AND status != 'queued' ORDER BY created_at, rowid",
          workflowId,
        )

      const queueOf = (workflowId: string): QueuedChatMessage[] =>
        db
          .all<MessageRow>(
            "SELECT * FROM chat_message WHERE workflow_id = ? AND status = 'queued' ORDER BY created_at, rowid",
            workflowId,
          )
          .map((r) => {
            const m = toMessage(r)
            return { id: m.id, text: chatText(m), files: chatFiles(m).map((f) => f.name) }
          })

      const noticeOf = (messages: readonly WorkflowChatMessage[]): ChatNotice | null => {
        const last = messages.at(-1)
        if (last?.author !== "assistant" || last.status !== "stopped") return null
        const r = row(last.id)
        if (r?.error_code !== "restart") return null
        const reached = last.parts.some((p) => p.kind === "text" || p.kind === "tool")
        return { messageId: last.id, notSent: !reached }
      }

      const history = (workflowId: string) =>
        Effect.gen(function* () {
          const workflow = yield* findWorkflow(workflowId)
          const messages = visibleRows(workflowId).map(toMessage)
          const w = working.get(workflowId)
          return {
            workflowId,
            workflowName: workflow.name,
            messages,
            queue: queueOf(workflowId),
            working: w !== undefined,
            workingSince: w?.since ?? null,
            notice: w ? null : noticeOf(messages),
            block: yield* blockOf(workflowId),
          } satisfies WorkflowChatHistory
        })

      // --- the turn -------------------------------------------------------------------------

      const inboxFor = (workflowId: string, w: Working): TurnInbox => ({
        take: () => {
          const rows = db.all<MessageRow>(
            `SELECT * FROM chat_message WHERE workflow_id = ? AND joined_to = ? AND read_at IS NULL
             ORDER BY created_at, rowid`,
            workflowId,
            w.assistantId,
          )
          if (rows.length === 0) return []
          const now = Date.now()
          for (const r of rows)
            db.run("UPDATE chat_message SET read_at = ? WHERE id = ?", now, r.id)
          for (const r of rows) emitMessage(r.id)
          return rows.map((r): JoinedMessage => ({ id: r.id, text: modelText(toMessage(r)) }))
        },
        watch: (ready) => {
          w.ready.add(ready)
          return () => {
            w.ready.delete(ready)
          }
        },
      })

      const lastUserId = (workflowId: string) =>
        db.get<{ id: string }>(
          "SELECT id FROM chat_message WHERE workflow_id = ? AND author = 'user' AND status != 'queued' ORDER BY created_at DESC, rowid DESC LIMIT 1",
          workflowId,
        )?.id ?? null

      /** Adds feedback to a run when the model calls the tool (spec 003, "Feedback"). */
      const feedbackTool = async (
        workflowId: string,
        call: ToolCall,
        parts: ChatPart[],
        touch: () => void,
      ): Promise<ToolOutcome> => {
        let input: { text?: unknown; node?: unknown; run?: unknown } = {}
        try {
          const parsed: unknown = JSON.parse(call.input || "{}")
          if (typeof parsed === "object" && parsed !== null) input = parsed
        } catch {
          // A call with arguments that are not JSON has no text: the tool says so.
        }
        const text = typeof input.text === "string" ? input.text.trim() : ""
        if (text === "") return { output: "Not added: the feedback text is empty.", failed: true }
        const runs = (await Effect.runPromise(facts.runs(workflowId))).filter((r) => r.active)
        if (runs.length === 0) {
          const last = (await Effect.runPromise(facts.runs(workflowId)))[0]
          return {
            output: last
              ? `Not added: no run works or waits. The last run ended with the state ${last.state}. Tell the user that the run ended and that the feedback was not added.`
              : "Not added: this workflow has never run. Tell the user: No run yet.",
            failed: false,
          }
        }
        const named = typeof input.run === "string" ? input.run : ""
        const run =
          runs.length === 1 && named === ""
            ? runs[0]
            : runs.find((r) => named !== "" && (r.id === named || r.id.startsWith(named)))
        if (!run)
          return {
            output: `Not added: more than one run works or waits. Ask the user which run it is: ${runs
              .map((r) => `${r.id.slice(0, 8)} (started ${new Date(r.startedAt).toISOString()})`)
              .join(", ")}.`,
            failed: false,
          }
        const nodeNumber =
          typeof input.node === "number" && Number.isInteger(input.node) ? input.node : null
        const exit = await Effect.runPromiseExit(
          facts.addFeedback({ runId: run.id, nodeNumber, text, messageId: lastUserId(workflowId) }),
        )
        if (exit._tag !== "Success")
          return { output: "Not added: the run has ended. Tell the user.", failed: false }
        const nodes = [...exit.value.nodes]
        parts.push({
          kind: "note",
          note: "feedback_added",
          runId: run.id,
          startedAt: run.startedAt,
          nodes,
        })
        touch()
        return {
          output: `Feedback added to run ${run.id.slice(0, 8)}. ${
            nodes.length > 0
              ? `Nodes that will get it: ${nodes.join(", ")}.`
              : "No node will get it, because no text node starts after it."
          }`,
          failed: false,
        }
      }

      const runTurn = async (workflowId: string, w: Working): Promise<void> => {
        const parts: ChatPart[] = []
        let timer: ReturnType<typeof setTimeout> | null = null
        let tokensIn = 0
        let tokensOut = 0
        const save = () => {
          timer = null
          db.run(
            "UPDATE chat_message SET parts = ?, input_tokens = ?, output_tokens = ? WHERE id = ?",
            JSON.stringify(parts),
            tokensIn,
            tokensOut,
            w.assistantId,
          )
          emitMessage(w.assistantId)
        }
        const touch = () => {
          timer ??= setTimeout(save, FLUSH_MS)
        }
        let status: ChatStatus = "done"
        let failure: { code: string; detail: string } | null = null
        try {
          const model = await Effect.runPromise(resolveModel(workflowId))
          if (!model) throw new AppError({ code: "provider_not_connected" })
          const workflow = await Effect.runPromise(findWorkflow(workflowId))
          const runs = await Effect.runPromise(facts.runs(workflowId))
          const turns = visibleRows(workflowId)
            .filter((r) => r.id !== w.assistantId && !(r.joined_to !== null && r.read_at === null))
            .map(toMessage)
            .filter((m) => m.status !== "failed")
            .map((m) =>
              m.author === "user"
                ? { role: "user" as const, content: modelText(m) }
                : { role: "assistant" as const, content: chatText(m) },
            )
            .filter((t) => t.content.trim() !== "")
          const events = await Effect.runPromise(
            providers.events(
              model.accountId,
              {
                model: model.model,
                effort: model.effort,
                system: chatSystem({ name: workflow.name, document: workflow.document, runs }),
                turns,
                signal: w.controller.signal,
                workspace: workflow.folder,
                permission: workflow.permission,
                tools: [FEEDBACK_TOOL],
                useTools: true,
                cache: "long",
                inbox: inboxFor(workflowId, w),
                busy: {
                  wait: (n) => {
                    parts.push({ kind: "note", note: "busy_retry", n, of: 3 })
                    touch()
                  },
                  again: () => {},
                },
              },
              {
                execute: async (call) => {
                  if (call.name === FEEDBACK_TOOL.name)
                    return feedbackTool(workflowId, call, parts, touch)
                  return { output: `Unknown tool: ${call.name}`, failed: true }
                },
                approve: async () => false,
              },
            ),
          )
          db.run("UPDATE chat_message SET model = ? WHERE id = ?", model.model, w.assistantId)
          for await (const event of events) {
            if (event.type === "text" || event.type === "thinking") {
              const last = parts.at(-1)
              if (last?.kind === event.type)
                parts[parts.length - 1] = { kind: event.type, text: last.text + event.text }
              else parts.push({ kind: event.type, text: event.text })
              touch()
            } else if (event.type === "tool") {
              const index = parts.findIndex((p) => p.kind === "tool" && p.id === event.call.id)
              const part: ChatPart = {
                kind: "tool",
                id: event.call.id,
                name: event.call.name,
                label: event.call.name,
                state: event.state,
                input: event.call.input,
                output: event.state === "running" ? "" : event.output,
              }
              if (index >= 0) parts[index] = part
              else parts.push(part)
              touch()
            } else if (event.type === "spent") {
              tokensIn += event.input ?? 0
              tokensOut += event.output ?? 0
            } else if (event.type === "joined") {
              emitMessage(event.id)
            }
          }
        } catch (error) {
          if (w.controller.signal.aborted) status = "stopped"
          else {
            status = "failed"
            if (error instanceof ProviderFailure) failure = storedFailure(error)
            else if (error instanceof AppError)
              failure = { code: error.code, detail: error.detail ?? "" }
            else {
              const mapped = toAppError(error)
              failure = { code: mapped.code, detail: mapped.detail ?? "" }
            }
          }
        }
        if (timer) clearTimeout(timer)
        db.run(
          `UPDATE chat_message SET parts = ?, input_tokens = ?, output_tokens = ?, status = ?,
             error_code = ?, error_detail = ?, finished_at = ? WHERE id = ?`,
          JSON.stringify(parts),
          tokensIn,
          tokensOut,
          status,
          failure?.code ?? null,
          failure?.detail ?? null,
          Date.now(),
          w.assistantId,
        )
        working.delete(workflowId)
        emitMessage(w.assistantId)
        emitState(workflowId)
        afterTurn(workflowId)
      }

      /** What follows a turn: unread messages start the next turn, else the queue sends one. */
      const afterTurn = (workflowId: string) => {
        const left = db.all<MessageRow>(
          "SELECT * FROM chat_message WHERE workflow_id = ? AND joined_to IS NOT NULL AND read_at IS NULL",
          workflowId,
        )
        if (left.length > 0) {
          db.run(
            "UPDATE chat_message SET joined_to = NULL WHERE workflow_id = ? AND joined_to IS NOT NULL AND read_at IS NULL",
            workflowId,
          )
          for (const r of left) emitMessage(r.id)
          void Effect.runPromiseExit(startTurn(workflowId))
          return
        }
        const next = db.get<MessageRow>(
          "SELECT * FROM chat_message WHERE workflow_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1",
          workflowId,
        )
        if (next) {
          db.run(
            "UPDATE chat_message SET status = 'done', created_at = ? WHERE id = ?",
            Date.now(),
            next.id,
          )
          emitMessage(next.id)
          emitState(workflowId)
          void Effect.runPromiseExit(startTurn(workflowId))
        }
      }

      /** Starts a turn on the conversation as it is now. */
      const startTurn = (workflowId: string): Effect.Effect<void, AppError> =>
        Effect.gen(function* () {
          if (working.has(workflowId)) return
          const model = yield* resolveModel(workflowId)
          if (!model) return yield* new AppError({ code: "provider_not_connected" })
          const assistantId = randomUUID()
          insert({
            id: assistantId,
            workflowId,
            author: "assistant",
            parts: [],
            status: "streaming",
            model: model.model,
          })
          const w: Working = {
            assistantId,
            controller: new AbortController(),
            since: Date.now(),
            ready: new Set(),
          }
          working.set(workflowId, w)
          emitMessage(assistantId)
          emitState(workflowId)
          void runTurn(workflowId, w)
        })

      // --- files ----------------------------------------------------------------------------

      /** Copies the attached files into the folder of the workflow (spec 003, flow 4). */
      const attach = (folder: string, paths: readonly string[]) =>
        Effect.gen(function* () {
          if (paths.length > CHAT_ATTACH_MAX) return yield* new AppError({ code: "too_many_files" })
          const dir = join(folder, "attachments")
          const out: ChatPart[] = []
          for (const path of paths) {
            let size: number
            try {
              size = statSync(path).size
            } catch {
              return yield* new AppError({ code: "file_unreadable", detail: basename(path) })
            }
            if (size > CHAT_ATTACH_BYTES)
              return yield* new AppError({ code: "file_too_large", detail: basename(path) })
            mkdirSync(dir, { recursive: true })
            const ext = extname(path)
            const stem = basename(path, ext)
            let name = basename(path)
            for (let n = 2; ; n++) {
              try {
                statSync(join(dir, name))
                name = `${stem} ${n}${ext}`
              } catch {
                break
              }
            }
            try {
              copyFileSync(path, join(dir, name))
            } catch {
              return yield* new AppError({ code: "file_unreadable", detail: basename(path) })
            }
            out.push({ kind: "file", name, path: join("attachments", name), size })
          }
          return out
        })

      const send = (input: WorkflowChatSend) =>
        Effect.gen(function* () {
          const text = input.text.trim()
          const paths = input.files ?? []
          if (text === "" && paths.length === 0 && !input.skillId)
            return yield* new AppError({ code: "message_empty" })
          const workflow = yield* findWorkflow(input.workflowId)
          if (!(yield* resolveModel(input.workflowId)))
            return yield* new AppError({ code: "provider_not_connected" })
          const w = working.get(input.workflowId)
          const mode = (yield* settings.get).duringTurn
          if (w && mode === "queue") {
            const waiting = queueOf(input.workflowId).length
            if (waiting >= CHAT_QUEUE_MAX) return yield* new AppError({ code: "queue_full" })
          }
          const parts: ChatPart[] = []
          if (input.skillId) {
            const skill = yield* skills.usable(input.skillId)
            parts.push({ kind: "skill", name: skill.name, instructions: skill.instructions })
          }
          if (text !== "") parts.push({ kind: "text", text })
          parts.push(...(yield* attach(workflow.folder, paths)))
          const id = randomUUID()
          const queued = w !== undefined && mode === "queue"
          insert({
            id,
            workflowId: input.workflowId,
            author: "user",
            parts,
            status: queued ? "queued" : "done",
            replyTo: input.replyTo ?? null,
            joinedTo: w && !queued ? w.assistantId : null,
          })
          emitMessage(id)
          emitState(input.workflowId)
          if (w && !queued) for (const ready of w.ready) ready()
          if (!w) yield* startTurn(input.workflowId)
          return toMessage(row(id) as MessageRow)
        })

      const deleteWaiting = (messageId: string) =>
        Effect.gen(function* () {
          const r = row(messageId)
          const waiting =
            r && (r.status === "queued" || (r.joined_to !== null && r.read_at === null))
          if (!r || !waiting) return yield* new AppError({ code: "message_read" })
          db.run("DELETE FROM chat_message WHERE id = ?", messageId)
          bus.emit("chat.state", { workflowId: r.workflow_id })
          return { text: chatText(toMessage(r)) }
        })

      const sendNow = (messageId: string) =>
        Effect.gen(function* () {
          const r = row(messageId)
          if (r?.status !== "queued") return yield* new AppError({ code: "message_read" })
          const w = working.get(r.workflow_id)
          const now = Date.now()
          if (w) {
            db.run(
              "UPDATE chat_message SET status = 'done', joined_to = ?, created_at = ? WHERE id = ?",
              w.assistantId,
              now,
              messageId,
            )
            emitMessage(messageId)
            emitState(r.workflow_id)
            for (const ready of w.ready) ready()
          } else {
            db.run(
              "UPDATE chat_message SET status = 'done', created_at = ? WHERE id = ?",
              now,
              messageId,
            )
            emitMessage(messageId)
            emitState(r.workflow_id)
            yield* startTurn(r.workflow_id)
          }
        })

      const retry = (workflowId: string) =>
        Effect.gen(function* () {
          if (working.has(workflowId)) return
          const last = visibleRows(workflowId).at(-1)
          if (last?.author !== "assistant" || last.status !== "failed")
            return yield* new AppError({ code: "message_read" })
          db.run("DELETE FROM chat_message WHERE id = ?", last.id)
          emitState(workflowId)
          yield* startTurn(workflowId)
        })

      const resume = (workflowId: string, mode: "continue" | "again") =>
        Effect.gen(function* () {
          if (working.has(workflowId)) return
          const notice = noticeOf(visibleRows(workflowId).map(toMessage))
          if (!notice) return yield* new AppError({ code: "message_read" })
          if (mode === "again" || notice.notSent) {
            // The request had not reached the model: the same text goes again (spec 003).
            if (mode === "again" && !notice.notSent)
              return yield* new AppError({ code: "message_read" })
            db.run("DELETE FROM chat_message WHERE id = ?", notice.messageId)
            emitState(workflowId)
            yield* startTurn(workflowId)
            return
          }
          const language = (yield* settings.get).language
          const locale = resolveLocale(language, platform.systemLocale())
          yield* send({ workflowId, text: translate(locale, "chat.continue_text") })
        })

      return Chat.of({
        history,
        send,
        stop: (workflowId) =>
          Effect.sync(() => {
            working.get(workflowId)?.controller.abort()
          }),
        deleteWaiting,
        sendNow,
        retry,
        resume,
      })
    }),
  )
}
