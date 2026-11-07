import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  CHAT_ATTACH_BYTES,
  CHAT_ATTACH_MAX,
  CHAT_QUEUE_MAX,
  type ChatAnswer,
  type ChatMarks,
  type ChatMeter,
  type ChatNotice,
  type ChatPart,
  type ChatStatus,
  type CompactOff,
  carriesProgramMark,
  chatFiles,
  chatText,
  compactCut,
  compactDue,
  guardVerdict,
  hourCacheEnded,
  isOutsideSource,
  type ModelInfo,
  type OutsideSource,
  type PermissionLevel,
  PROPOSAL_WAIT_MAX,
  pauseLeft,
  type QueuedChatMessage,
  type RunFact,
  redactSecrets,
  resolveLocale,
  type SensitiveLabel,
  shouldAutoCompact,
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
import { type Actor, CurrentActor } from "./actor.ts"
import {
  ASSISTANT_TOOL_DEFS,
  type AssistantTurn,
  isAssistantTool,
  makeAssistantTools,
  newAssistantTurn,
  type TurnActor,
} from "./assistantTools.ts"
import { Cards } from "./Cards.ts"
import { chatDir } from "./chatDir.ts"
import {
  chatSystem,
  compactSystem,
  compactTranscript,
  FEEDBACK_TOOL,
  reflectText,
  summaryTurn,
} from "./chatPrompt.ts"
import { CHAT_SEARCH_TOOL_DEFS, isChatSearchTool, makeChatSearch } from "./chatSearch.ts"
import { Database } from "./Database.ts"
import { Devices } from "./Devices.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { appendLog } from "./logs.ts"
import { Memory } from "./Memory.ts"
import { isMemoryTool, MEMORY_TOOL_DEFS, makeMemoryTool } from "./memoryTool.ts"
import { Platform } from "./Platform.ts"
import { Proposals } from "./Proposals.ts"
import { Providers, storedFailure, toAppError } from "./Providers.ts"
import { isProposeTool, makeProposeTools, PROPOSE_TOOL_DEFS } from "./proposalTools.ts"
import { RunFacts } from "./RunFacts.ts"
import { Runs } from "./Runs.ts"
import { SettingsStore } from "./Settings.ts"
import { Skills } from "./Skills.ts"
import { WorkflowCheck } from "./WorkflowCheck.ts"
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
  /**
   * The name of the vendor program that answers in the chat, when it cannot use the tools of the
   * app: self-improvement does not work with it (spec 002, "Surfaces", "Runtimes"). Null otherwise.
   */
  readonly programBlock: (workflowId: string) => Effect.Effect<string | null>
  /**
   * The responsible document looks at an ended run and may propose a change (spec 002,
   * "Self-improvement"). It runs by itself after each run; this is the same work, for a test and
   * for a request. It posts no message in the chat.
   */
  readonly reflect: (workflowId: string, runId: string) => Effect.Effect<void>
  /**
   * The user runs Compact (spec 003, "Compact"): the model that answers in the chat writes a
   * summary of the older part, and the line "Compacted" shows. It ends when the compact ends. A
   * compact that is stopped changes nothing and gives no error. Owner only: no linked device may
   * call it (spec 012).
   */
  readonly compact: (workflowId: string) => Effect.Effect<void, AppError>
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
  /** The tokens of the context after the reply (spec 003, "Context meter"), or null. */
  context_tokens: number | null
  /** The linked device that sent a message of the user, or null for the window of this computer. */
  actor_id: string | null
  actor_name: string | null
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
      const devices = yield* Devices
      const bus = yield* EventBus
      const platform = yield* Platform
      const providers = yield* Providers
      const workflows = yield* Workflows
      const skills = yield* Skills
      const settings = yield* SettingsStore
      const facts = yield* RunFacts
      const cards = yield* Cards
      const actionLog = yield* ActionLog
      const memory = yield* Memory
      const proposals = yield* Proposals
      const runs = yield* Runs
      const check = yield* WorkflowCheck
      const memoryTool = makeMemoryTool({ memory, proposals, actionLog })
      const proposeTools = makeProposeTools({ proposals })
      const chatSearch = makeChatSearch(db)
      const assistant = makeAssistantTools({ workflows, runs, facts, check, providers })

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
      /** Compacts that the user started. No turn runs: messages wait in the queue (spec 003). */
      const manualCompacts = new Map<string, { controller: AbortController; since: number }>()
      /** Chats whose turn runs an automatic compact now: the working line reads "Compacting…". */
      const autoCompacting = new Set<string>()
      /** The size of the context of each model from the last look, by account and model. */
      const sizes = new Map<string, number | null>()

      const toMessage = (r: MessageRow): WorkflowChatMessage => ({
        id: r.id,
        workflowId: r.workflow_id,
        author: r.author === "assistant" ? "assistant" : r.author === "app" ? "app" : "user",
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
        /** The linked device that sent the message (spec 012). Null: the window of this computer. */
        actor?: Actor | null
      }) =>
        db.run(
          `INSERT INTO chat_message (id, workflow_id, author, parts, status, reply_to, joined_to, model, created_at, actor_id, actor_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          m.id,
          m.workflowId,
          m.author,
          JSON.stringify(m.parts),
          m.status,
          m.replyTo ?? null,
          m.joinedTo ?? null,
          m.model ?? null,
          m.createdAt ?? Date.now(),
          m.actor?.id ?? null,
          m.actor?.name ?? null,
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

      type CompactedPart = Extract<ChatPart, { kind: "compacted" }>
      /** The line "Compacted" of a row, if the row is one. */
      const compactedOf = (r: MessageRow): CompactedPart | undefined =>
        r.author === "app"
          ? (JSON.parse(r.parts) as ChatPart[]).find(
              (p): p is CompactedPart => p.kind === "compacted",
            )
          : undefined

      /**
       * Puts each line "Compacted" just before the first row that stays word for word. The order of
       * time cannot tell it for rows of the same millisecond, so the line names its row.
       */
      const placeCompacted = (rows: MessageRow[]): MessageRow[] => {
        if (!rows.some((r) => r.author === "app")) return rows
        const lines = rows.filter((r) => compactedOf(r) !== undefined)
        if (lines.length === 0) return rows
        const out = rows.filter((r) => !lines.includes(r))
        const loose: MessageRow[] = []
        for (const line of lines) {
          const at = out.findIndex((r) => r.id === compactedOf(line)?.from)
          if (at >= 0) out.splice(at, 0, line)
          else loose.push(line)
        }
        for (const line of loose) {
          const after = out.findLastIndex((r) => r.created_at <= line.created_at)
          out.splice(after + 1, 0, line)
        }
        return out
      }

      const visibleRows = (workflowId: string) =>
        placeCompacted(
          db.all<MessageRow>(
            "SELECT * FROM chat_message WHERE workflow_id = ? AND status != 'queued' ORDER BY created_at, rowid",
            workflowId,
          ),
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

      // --- Compact and the context meter (spec 003) ---------------------------------------------

      /** A compact that takes longer than this ends as failed. */
      const COMPACT_MS = 5 * 60_000

      /** What the model reads of one message of the chat. */
      const turnOf = (m: WorkflowChatMessage) =>
        m.author === "user"
          ? { role: "user" as const, content: modelText(m) }
          : { role: "assistant" as const, content: chatText(m) }

      /**
       * The rows after the last line "Compacted" that the model reads, with what it reads of each,
       * and the summary that stands in place of the older rows (spec 003, "Compact"). A failed
       * reply, a message that no turn has read, and a row without words are not read.
       */
      const readableRows = (workflowId: string, selfId?: string) => {
        const rows = visibleRows(workflowId)
        const mark = rows.findLastIndex((r) => compactedOf(r) !== undefined)
        const line = mark >= 0 ? rows[mark] : undefined
        const readable = rows
          .slice(mark + 1)
          .filter(
            (r) =>
              r.author !== "app" &&
              r.id !== selfId &&
              !(r.joined_to !== null && r.read_at === null),
          )
          .map(toMessage)
          .filter((m) => m.status !== "failed")
          .map((message) => ({ message, turn: turnOf(message) }))
          .filter((x) => x.turn.content.trim() !== "")
        return { summary: line ? compactedOf(line)?.summary : undefined, rows: readable }
      }

      /** The turns that the model gets: one summary and the rows after it (spec 003, "Compact"). */
      const conversation = (workflowId: string, selfId: string) => {
        const { summary, rows } = readableRows(workflowId, selfId)
        const turns = rows.map((x) => x.turn)
        return summary === undefined
          ? turns
          : [{ role: "user" as const, content: summaryTurn(summary) }, ...turns]
      }

      /**
       * What a compact covers now: the earlier summary and the rows before the newest 2 turns. The
       * turn that starts now counts as one of the 2. Null when the conversation has 2 turns or fewer.
       */
      const compactRange = (workflowId: string, selfId?: string) => {
        const { summary, rows } = readableRows(workflowId, selfId)
        const cut = compactCut(
          rows.map((x) => (x.message.author === "assistant" ? "assistant" : "user")),
        )
        const first = cut === null ? undefined : rows[cut]
        if (cut === null || !first) return null
        return {
          summary,
          covered: rows.slice(0, cut).map((x) => x.message),
          firstKept: first.message,
        }
      }

      /** The text of a message for the summary: the words, the skill chip and the file names. */
      const compactText = (m: WorkflowChatMessage): string => {
        const out: string[] = []
        const skill = m.parts.find((p) => p.kind === "skill")
        if (skill?.kind === "skill") out.push(`(the user picked the skill "${skill.name}")`)
        const text = chatText(m)
        if (text) out.push(text)
        const files = chatFiles(m)
        if (files.length > 0) out.push(`(attached files: ${files.map((f) => f.name).join(", ")})`)
        return out.join("\n")
      }

      /** The size of the context of the model, or null when the provider does not tell it. */
      const contextSize = (model: AnswerModel) =>
        Effect.gen(function* () {
          const key = `${model.accountId}|${model.model}`
          // A program lists its models by a look at the program: the meter does not ask for it.
          if (providers.isRuntime(model.accountId)) return sizes.get(key) ?? null
          const listed = yield* providers
            .models(model.accountId)
            .pipe(Effect.orElseSucceed((): readonly ModelInfo[] | undefined => undefined))
          if (listed === undefined) return sizes.get(key) ?? null
          const size = listed.find((m) => m.id === model.model)?.contextWindow ?? null
          sizes.set(key, size)
          return size
        })

      /** The time at which the last compact ended, or 0. */
      const lastCompactAt = (rows: readonly MessageRow[]): number => {
        const mark = rows.findLastIndex((r) => compactedOf(r) !== undefined)
        const line = mark >= 0 ? rows[mark] : undefined
        return line ? (compactedOf(line)?.at ?? 0) : 0
      }

      /**
       * The use of the context that the last reply after the last compact reported (spec 003). Null
       * after a compact until the next reply, and when no reply reported it.
       */
      const contextUse = (workflowId: string): number | null => {
        const rows = visibleRows(workflowId)
        const at = lastCompactAt(rows)
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i]
          if (r?.author !== "assistant" || r.finished_at === null || r.finished_at < at) continue
          if (r.context_tokens !== null && r.context_tokens > 0) return r.context_tokens
        }
        return null
      }

      /** When the last reply of the chat ended. A compact is not a reply. Null when none ended. */
      const lastReplyAt = (workflowId: string): number | null => {
        let latest: number | null = null
        for (const r of visibleRows(workflowId))
          if (r.author === "assistant" && r.finished_at !== null)
            latest = Math.max(latest ?? 0, r.finished_at)
        return latest
      }

      /**
       * Turns that must still end before the next automatic compact (spec 003). The count starts
       * after a reply that carries the line of a failed compact, and after the first reply after a
       * compact whose use is due for a compact again. It is read from the rows, so it stays after a
       * restart. The turn in which a compact failed is not one of the turns.
       */
      const pauseOf = (workflowId: string, size: number | null): number => {
        const rows = visibleRows(workflowId)
        const endedAfter = (index: number) =>
          rows.slice(index + 1).filter((r) => r.author === "assistant" && r.status !== "streaming")
            .length
        let left = 0
        const failed = rows.findLastIndex(
          (r) =>
            r.author === "assistant" &&
            (JSON.parse(r.parts) as ChatPart[]).some(
              (p) => p.kind === "note" && p.note === "compact_failed",
            ),
        )
        if (failed >= 0) left = Math.max(left, pauseLeft(endedAfter(failed)))
        const mark = rows.findLastIndex((r) => compactedOf(r) !== undefined)
        const line = mark >= 0 ? rows[mark] : undefined
        if (line) {
          const at = compactedOf(line)?.at ?? 0
          const first = rows.findIndex(
            (r, i) =>
              i > mark &&
              r.author === "assistant" &&
              r.finished_at !== null &&
              r.finished_at >= at &&
              r.context_tokens !== null,
          )
          const reply = rows[first]
          if (reply && compactDue(reply.context_tokens, size))
            left = Math.max(left, pauseLeft(endedAfter(first)))
        }
        return left
      }

      /**
       * True while the chat is busy: a turn works, a compact works, a card of the turn waits for the
       * user, or a message waits (spec 003, "Compact"). A card of a node in a run does not count: the
       * run goes on while the chat compacts.
       */
      const chatBusy = (workflowId: string) =>
        working.has(workflowId) ||
        manualCompacts.has(workflowId) ||
        autoCompacting.has(workflowId) ||
        cards.open(workflowId).some((c) => c.scope === "turn") ||
        queueOf(workflowId).length > 0 ||
        db.get(
          "SELECT 1 AS n FROM chat_message WHERE workflow_id = ? AND joined_to IS NOT NULL AND read_at IS NULL LIMIT 1",
          workflowId,
        ) !== undefined

      /** Why Compact is off now, or null (spec 003, "Context meter" and "Compact"). */
      const compactOff = (
        workflowId: string,
        model: AnswerModel | null,
        size: number | null,
      ): CompactOff | null => {
        if (!model || !providers.isConnected(model.accountId)) return "not_connected"
        // A vendor program keeps its own context. The app cannot change what it keeps.
        if (providers.isRuntime(model.accountId)) return "self_compacts"
        if (size === null) return "size_unknown"
        if (chatBusy(workflowId)) return "working"
        if (compactRange(workflowId) === null) return "too_short"
        return null
      }

      const meterOf = (workflowId: string, model: AnswerModel | null) =>
        Effect.gen(function* () {
          const size = model ? yield* contextSize(model) : null
          const running = manualCompacts.has(workflowId) || autoCompacting.has(workflowId)
          // The ring is empty from the start of a compact until the next reply (spec 003).
          return {
            used: running ? null : contextUse(workflowId),
            size,
            off: compactOff(workflowId, model, size),
          } satisfies ChatMeter
        })

      /**
       * Asks the model that answers in the chat for the summary of the older part, and writes the
       * line "Compacted" before the first row that stays. The model, its account and its runtime are
       * the ones of the chat: the text never goes to another place (fail closed). A compact that is
       * stopped or fails changes nothing.
       */
      const runCompact = async (
        workflowId: string,
        model: AnswerModel,
        auto: boolean,
        signal: AbortSignal,
        selfId?: string,
      ): Promise<void> => {
        const range = compactRange(workflowId, selfId)
        if (!range) throw new AppError({ code: "compact_too_short" })
        // Only an account that the chat may use, and that is no vendor program, writes a summary.
        if (!usable(model.accountId) || providers.isRuntime(model.accountId))
          throw new AppError({ code: "compact_self_compacts" })
        const listed = await Effect.runPromise(
          providers
            .models(model.accountId)
            .pipe(Effect.orElseSucceed((): readonly ModelInfo[] => [])),
        )
        // The lowest effort that the model offers. The lists go from low to high.
        const effort = listed.find((m) => m.id === model.model)?.efforts[0] ?? null
        const transcript = compactTranscript(
          range.covered.map((m) => ({
            author: m.author === "assistant" ? ("assistant" as const) : ("user" as const),
            text: compactText(m),
          })),
          range.summary,
        )
        const controller = new AbortController()
        const stop = () => controller.abort()
        if (signal.aborted) stop()
        signal.addEventListener("abort", stop)
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, COMPACT_MS)
        let text = ""
        const usage = { input: 0, output: 0 }
        try {
          const events = await Effect.runPromise(
            providers.events(
              model.accountId,
              {
                model: model.model,
                effort,
                system: compactSystem(),
                turns: [{ role: "user", content: transcript }],
                signal: controller.signal,
                workspace: chatDir(),
                permission: "read_only",
                useTools: false,
              },
              { execute: async () => ({ output: "", failed: true }), approve: async () => false },
            ),
          )
          for await (const event of events) {
            if (event.type === "text") text += event.text
            else if (event.type === "usage") {
              usage.input = event.input ?? usage.input
              usage.output = event.output ?? usage.output
            }
          }
        } catch (error) {
          if (timedOut) throw new AppError({ code: "compact_timeout" })
          if (signal.aborted) throw error
          throw error instanceof AppError ? error : toAppError(error)
        } finally {
          clearTimeout(timer)
          signal.removeEventListener("abort", stop)
        }
        if (signal.aborted) throw new AppError({ code: "compact_stopped" })
        // Secrets are hidden after the model wrote the summary too: it is sent again in each turn.
        const summary = redactSecrets(text.trim())
        if (summary === "") throw new AppError({ code: "compact_empty" })
        // The summary holds what the covered rows held, so it carries their marks (spec 007). The
        // marks of the chat are not changed here: a compact keeps them.
        // `at` is later than the end of every reply that exists now, so a reply that ends at `at`
        // or later is a reply after the compact, also when it ends in the same millisecond.
        const endedBefore = visibleRows(workflowId).reduce(
          (latest, r) => Math.max(latest, r.finished_at ?? 0),
          0,
        )
        const part: ChatPart = {
          kind: "compacted",
          summary,
          at: Math.max(Date.now(), endedBefore + 1),
          auto,
          from: range.firstKept.id,
          marks: readMarks(workflowId),
        }
        // The tokens of the summary add to the usage of the day (spec 003, 006).
        db.run(
          `INSERT INTO chat_message (id, workflow_id, author, parts, status, model, created_at, finished_at, input_tokens, output_tokens)
           VALUES (?, ?, 'app', ?, 'done', ?, ?, ?, ?, ?)`,
          randomUUID(),
          workflowId,
          JSON.stringify([part]),
          model.model,
          range.firstKept.createdAt - 1,
          part.at,
          usage.input,
          usage.output,
        )
        emitState(workflowId)
      }

      /**
       * Before a turn (spec 003, "Automatic compact"): at 85 percent or more of the context, or at
       * 400000 tokens or more, the app compacts first. Anthropic keeps the start of a request for 1
       * hour, so a turn that keeps it also compacts when the last reply ended 1 hour ago or more. A
       * failure does not stop the turn: a muted line gives the reason and the pause of 5 turns
       * starts. Stop ends the turn as stopped.
       */
      const autoCompact = async (
        workflowId: string,
        w: Working,
        model: AnswerModel,
        parts: ChatPart[],
        touch: () => void,
        resumed: boolean,
      ): Promise<void> => {
        const setting = (await Effect.runPromise(settings.get)).autoCompact
        // A vendor program keeps its own context, and the chat cannot ask it for a summary.
        if (!setting || providers.isRuntime(model.accountId)) return
        const size = await Effect.runPromise(contextSize(model))
        const pause = pauseOf(workflowId, size)
        const account = (await Effect.runPromise(providers.accounts)).find(
          (a) => a.id === model.accountId,
        )
        const cold =
          account?.kind === "anthropic" &&
          !resumed &&
          hourCacheEnded({ setting, pause, lastReplyAt: lastReplyAt(workflowId), now: Date.now() })
        const due = shouldAutoCompact({
          setting,
          selfCompacts: false,
          used: contextUse(workflowId),
          size,
          pause,
        })
        // A conversation of 2 turns or fewer has nothing to compact. That is no failure.
        if ((!cold && !due) || compactRange(workflowId, w.assistantId) === null) return
        autoCompacting.add(workflowId)
        emitState(workflowId)
        try {
          await runCompact(workflowId, model, true, w.controller.signal, w.assistantId)
        } catch (error) {
          // A compact that the user stopped starts the same pause as a failed one: the next turn
          // sends the old conversation (spec 003, acceptance). The turn ends as stopped.
          const stopped = w.controller.signal.aborted
          parts.push({
            kind: "note",
            note: "compact_failed",
            code: stopped
              ? "compact_stopped"
              : error instanceof AppError
                ? error.code
                : toAppError(error).code,
          })
          touch()
          if (stopped) throw error
        } finally {
          autoCompacting.delete(workflowId)
          emitState(workflowId)
        }
      }

      /** The user runs Compact (spec 003). No turn runs: messages wait in the queue. */
      const compact = (workflowId: string) =>
        Effect.gen(function* () {
          yield* findWorkflow(workflowId)
          const model = yield* resolveModel(workflowId)
          const off = compactOff(workflowId, model, model ? yield* contextSize(model) : null)
          if (off || !model)
            return yield* new AppError({ code: `compact_${off ?? "not_connected"}` })
          const job = { controller: new AbortController(), since: Date.now() }
          manualCompacts.set(workflowId, job)
          emitState(workflowId)
          const exit = yield* Effect.promise(() =>
            runCompact(workflowId, model, false, job.controller.signal).then(
              () => null,
              (error: unknown) => error,
            ),
          )
          manualCompacts.delete(workflowId)
          emitState(workflowId)
          // The queue sends its first message as after a turn, also after a stop or a failure.
          afterTurn(workflowId)
          // A compact that the user stopped changes nothing and gives no error.
          if (exit === null || job.controller.signal.aborted) return
          return yield* exit instanceof AppError ? exit : toAppError(exit)
        })

      const history = (workflowId: string) =>
        Effect.gen(function* () {
          const workflow = yield* findWorkflow(workflowId)
          const messages = visibleRows(workflowId).map(toMessage)
          const w = working.get(workflowId)
          const job = manualCompacts.get(workflowId)
          // The model is read once for the whole call. A read does not write to the database.
          const { model, skipped } = yield* resolveChoice(workflowId).pipe(
            Effect.orElseSucceed(() => ({ model: null, skipped: null as string | null })),
          )
          return {
            workflowId,
            workflowName: workflow.name,
            messages,
            queue: queueOf(workflowId),
            working: w !== undefined || job !== undefined,
            workingSince: w?.since ?? job?.since ?? null,
            notice: w || job ? null : noticeOf(messages),
            block: model ? null : "no_provider",
            answer: yield* answerOf(model),
            unsafeAccount: skipped,
            cards: cards.list(workflowId),
            marks: readMarks(workflowId),
            meter: yield* meterOf(workflowId, model),
            compacting: job !== undefined || autoCompacting.has(workflowId),
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
          if (r?.author !== "user") break
          words.push(chatText(toMessage(r)))
        }
        for (const r of rows.slice(at === -1 ? rows.length : at + 1))
          if (r.author === "user" && r.joined_to === w.assistantId)
            words.push(chatText(toMessage(r)))
        return words.filter((t) => t.trim() !== "")
      }

      /** The messages of the turn that works: its reply and the messages of the user that it answers. */
      const currentTurnIds = (workflowId: string, w: Working): ReadonlySet<string> => {
        const rows = visibleRows(workflowId)
        const at = rows.findIndex((r) => r.id === w.assistantId)
        const ids = new Set<string>([w.assistantId])
        for (let i = (at === -1 ? rows.length : at) - 1; i >= 0; i--) {
          const r = rows[i]
          if (!r || r.author === "assistant") break
          ids.add(r.id)
        }
        for (const r of rows) if (r.joined_to === w.assistantId) ids.add(r.id)
        return ids
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
        const logStep = (
          decidedBy: "level" | "user",
          result: "ran" | "refused" | "stopped",
          device: string | null = null,
        ) =>
          actionLog.add({
            workflowId,
            kind: "feedback",
            target: text,
            decidedBy,
            result,
            taskId: null,
            outside: marks.outside,
            sensitive: marks.sensitive,
            ...(device ? { device } : {}),
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
            logStep("user", "refused", reply.device ?? null)
            return {
              output:
                "Not added: the user refused the feedback. Tell the user that the feedback was not added.",
              failed: false,
            }
          }
          logStep("user", "ran", reply.device ?? null)
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

      // --- self-improvement and memory in the chat (spec 002, 007, 008) -----------------------

      /** The tools that a turn of the chat has (spec 002, 007, 008). */
      const chatToolSet = (workflowId: string, workflow: { selfImprovement: boolean }) => {
        const memoryOn = memory.settings(workflowId)?.enabled === true
        const may = { propose: workflow.selfImprovement, memory: memoryOn }
        return {
          may,
          defs: [
            FEEDBACK_TOOL,
            ...ASSISTANT_TOOL_DEFS,
            ...(may.propose ? PROPOSE_TOOL_DEFS : []),
            ...(memoryOn ? [...MEMORY_TOOL_DEFS, ...CHAT_SEARCH_TOOL_DEFS] : []),
          ],
        }
      }

      /** A note after a proposal, a save or a refusal for "20 wait": one muted line of the turn. */
      const pushNote = (parts: ChatPart[], part: ChatPart) => {
        const last = parts.at(-1)
        if (
          part.kind === "note" &&
          part.note === "proposals_full" &&
          last?.kind === "note" &&
          last.note === "proposals_full"
        )
          return
        parts.push(part)
      }

      /**
       * A tool of the chat that proposes a change, keeps a fact, or reads the past (spec 002, 007,
       * 008). The guarded steps ask the user first in a turn that holds outside content. No tool
       * here changes the document, a prompt or the graph: a change is a proposal that waits.
       */
      const improveTool = async (
        workflowId: string,
        w: Working,
        level: PermissionLevel,
        call: ToolCall,
        parts: ChatPart[],
        touch: () => void,
      ): Promise<ToolOutcome> => {
        const marks = readMarks(workflowId)
        const source = { kind: "chat" as const, id: w.assistantId }
        const ask = (step: "memory" | "change") => (summary: string) =>
          cards.ask({
            workflowId,
            runId: null,
            taskId: null,
            nodeNumber: null,
            nodeName: null,
            kind: "approval",
            summary,
            step,
            once: true,
            outside: marks.outside,
            scope: "turn",
            sensitive: marks.sensitive,
            signal: w.controller.signal,
          })
        if (isMemoryTool(call.name)) {
          const result = await memoryTool.execute(
            {
              workflowId,
              taskId: null,
              level,
              outside: marks.outside,
              program: marks.program,
              source,
              mayPress: true,
              signal: w.controller.signal,
              ask: ask("memory"),
            },
            call,
          )
          const event = result.event
          if (event?.kind === "saved")
            pushNote(parts, {
              kind: "note",
              note: "memory_saved",
              text: event.text,
              historyId: event.historyId,
            })
          else if (event?.kind === "suggested")
            pushNote(parts, {
              kind: "note",
              note: "proposal",
              proposalId: event.proposalId,
              proposalKind: "memory",
              nodeNumber: null,
            })
          else if (event?.kind === "full") pushNote(parts, { kind: "note", note: "proposals_full" })
          touch()
          return result.outcome
        }
        if (isProposeTool(call.name)) {
          const result = await proposeTools.execute(
            {
              workflowId,
              source,
              level,
              outside: marks.outside,
              program: marks.program,
              ask: ask("change"),
            },
            call,
          )
          if (result.guarded)
            actionLog.add({
              workflowId,
              kind: "change",
              target: result.guarded.target,
              decidedBy: result.guarded.decidedBy,
              result: result.guarded.result,
              taskId: null,
              outside: marks.outside,
              sensitive: marks.sensitive,
              ...(result.guarded.device ? { device: result.guarded.device } : {}),
            })
          const event = result.event
          if (event?.kind === "made")
            pushNote(parts, {
              kind: "note",
              note: "proposal",
              proposalId: event.proposalId,
              proposalKind: event.proposalKind,
              nodeNumber: event.nodeNumber,
            })
          else if (event?.kind === "full") pushNote(parts, { kind: "note", note: "proposals_full" })
          touch()
          return result.outcome
        }
        if (isChatSearchTool(call.name)) {
          if (memory.settings(workflowId)?.enabled !== true)
            return {
              output: "Memory is off for this workflow. This tool is not available.",
              failed: true,
            }
          const result = chatSearch.execute(workflowId, call, currentTurnIds(workflowId, w))
          // A message from Teams in the result is outside content: this turn holds it from now on
          // (spec 007, "Outside content").
          if (result.outside && marks.outside === null)
            writeMarks(workflowId, {
              ...marks,
              outside: result.outside,
              program: marks.program || carriesProgramMark(result.outside),
            })
          return { output: result.output, failed: false }
        }
        return { output: `Unknown tool: ${call.name}`, failed: true }
      }

      /**
       * The linked devices whose messages the turn answers, oldest first (spec 012). These are the
       * messages of the user since the last reply that ended well, and the messages that joined the
       * turn, read or not. A reply that failed or stopped does not close the list, so a retry, a
       * resume and a "continue" answer the same senders. A message of the window of this computer
       * has no device.
       */
      const turnSenders = (workflowId: string, w: Working): { id: string; name: string }[] => {
        const rows = visibleRows(workflowId)
        const at = rows.findIndex((r) => r.id === w.assistantId)
        const tail: MessageRow[] = []
        for (let i = (at === -1 ? rows.length : at) - 1; i >= 0; i--) {
          const r = rows[i]
          if (!r) break
          if (r.author === "assistant" && r.status === "done") break
          tail.unshift(r)
        }
        const consumed = [...tail, ...rows.filter((r) => r.joined_to === w.assistantId)]
        const senders = new Map<string, string>()
        for (const r of consumed) {
          if (r.author !== "user" || r.actor_id === null) continue
          // The latest message of a device puts the device last.
          senders.delete(r.actor_id)
          senders.set(r.actor_id, r.actor_name ?? r.actor_id)
        }
        return [...senders].map(([id, name]) => ({ id, name }))
      }

      /**
       * For whom the turn acts now (spec 012, "No switch"). The switch of each linked device that
       * sent a message of the turn is read here, at the call, so a switch that was turned off in
       * the turn applies at once. When the senders are several, the weakest one decides: one
       * device without the switch takes it from the whole turn. A device that is not linked any
       * more has no switch.
       */
      const turnActor = (workflowId: string, w: Working): TurnActor => {
        const senders = turnSenders(workflowId, w)
        const device = senders.at(-1)?.name ?? null
        if (senders.every((s) => devices.canChange(s.id))) return { mayChange: true, device }
        return { mayChange: false, device, server: devices.deviceName() }
      }

      /**
       * A tool of the chat that reads or changes the workflow, or starts, stops and reads a run
       * (spec 010, "Assistant"; spec 007). A change and the start of a run in a turn that holds
       * outside content ask the user first. A result that holds outside content marks the turn.
       */
      const assistantTool = async (
        workflowId: string,
        w: Working,
        turn: AssistantTurn,
        call: ToolCall,
        parts: ChatPart[],
        touch: () => void,
      ): Promise<ToolOutcome> => {
        const marks = readMarks(workflowId)
        const locale = resolveLocale(
          (await Effect.runPromise(settings.get)).language,
          platform.systemLocale(),
        )
        // The level is read at the call, so a level that the user changed in the turn applies. A
        // workflow that cannot be read counts as "Read only" (fail closed).
        const level =
          db.get<{ permission: PermissionLevel }>(
            "SELECT permission FROM workflow WHERE id = ?",
            workflowId,
          )?.permission ?? "read_only"
        const result = await assistant.execute(
          {
            workflowId,
            level,
            outside: marks.outside,
            program: marks.program,
            turn,
            actor: () => turnActor(workflowId, w),
            t: (key, params) => translate(locale, key, params),
            ask: (step, summary) =>
              cards.ask({
                workflowId,
                runId: null,
                taskId: null,
                nodeNumber: null,
                nodeName: null,
                kind: "approval",
                summary,
                step,
                once: true,
                outside: marks.outside,
                scope: "turn",
                sensitive: marks.sensitive,
                signal: w.controller.signal,
              }),
          },
          call,
        )
        if (result.guarded)
          actionLog.add({
            workflowId,
            kind: result.guarded.kind,
            target: result.guarded.target,
            decidedBy: result.guarded.decidedBy,
            result: result.guarded.result,
            taskId: null,
            outside: marks.outside,
            sensitive: marks.sensitive,
            ...(result.guarded.device ? { device: result.guarded.device } : {}),
          })
        // A change that a device without the switch asked for: the chat says so (spec 012).
        if (result.notAllowed && !parts.some((p) => p.kind === "note" && p.note === "not_allowed"))
          parts.push({ kind: "note", note: "not_allowed", server: result.notAllowed.server })
        // The result of a node that held outside content makes this turn hold it (spec 007).
        if (result.outside && marks.outside === null && result.outside.source !== null)
          writeMarks(workflowId, {
            ...marks,
            outside: result.outside.source,
            program: marks.program || result.outside.program,
          })
        else if (result.outside?.program && !marks.program)
          writeMarks(workflowId, { ...marks, program: true })
        touch()
        return result.outcome
      }

      const runTurn = async (
        workflowId: string,
        w: Working,
        model: AnswerModel,
        resumed: boolean,
      ): Promise<void> => {
        const parts: ChatPart[] = []
        let timer: ReturnType<typeof setTimeout> | null = null
        let tokensIn = 0
        let tokensOut = 0
        // The use of the context after the reply: what the last request read, and what it wrote.
        let contextIn = 0
        let contextOut = 0
        const contextNow = () => (contextIn + contextOut > 0 ? contextIn + contextOut : null)
        const save = () => {
          timer = null
          db.run(
            "UPDATE chat_message SET parts = ?, input_tokens = ?, output_tokens = ?, context_tokens = ? WHERE id = ?",
            JSON.stringify(parts),
            tokensIn,
            tokensOut,
            contextNow(),
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
          // A long conversation is compacted first, then the turn goes on (spec 003).
          await autoCompact(workflowId, w, model, parts, touch, resumed)
          // The run facts are read after the compact, and fresh in each turn: a summary never
          // stands in for them (spec 003).
          const runs = await Effect.runPromise(facts.runs(workflowId))
          // The results in the prompt are outside content: the chat takes their marks (spec 007).
          markFromRuns(workflowId, runs)
          const turns = conversation(workflowId, w.assistantId)
          const toolSet = chatToolSet(workflowId, workflow)
          // Only a turn that the user started in the chat has the tools (spec 007, "Who may use them").
          const turnState = newAssistantTurn("user", workflow.graph)
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
                  ...(withTools
                    ? { graph: workflow.graph, may: toolSet.may, assistant: true }
                    : {}),
                }),
                turns,
                signal: w.controller.signal,
                workspace: withTools ? workflow.folder : chatDir(),
                permission: withTools ? workflow.permission : "read_only",
                ...(withTools ? { tools: toolSet.defs } : {}),
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
                  if (isAssistantTool(call.name))
                    return assistantTool(workflowId, w, turnState, call, parts, touch)
                  return improveTool(workflowId, w, workflow.permission, call, parts, touch)
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
                ...(event.state !== "running" && event.notRun ? { notRun: true } : {}),
              }
              if (index >= 0) parts[index] = part
              else parts.push(part)
              touch()
            } else if (event.type === "usage") {
              // The counts of a request are running totals. A new request starts again.
              if (event.input !== undefined) {
                contextIn = event.input
                contextOut = event.output ?? 0
              } else if (event.output !== undefined) contextOut = event.output
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
          `UPDATE chat_message SET parts = ?, input_tokens = ?, output_tokens = ?, context_tokens = ?,
             status = ?, error_code = ?, error_detail = ?, finished_at = ? WHERE id = ?`,
          JSON.stringify(parts),
          tokensIn,
          tokensOut,
          contextNow(),
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

      // --- the work after a run (spec 002, "Self-improvement") --------------------------------

      const programBlock = (workflowId: string) =>
        resolveModel(workflowId).pipe(
          Effect.flatMap((model) =>
            model && providers.isRuntime(model.accountId)
              ? providers.accounts.pipe(
                  Effect.map((list) => list.find((a) => a.id === model.accountId)?.name ?? ""),
                )
              : Effect.succeed(null),
          ),
          Effect.orElseSucceed(() => null),
        )

      const REFLECT_MS = 5 * 60_000

      const reflectNow = async (workflowId: string, runId: string): Promise<void> => {
        const flags = memory.settings(workflowId)
        if (!flags || (!flags.selfImprovement && !flags.enabled)) return
        if (proposals.waiting(workflowId) >= PROPOSAL_WAIT_MAX) return
        const workflow = await Effect.runPromise(findWorkflow(workflowId))
        const all = await Effect.runPromise(facts.runs(workflowId))
        const run = all.find((r) => r.id === runId)
        if (!run || run.active || run.state === "cancelled") return
        const model = await Effect.runPromise(resolveModel(workflowId))
        if (!model || !usable(model.accountId) || !chatHasTools(model.accountId)) return
        // The turn holds what the run held: a proposal after it carries the outside mark (spec 002).
        let outside: OutsideSource | null = null
        let program = false
        for (const n of run.nodes) {
          if (n.result === null || n.result === "") continue
          outside ??= n.outside
          program ||= n.program
        }
        const source = { kind: "run" as const, id: runId }
        // The limits of spec 002 ("Limits"): one proposal of the kinds that change the workflow for
        // each run, and 3 in 24 hours. When one stops it, the request does not offer those tools.
        // Spec 002 and 008 state no daily limit for memory items, so none is made up here.
        const may = {
          propose:
            flags.selfImprovement && proposals.workflowChangeLimit(workflowId, source) === null,
          memory: flags.enabled,
        }
        if (!may.propose && !may.memory) {
          return
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REFLECT_MS)
        const defs = [
          ...(may.propose ? PROPOSE_TOOL_DEFS : []),
          ...(may.memory ? MEMORY_TOOL_DEFS : []),
        ]
        try {
          const events = await Effect.runPromise(
            providers.events(
              model.accountId,
              {
                model: model.model,
                effort: model.effort,
                system: chatSystem({
                  name: workflow.name,
                  document: workflow.document,
                  runs: all,
                  feedback: false,
                  graph: workflow.graph,
                  may,
                }),
                turns: [{ role: "user", content: reflectText(runId, may) }],
                signal: controller.signal,
                workspace: chatDir(),
                permission: "read_only",
                tools: defs,
                useTools: true,
                cache: "short",
              },
              {
                execute: async (call) => {
                  if (isMemoryTool(call.name))
                    return (
                      await memoryTool.execute(
                        {
                          workflowId,
                          taskId: null,
                          level: workflow.permission,
                          outside,
                          program,
                          source,
                          mayPress: false,
                          signal: controller.signal,
                          ask: () => Promise.reject(new Error("no user")),
                        },
                        call,
                      )
                    ).outcome
                  if (isProposeTool(call.name))
                    return (
                      await proposeTools.execute(
                        { workflowId, source, level: workflow.permission, outside, program },
                        call,
                      )
                    ).outcome
                  return { output: `Unknown tool: ${call.name}`, failed: true }
                },
                approve: async () => false,
              },
            ),
          )
          // The turn posts no message: its only results are proposals.
          for await (const event of events) void event
        } catch (error) {
          // A turn that fails leaves no trace in the chat: the next run looks again. It leaves one
          // line in the log of workflows, with the kind of the fault and no text of it (no secret).
          appendLog(platform.dataDir, "workflows", {
            event: "reflection_failed",
            workflowId,
            runId,
            error: error instanceof Error ? error.name : "unknown",
            code: (error as { code?: unknown } | null)?.code ?? null,
          })
        } finally {
          clearTimeout(timer)
        }
      }

      const reflect = (workflowId: string, runId: string) =>
        Effect.promise(() => reflectNow(workflowId, runId).catch(() => {}))

      runs.onEnded((workflowId, runId) => {
        void Effect.runPromise(reflect(workflowId, runId))
      })

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
      const startTurn = (
        workflowId: string,
        known?: AnswerModel,
        /** True for a turn that goes on after a restart: the 1 hour cache rule does not compact it. */
        resumed = false,
      ): Effect.Effect<void, AppError> =>
        Effect.gen(function* () {
          if (working.has(workflowId) || manualCompacts.has(workflowId)) return
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
          void runTurn(workflowId, w, model, resumed)
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
          // The device that sends the message (spec 012). It stays on the message, so the turn that
          // answers it knows for whom it acts at each tool call.
          const actor = yield* CurrentActor
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
                actor,
              })
              emitMessage(id)
              cards.answerInChat(input.workflowId, text)
              emitState(input.workflowId)
              return toMessage(row(id) as MessageRow)
            }
          }
          const w = working.get(input.workflowId)
          // A compact that the user started holds the chat: a message waits in the queue, whatever
          // the setting says. During an automatic compact a message joins the turn (spec 003).
          const compactHeld = manualCompacts.has(input.workflowId)
          const mode = compactHeld ? "queue" : (yield* settings.get).duringTurn
          if ((w || compactHeld) && mode === "queue") {
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
          const queued = (w !== undefined || compactHeld) && mode === "queue"
          insert({
            id,
            workflowId: input.workflowId,
            author: "user",
            parts,
            status: queued ? "queued" : "done",
            replyTo: input.replyTo ?? null,
            joinedTo: w && !queued ? w.assistantId : null,
            actor,
          })
          emitMessage(id)
          emitState(input.workflowId)
          if (w && !queued) for (const ready of w.ready) ready()
          if (!w && !compactHeld) yield* startTurn(input.workflowId, model)
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
          // The queue sends its first message when the compact ends (spec 003).
          if (manualCompacts.has(r.workflow_id))
            return yield* new AppError({ code: "chat_compacting" })
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
          if (working.has(workflowId) || manualCompacts.has(workflowId)) return
          const last = visibleRows(workflowId).at(-1)
          if (last?.author !== "assistant" || last.status !== "failed")
            return yield* new AppError({ code: "message_read" })
          db.run("DELETE FROM chat_message WHERE id = ?", last.id)
          emitState(workflowId)
          yield* startTurn(workflowId)
        })

      const resume = (workflowId: string, mode: "continue" | "again") =>
        Effect.gen(function* () {
          if (working.has(workflowId) || manualCompacts.has(workflowId)) return
          const notice = noticeOf(visibleRows(workflowId).map(toMessage))
          if (!notice) return yield* new AppError({ code: "message_read" })
          if (mode === "again" || notice.notSent) {
            // The request had not reached the model: the same text goes again (spec 003).
            if (mode === "again" && !notice.notSent)
              return yield* new AppError({ code: "message_read" })
            db.run("DELETE FROM chat_message WHERE id = ?", notice.messageId)
            emitState(workflowId)
            // A turn that goes on after a restart does not compact by the 1 hour cache rule.
            yield* startTurn(workflowId, undefined, true)
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
        programBlock,
        reflect,
        send,
        setModel,
        compact,
        stop: (workflowId) =>
          Effect.sync(() => {
            working.get(workflowId)?.controller.abort()
            manualCompacts.get(workflowId)?.controller.abort()
          }),
        deleteWaiting,
        sendNow,
        retry,
        resume,
      })
    }),
  )
}
