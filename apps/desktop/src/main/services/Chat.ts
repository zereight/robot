import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  CHAT_ATTACH_BYTES,
  CHAT_ATTACH_MAX,
  CHAT_QUEUE_MAX,
  type ChatAnswer,
  type ChatMarks,
  type ChatNotice,
  type ChatPart,
  type ChatStatus,
  chatFiles,
  chatText,
  guardVerdict,
  isOutsideSource,
  type OutsideSource,
  type PermissionLevel,
  type QueuedChatMessage,
  type RunFact,
  resolveLocale,
  type SensitiveLabel,
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
import { chatMayUse } from "../runtimes/driver.ts"
import { ActionLog } from "./ActionLog.ts"
import { Cards } from "./Cards.ts"
import { chatDir } from "./chatDir.ts"
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
  /**
   * The user picks the account and the model that answer in the chat. The choice stays until the
   * account or the model is gone, or the user picks another one. It takes effect at the next turn.
   */
  readonly setModel: (
    workflowId: string,
    accountId: string,
    model: string,
  ) => Effect.Effect<void, AppError>
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
  /** The user clears the marks of the chat: outside content and sensitive read (spec 007). */
  readonly clearMarks: (workflowId: string) => Effect.Effect<void, AppError>
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
      const cards = yield* Cards
      const actionLog = yield* ActionLog

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

      /** The choice that was made for this chat, or null. */
      const storedChoice = (workflowId: string): AnswerModel | null => {
        const r = db.get<{ account_id: string; model: string; effort: string | null }>(
          "SELECT account_id, model, effort FROM workflow_chat_model WHERE workflow_id = ?",
          workflowId,
        )
        return r ? { accountId: r.account_id, model: r.model, effort: r.effort } : null
      }

      /** Keeps the choice for the next turns. */
      const keepChoice = (workflowId: string, m: AnswerModel) => {
        db.run(
          `INSERT INTO workflow_chat_model (workflow_id, account_id, model, effort) VALUES (?, ?, ?, ?)
           ON CONFLICT (workflow_id) DO UPDATE SET account_id = excluded.account_id,
             model = excluded.model, effort = excluded.effort`,
          workflowId,
          m.accountId,
          m.model,
          m.effort,
        )
      }

      /** True when the account lists the model. A list that cannot be read does not say "gone". */
      const offers = (accountId: string, model: string) =>
        providers.models(accountId).pipe(
          Effect.map((list) => list.some((m) => m.id === model)),
          Effect.orElseSucceed(() => true),
        )

      /**
       * True when the chat may use the account: an API account, or a vendor program that the
       * launcher can lock to text only with flags that the program enforces (`chatSafe`).
       */
      const chatSafe = (accountId: string) => chatMayUse(providers.runtimeKind(accountId))
      const usable = (accountId: string) => providers.isConnected(accountId) && chatSafe(accountId)

      /**
       * The model that answers in the chat, and the name of an account that the chat had to pass
       * over because the program cannot be locked to text only. The choice of the chat stays while
       * its account is usable and still offers the model. The spec does not say how the first
       * choice is made (docs/spec-questions.md), so for now: the model of the first node that names
       * an account and a model, when that account is usable; else the first usable account and its
       * first model that the user did not hide. This only reads: the caller keeps the choice when
       * the user sends a message or picks (`keepChoice`).
       */
      const resolveChoice = (workflowId: string) =>
        Effect.gen(function* () {
          const accounts = yield* providers.accounts
          const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? ""
          const stored = storedChoice(workflowId)
          const storedUnsafe =
            stored && providers.isConnected(stored.accountId) && !chatSafe(stored.accountId)
              ? nameOf(stored.accountId)
              : null
          // The first account that the chat passed over, for the line that says why.
          const firstUnsafe = () =>
            accounts.find((a) => a.connected && !chatSafe(a.id))?.name ?? null
          if (
            stored &&
            usable(stored.accountId) &&
            // A program lists its models by a look at the program: only an API list is read here.
            (providers.isRuntime(stored.accountId) ||
              (yield* offers(stored.accountId, stored.model)))
          )
            return { model: stored, skipped: null as string | null }
          const node = db.get<{ account_id: string; model: string; effort: string | null }>(
            `SELECT account_id, model, effort FROM workflow_node
             WHERE workflow_id = ? AND account_id IS NOT NULL AND model IS NOT NULL
             ORDER BY number LIMIT 1`,
            workflowId,
          )
          if (node && usable(node.account_id))
            return {
              model: {
                accountId: node.account_id,
                model: node.model,
                effort: node.effort,
              } satisfies AnswerModel,
              skipped: storedUnsafe,
            }
          // The last known state of each account: no look at a program.
          for (const account of accounts) {
            if (!account.connected || !chatSafe(account.id)) continue
            const models = yield* providers.models(account.id).pipe(Effect.orElseSucceed(() => []))
            const first = models.find((m) => m.hidden !== true)
            if (first)
              return {
                model: { accountId: account.id, model: first.id, effort: null },
                skipped: storedUnsafe,
              }
          }
          return { model: null, skipped: storedUnsafe ?? firstUnsafe() }
        })

      const resolveModel = (workflowId: string) =>
        resolveChoice(workflowId).pipe(Effect.map((r) => r.model))

      /** A vendor program has its own tools: the chat gives it none (spec 007). */
      const chatHasTools = (accountId: string) => !providers.isRuntime(accountId)

      const answerOf = (m: AnswerModel | null) =>
        Effect.gen(function* () {
          if (!m) return null
          const account = (yield* providers.accounts).find((a) => a.id === m.accountId)
          return {
            accountId: m.accountId,
            accountName: account?.name ?? "",
            model: m.model,
            feedback: chatHasTools(m.accountId),
          } satisfies ChatAnswer
        })

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
        // A message that joined the turn and that the model had not read when the app stopped is a
        // plain message after the cut reply. The notice stays while only such messages follow it.
        let at = messages.length - 1
        while (at >= 0 && messages[at]?.author === "user") at--
        const last = messages[at]
        if (last?.author !== "assistant" || last.status !== "stopped") return null
        const r = row(last.id)
        if (r?.error_code !== "restart") return null
        const reached = last.parts.some((p) => p.kind === "text" || p.kind === "tool")
        return { messageId: last.id, notSent: !reached }
      }

      // --- the marks of the chat (spec 007, "The mark of a place") ----------------------------

      const readMarks = (workflowId: string): ChatMarks => {
        const r = db.get<{ outside_mark: string | null; sensitive_mark: string | null }>(
          "SELECT outside_mark, sensitive_mark FROM workflow WHERE id = ?",
          workflowId,
        )
        let outside: OutsideSource | null = null
        let program = false
        if (r?.outside_mark) {
          try {
            const v = JSON.parse(r.outside_mark) as { source?: unknown; program?: unknown }
            if (isOutsideSource(v.source)) outside = v.source
            program = v.program === true
          } catch {
            // A mark that cannot be read counts as no mark.
          }
        }
        return { outside, program, sensitive: (r?.sensitive_mark as SensitiveLabel | null) ?? null }
      }

      const writeMarks = (workflowId: string, marks: ChatMarks) => {
        db.run(
          "UPDATE workflow SET outside_mark = ?, sensitive_mark = ? WHERE id = ?",
          marks.outside || marks.program
            ? JSON.stringify({ source: marks.outside, program: marks.program })
            : null,
          marks.sensitive,
          workflowId,
        )
        emitState(workflowId)
      }

      /**
       * A turn of the chat that reads the result of a task holds what the task held (spec 007). The
       * mark stays until the user clears it.
       */
      const markFromRuns = (workflowId: string, runs: readonly RunFact[]): ChatMarks => {
        const now = readMarks(workflowId)
        let outside = now.outside
        let program = now.program
        for (const run of runs)
          for (const n of run.nodes) {
            if (n.result === null || n.result === "") continue
            outside ??= n.outside
            program ||= n.program
          }
        const next: ChatMarks = { outside, program, sensitive: now.sensitive }
        if (outside !== now.outside || program !== now.program) writeMarks(workflowId, next)
        return next
      }

      const history = (workflowId: string) =>
        Effect.gen(function* () {
          const workflow = yield* findWorkflow(workflowId)
          const messages = visibleRows(workflowId).map(toMessage)
          const w = working.get(workflowId)
          // The model is read once for the whole call. A read does not write to the database.
          const { model, skipped } = yield* resolveChoice(workflowId).pipe(
            Effect.orElseSucceed(() => ({ model: null, skipped: null as string | null })),
          )
          return {
            workflowId,
            workflowName: workflow.name,
            messages,
            queue: queueOf(workflowId),
            working: w !== undefined,
            workingSince: w?.since ?? null,
            notice: w ? null : noticeOf(messages),
            block: model ? null : "no_provider",
            answer: yield* answerOf(model),
            unsafeAccount: skipped,
            cards: cards.list(workflowId),
            marks: readMarks(workflowId),
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

      /** Spaces and line breaks of a text count as one space, for the check of the words. */
      const squash = (text: string) => text.replace(/\s+/g, " ").trim()

      /**
       * The words that the user typed in this turn (spec 003, "Feedback"; spec 007): the messages of
       * the user since the last reply before this turn, and the messages that joined it. Quotes,
       * skill texts and file names are not words of the user. A result, a page or a message from an
       * outside program is never in this list.
       */
      const turnUserWords = (workflowId: string, w: Working): string[] => {
        const rows = visibleRows(workflowId)
        const at = rows.findIndex((r) => r.id === w.assistantId)
        const words: string[] = []
        for (let i = (at === -1 ? rows.length : at) - 1; i >= 0; i--) {
          const r = rows[i]
          if (!r || r.author === "assistant") break
          if (r.author === "user") words.push(chatText(toMessage(r)))
        }
        for (const r of rows.slice(at === -1 ? rows.length : at + 1))
          if (r.author === "user" && r.joined_to === w.assistantId)
            words.push(chatText(toMessage(r)))
        return words.filter((t) => t.trim() !== "")
      }

      /** Adds feedback to a run when the model calls the tool (spec 003, "Feedback"). */
      const feedbackTool = async (
        workflowId: string,
        w: Working,
        level: PermissionLevel,
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
        // Guard (a): only the words of the user, copied exactly (spec 003, 007). The check is on the
        // text itself, so a result, a page or a program cannot pass its own words as feedback.
        const wanted = squash(text)
        if (!turnUserWords(workflowId, w).some((t) => squash(t).includes(wanted)))
          return {
            output:
              "Not added: the text is not in the words that the user wrote in this turn. Feedback must be copied exactly from the message of the user. Tell the user that the feedback was not added.",
            failed: true,
          }
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
        // Guard (b): feedback is a guarded step. In a turn that holds outside content it asks the
        // user, with the full text; at "Full access" it asks only with the program mark.
        const marks = readMarks(workflowId)
        const logStep = (decidedBy: "level" | "user", result: "ran" | "refused" | "stopped") =>
          actionLog.add({
            workflowId,
            kind: "feedback",
            target: text,
            decidedBy,
            result,
            taskId: null,
            outside: marks.outside,
            sensitive: marks.sensitive,
          })
        if (
          guardVerdict({ level, outside: marks.outside !== null, program: marks.program }) === "ask"
        ) {
          let reply: Awaited<ReturnType<typeof cards.ask>>
          try {
            reply = await cards.ask({
              workflowId,
              runId: run.id,
              taskId: null,
              nodeNumber,
              nodeName: null,
              kind: "approval",
              summary: text,
              step: "feedback",
              once: true,
              outside: marks.outside,
              scope: "turn",
              sensitive: marks.sensitive,
              signal: w.controller.signal,
            })
          } catch {
            logStep("user", "stopped")
            return { output: "Not added: the turn was stopped.", failed: true }
          }
          if (reply.answer === "deny") {
            logStep("user", "refused")
            return {
              output:
                "Not added: the user refused the feedback. Tell the user that the feedback was not added.",
              failed: false,
            }
          }
          logStep("user", "ran")
        } else logStep("level", "ran")
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

      const runTurn = async (workflowId: string, w: Working, model: AnswerModel): Promise<void> => {
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
          const workflow = await Effect.runPromise(findWorkflow(workflowId))
          // The chat has the tools of the chat (spec 007) and no others. A vendor program brings
          // shell and file tools of its own, so it answers in text only, outside the folder.
          const withTools = chatHasTools(model.accountId)
          const runs = await Effect.runPromise(facts.runs(workflowId))
          // The results in the prompt are outside content: the chat takes their marks (spec 007).
          markFromRuns(workflowId, runs)
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
                system: chatSystem({
                  name: workflow.name,
                  document: workflow.document,
                  runs,
                  feedback: withTools,
                }),
                turns,
                signal: w.controller.signal,
                workspace: withTools ? workflow.folder : chatDir(),
                permission: withTools ? workflow.permission : "read_only",
                ...(withTools ? { tools: [FEEDBACK_TOOL] } : {}),
                useTools: withTools,
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
                    return feedbackTool(workflowId, w, workflow.permission, call, parts, touch)
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
      const startTurn = (workflowId: string, known?: AnswerModel): Effect.Effect<void, AppError> =>
        Effect.gen(function* () {
          if (working.has(workflowId)) return
          const model = known ?? (yield* resolveModel(workflowId))
          if (!model || !usable(model.accountId))
            return yield* new AppError({ code: "provider_not_connected" })
          // The choice is stored when a turn starts, not when the history is read.
          keepChoice(workflowId, model)
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
          void runTurn(workflowId, w, model)
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
          const model = yield* resolveModel(input.workflowId)
          if (!model) return yield* new AppError({ code: "provider_not_connected" })
          // A question card of a task waits for an answer (spec 003): a message in the chat answers
          // the oldest one, and no turn starts for it.
          if (text !== "" && paths.length === 0 && !input.skillId && !input.replyTo) {
            const id = randomUUID()
            const open = cards.open(input.workflowId).some((c) => c.kind === "question")
            if (open) {
              insert({
                id,
                workflowId: input.workflowId,
                author: "user",
                parts: [{ kind: "text", text }],
                status: "done",
                replyTo: null,
                joinedTo: null,
              })
              emitMessage(id)
              cards.answerInChat(input.workflowId, text)
              emitState(input.workflowId)
              return toMessage(row(id) as MessageRow)
            }
          }
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
          if (!w) yield* startTurn(input.workflowId, model)
          return toMessage(row(id) as MessageRow)
        })

      const setModel = (workflowId: string, accountId: string, model: string) =>
        Effect.gen(function* () {
          yield* findWorkflow(workflowId)
          if (!providers.isConnected(accountId))
            return yield* new AppError({ code: "provider_not_connected" })
          if (!chatSafe(accountId))
            return yield* new AppError({
              code: "chat_account_unsafe",
              detail: (yield* providers.accounts).find((a) => a.id === accountId)?.name ?? "",
            })
          const listed = yield* providers.models(accountId)
          if (!listed.some((m) => m.id === model))
            return yield* new AppError({ code: "chat_model_unknown" })
          keepChoice(workflowId, { accountId, model, effort: null })
          emitState(workflowId)
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

      const clearMarks = (workflowId: string) =>
        Effect.gen(function* () {
          yield* findWorkflow(workflowId)
          writeMarks(workflowId, { outside: null, program: false, sensitive: null })
        })

      return Chat.of({
        history,
        clearMarks,
        send,
        setModel,
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
