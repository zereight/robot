import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  type AgentModel,
  ATTACH_BYTES,
  ATTACH_MAX,
  askAllowsAlways,
  askKind,
  askStep,
  askSummary,
  type ChatHistory,
  type ChatMessage,
  type ChatSend,
  type CutNotice,
  type FilePart,
  hasVisibleReply,
  holdOutside,
  isNoteOnly,
  isTaskProgress,
  type MessagePart,
  type MessageStatus,
  type ModelInfo,
  messageFiles,
  messageSkill,
  messageText,
  newTurnMark,
  type OutsideSource,
  outsideOfCall,
  outsideOfParts,
  type PermissionLevel,
  QUEUE_MAX,
  type QueuedMessage,
  type QueueHold,
  runningStepKind,
  runtimeTakesInput,
  type SkillPart,
  type StepEffort,
  skillLead,
  starterOf,
  stepTurnEffort,
  type Task,
  type TaskProgress,
  type TaskSource,
  type ToolAsk,
  type TurnStarter,
  toolNameOf,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Fiber, FiberMap, Layer, Stream } from "effect"
import type { AgentEvent } from "../providers/agent.ts"
import type { Turn } from "../providers/chat.ts"
import { offeredEfforts, ProviderFailure } from "../providers/client.ts"
import { resumeOf } from "../providers/resume.ts"
import type { JoinedMessage, TurnInbox } from "../providers/turn.ts"
import { bridgeToolName } from "../runtimes/bridge.ts"
import { Activity } from "./Activity.ts"
import { type Actor, CurrentActor } from "./actor.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Knowledge } from "./Knowledge.ts"
import { Memory } from "./Memory.ts"
import { Notifier } from "./Notifier.ts"
import { Providers } from "./Providers.ts"
import { SettingsStore } from "./Settings.ts"
import { Skills } from "./Skills.ts"
import { closing, turnWatch } from "./silence.ts"
import { Tasks } from "./Tasks.ts"
import type { ToolContext } from "./Tools.ts"
import { Tools } from "./Tools.ts"

interface MessageRow {
  id: string
  agent_id: string
  author: "user" | "agent"
  parts: string
  status: MessageStatus
  error_code: string | null
  error_detail: string | null
  error_resets_at: number | null
  reply_to: string | null
  model: string | null
  created_at: number
  edited_at: number | null
  from_device: string | null
  from_name: string | null
  /**
   * The notes that went to Claude Code with this message of the user: the memory items that
   * related to it then. They are kept so that the next turn sends the same text again.
   */
  context: string | null
  /** The reply of the turn that this message joined (spec 003). Null for other messages. */
  joined_to: string | null
  /** When the agent read the message that joined a turn. Null until then. */
  read_at: number | null
}

interface AgentModelRow {
  id: string
  server_id: string
  name: string
  instructions: string
  archived_at: number | null
  model_account_id: string | null
  model_name: string | null
  model_effort: string | null
  workspace: string
  permission: PermissionLevel
  memory_enabled: number
}

/** Where the task of a message comes from, when it is not the chat itself (a routine). */
export interface TaskOrigin {
  readonly source: TaskSource
  readonly sourceId: string
  /**
   * Who started the turn, when the source does not tell it: a message from another agent is
   * "agent". By default it comes from the source (spec 007, "Outside content").
   */
  readonly starter?: TurnStarter
  /**
   * The turn holds outside content from its start: a message from another agent, or the change
   * that starts a watch routine. This is its source.
   */
  readonly outside?: OutsideSource
  /** Called when the task of the message starts, with its id. */
  readonly onStart?: (taskId: string) => void
  /**
   * The effort that this one turn asks for (a step of a workflow). It counts only when the
   * model offers it. The agent keeps its own effort for every other turn.
   */
  readonly effort?: StepEffort
  /**
   * The model and effort of a routine with a model of its own (spec 009). The turn uses it in
   * place of the model of the agent. When its account is not connected, the send fails: the turn
   * never uses another model.
   */
  readonly model?: AgentModel
}

export interface ChatService {
  history(agentId: string): Effect.Effect<ChatHistory>
  /**
   * Sends at once when the agent is free. While it works, a message of the user joins the turn
   * (spec 003), or waits in the queue by the setting, by the program, or when it has an origin.
   */
  send(input: ChatSend, origin?: TaskOrigin): Effect.Effect<{ queued: boolean }, AppError>
  /** Sends a queued message into the turn that runs now. */
  sendNow(agentId: string, itemId: string): Effect.Effect<void, AppError>
  /** Deletes a message that joined the turn and that the agent did not read. */
  deleteUnread(agentId: string, messageId: string): Effect.Effect<void, AppError>
  stop(agentId: string): Effect.Effect<void>
  retry(agentId: string, messageId: string): Effect.Effect<void, AppError>
  edit(agentId: string, messageId: string, text: string): Effect.Effect<void, AppError>
  updateQueued(agentId: string, itemId: string, text: string): Effect.Effect<void, AppError>
  removeQueued(agentId: string, itemId: string): Effect.Effect<void>
  markRead(agentId: string): Effect.Effect<void>
  /** Tells the windows about a message that sync wrote, so an open chat shows it at once. */
  announce(messageId: string): void
  /** Posts one muted line of the agent, with no task: a watch saw no change (spec 009). */
  note(agentId: string, part: Extract<MessagePart, { kind: "note" }>): void
}

/** The turn that runs now for an agent, as far as messages of the user can join it (spec 003). */
interface LiveTurn {
  readonly replyId: string
  /** Messages that wait for the next step, oldest first. They can still be deleted. */
  readonly waiting: JoinedMessage[]
  /** Messages that a program has and did not begin to read. They cannot be deleted. */
  readonly handed: Set<string>
  readonly watchers: Set<() => void>
  /** The call of a question card that waits now, if any. */
  question(): string | undefined
  /** Marks the card of a question as answered by a message in the chat. */
  answeredInChat(callId: string): void
}

/** How often a streaming reply is sent to the window and written to disk. */
const EMIT_EVERY_MS = 50
const SAVE_EVERY_MS = 500
const QUOTE_MAX = 500
/** The line before the notes that the app adds to a message for Claude Code. */
const NOTES_LEAD = "Notes from the app for this message. The user did not write them:"

/** Copies the files into the `attachments` folder of a workspace. A name that is taken gets a number. */
export const copyAttachments = (workspace: string, paths: readonly string[]): FilePart[] => {
  if (paths.length > ATTACH_MAX) throw new AppError({ code: "too_many_files" })
  const sources = paths.map((path) => {
    let size = 0
    try {
      const info = statSync(path)
      if (!info.isFile()) throw new Error("not a file")
      size = info.size
    } catch {
      throw new AppError({ code: "file_unreadable", detail: basename(path) })
    }
    if (size > ATTACH_BYTES) throw new AppError({ code: "file_too_large", detail: basename(path) })
    return { path, size }
  })
  const dir = join(workspace, "attachments")
  mkdirSync(dir, { recursive: true })
  return sources.map(({ path, size }) => {
    const base = basename(path)
    const ext = extname(base)
    const stem = base.slice(0, base.length - ext.length)
    let name = base
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem} (${n})${ext}`
    copyFileSync(path, join(dir, name))
    return { kind: "file", name, path: `attachments/${name}`, size }
  })
}

const toMessage = (row: MessageRow, unread?: "waiting" | "handed"): ChatMessage => ({
  id: row.id,
  agentId: row.agent_id,
  author: row.author,
  parts: JSON.parse(row.parts) as MessagePart[],
  status: row.status,
  error: row.error_code
    ? { code: row.error_code, detail: row.error_detail ?? "", resetsAt: row.error_resets_at }
    : null,
  replyTo: row.reply_to,
  model: row.model,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  fromDevice: row.from_name,
  ...(unread ? { unread } : {}),
})

/** Adds a stream event to the parts. Returns true when a new part starts (a part boundary). */
export const applyEvent = (parts: MessagePart[], event: AgentEvent): boolean => {
  if (event.type === "usage") return false
  if (event.type === "joined") {
    // What the agent writes after a message of the user starts a new paragraph.
    const last = parts.at(-1)
    if (last?.kind === "text" && last.text && !last.text.endsWith("\n"))
      parts[parts.length - 1] = { kind: "text", text: `${last.text}\n\n` }
    return false
  }
  if (event.type === "tool") {
    const id = event.call.id
    const index = parts.findIndex((p) => p.kind === "tool" && p.id === id)
    const existing = parts[index]
    const base = {
      kind: "tool" as const,
      id,
      name: event.call.name,
      label: toolLabel(event.call.name, event.call.input),
      input: event.call.input,
    }
    const next: MessagePart = {
      ...base,
      state: event.state,
      output: event.state === "running" ? "" : event.output,
      ...(existing?.kind === "tool" && existing.memory ? { memory: existing.memory } : {}),
      // Who answered the approval stays on the card when the call ends (spec 012).
      ...(existing?.kind === "tool" && existing.decision ? { decision: existing.decision } : {}),
      ...(existing?.kind === "tool" && existing.knowledge ? { knowledge: existing.knowledge } : {}),
      ...(existing?.kind === "tool" && existing.answeredInChat ? { answeredInChat: true } : {}),
      ...(existing?.kind === "tool" && existing.secret ? { secret: existing.secret } : {}),
      ...(existing?.kind === "tool" && existing.settings ? { settings: existing.settings } : {}),
    }
    if (index >= 0) {
      parts[index] = next
      return false
    }
    parts.push(next)
    return true
  }
  const last = parts.at(-1)
  if (last && last.kind === event.type) {
    parts[parts.length - 1] = { kind: event.type, text: last.text + event.text }
    return false
  }
  parts.push({ kind: event.type, text: event.text })
  return true
}

/** True when two cards ask the same thing. The time of the ask does not count. */
const sameAsk = (a: ToolAsk, b: ToolAsk): boolean => {
  if (a.kind === "approval") return b.kind === "approval" && a.summary === b.summary
  if (a.kind === "article")
    return (
      b.kind === "article" && a.title === b.title && a.before === b.before && a.after === b.after
    )
  if (a.kind === "secret")
    return (
      b.kind === "secret" &&
      a.name === b.name &&
      a.origin === b.origin &&
      a.replace === b.replace &&
      JSON.stringify(a.auth) === JSON.stringify(b.auth)
    )
  if (a.kind !== "question") return false
  return (
    b.kind === "question" &&
    a.question === b.question &&
    a.choices.length === b.choices.length &&
    a.choices.every((c, i) => c === b.choices[i])
  )
}

/** A short line for a tool card, from the tool name and its arguments. */
export const toolLabel = (name: string, input: string) => {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(input || "{}") as Record<string, unknown>
  } catch {}
  // The card of a request with a saved secret shows the name, the method and the address.
  if (name === "secret_request" || name === "ask_secret" || name === "forget_secret") {
    const words = [
      typeof args.name === "string" ? `[${args.name}]` : "",
      typeof args.method === "string" ? args.method.toUpperCase() : "",
      typeof args.url === "string" ? args.url : typeof args.origin === "string" ? args.origin : "",
    ]
      .filter(Boolean)
      .join(" ")
    return words ? `${name}: ${words.replace(/\s+/g, " ").slice(0, 160)}` : name
  }
  const first = ["path", "file_path", "command", "url", "query", "pattern", "question", "text"]
    .map((k) => args[k])
    .find((v): v is string => typeof v === "string")
  return first ? `${name}: ${first.replace(/\s+/g, " ").slice(0, 80)}` : name
}

export class Chat extends Context.Service<Chat, ChatService>()("robot/main/Chat") {
  static readonly layer = Layer.effect(
    Chat,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const providers = yield* Providers
      const activity = yield* Activity
      const tasks = yield* Tasks
      const settings = yield* SettingsStore
      const tools = yield* Tools
      const memory = yield* Memory
      const knowledge = yield* Knowledge
      const notifier = yield* Notifier
      const skills = yield* Skills
      // Set when a task retry starts a turn, so the new task links to the old one.
      const retryLinks = new Map<string, string>()
      const workers = yield* FiberMap.make<string>()
      const queues = new Map<string, QueuedMessage[]>()
      /** Origins of user messages and queued items, by their ids. */
      const origins = new Map<string, TaskOrigin>()
      /** The linked device that sent a queued item, by the id of the item (spec 012). */
      const senders = new Map<string, Actor>()
      /** The running turn of each agent that messages can join (spec 003). */
      const live = new Map<string, LiveTurn>()
      /** Agents whose last turn ended with messages that the agent did not read. */
      const unreadLeft = new Set<string>()
      /**
       * When the user sent a message or a queued item, by its id. The times of the task that answers
       * it count from here (spec 005). A turn that no new message started has no entry.
       */
      const asks = new Map<string, number>()
      /** Writes a queued item as a message, and moves its origin to the message. */
      const insertQueued = (agentId: string, next: QueuedMessage) => {
        const sender = senders.get(next.id)
        senders.delete(next.id)
        const row = insertMessage(
          agentId,
          "user",
          next.text,
          next.replyTo,
          null,
          next.files,
          sender ?? null,
          null,
          next.skill ?? null,
        )
        const origin = origins.get(next.id)
        if (origin) {
          origins.delete(next.id)
          origins.set(row.id, origin)
        }
        const asked = asks.get(next.id)
        if (asked !== undefined) {
          asks.delete(next.id)
          asks.set(row.id, asked)
        }
      }

      // A task that waited for the user when the app closed waits on (spec 005). Its reply keeps
      // streaming, and its turn starts again at the end of this set-up.
      const reviving = tasks.waitingAfterRestart()
      // A reply that was streaming when the app closed keeps its parts and counts as stopped.
      // A reply that streams from the other computer (spec 019) is not ours to end.
      db.run(
        `UPDATE message SET status = 'stopped'
         WHERE status = 'streaming' AND origin IS NULL AND id NOT IN (SELECT value FROM json_each(?))`,
        JSON.stringify(reviving.flatMap((t) => (t.messageId ? [t.messageId] : []))),
      )

      // A message that joined a turn and was not read before the app closed is a plain message now.
      db.run("UPDATE message SET joined_to = NULL WHERE joined_to IS NOT NULL AND read_at IS NULL")

      const agentRow = (agentId: string) =>
        db.get<AgentModelRow>(
          "SELECT id, server_id, name, instructions, archived_at, model_account_id, model_name, model_effort, workspace, permission, memory_enabled FROM agent WHERE id = ?",
          agentId,
        )
      const messageRow = (id: string) =>
        db.get<MessageRow>("SELECT * FROM message WHERE id = ?", id)
      const rows = (agentId: string) =>
        db.all<MessageRow>(
          "SELECT * FROM message WHERE agent_id = ? ORDER BY created_at, rowid",
          agentId,
        )

      /**
       * How far the turn of each failed reply went, by the id of the reply (spec 005). A reply
       * that does not fail, or whose task is not known here, has none.
       */
      const progressOf = (ids: readonly string[]): Map<string, TaskProgress | null> => {
        if (ids.length === 0) return new Map()
        const found = db.all<{ message_id: string; progress: string | null }>(
          `SELECT message_id, progress FROM task
           WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`,
          JSON.stringify(ids),
        )
        return new Map(
          found.map((r) => [r.message_id, isTaskProgress(r.progress) ? r.progress : null]),
        )
      }
      /**
       * A message as the windows get it: a message of the running turn says if it is unread, and a
       * failed reply also tells how far its turn went.
       */
      const present = (row: MessageRow, known?: Map<string, TaskProgress | null>): ChatMessage => {
        const message =
          row.joined_to === null || row.read_at !== null
            ? toMessage(row)
            : toMessage(row, live.get(row.agent_id)?.handed.has(row.id) ? "handed" : "waiting")
        if (row.author !== "agent" || row.status !== "failed") return message
        const progress = (known ?? progressOf([row.id])).get(row.id)
        return progress ? { ...message, progress } : message
      }
      const presentAll = (list: readonly MessageRow[]): ChatMessage[] => {
        const known = progressOf(
          list.filter((r) => r.author === "agent" && r.status === "failed").map((r) => r.id),
        )
        return list.map((r) => present(r, known))
      }

      /** The task that ended with a restart and holds this reply (spec 003, "Rules"). */
      const cutTaskOf = (replyId: string) => {
        const found = db.get<{
          id: string
          state: string
          error_code: string | null
          progress: string | null
        }>(
          `SELECT id, state, error_code, progress FROM task
           WHERE message_id = ? AND source = 'chat' AND origin IS NULL
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          replyId,
        )
        return found?.state === "failed" && found.error_code === "app_stopped" ? found : undefined
      }
      /**
       * The request that a restart cut off, when the user has not written since: the last message
       * is the reply of a chat task that the restart ended.
       */
      const cutOf = (list: readonly MessageRow[]): CutNotice | null => {
        const last = list.at(-1)
        if (last?.author !== "agent" || last.status !== "stopped") return null
        const task = cutTaskOf(last.id)
        if (!task) return null
        // A task from before the app kept the progress may have reached the model.
        const progress = isTaskProgress(task.progress) ? task.progress : "sent"
        return { taskId: task.id, messageId: last.id, progress }
      }

      const placesChanged = (agentId: string) => {
        const agent = agentRow(agentId)
        if (agent) bus.emit("places.changed", { serverId: agent.server_id })
      }
      const emitMessage = (row: MessageRow) => bus.emit("chat.message", present(row))
      /**
       * The program of the agent that takes no input during a turn. Its messages wait in the queue
       * whatever the setting says (spec 003).
       */
      const holdOf = (agentId: string): QueueHold | null => {
        const account = agentRow(agentId)?.model_account_id
        const kind = account ? providers.runtimeKind(account) : null
        return kind && !runtimeTakesInput(kind) ? { runtime: kind } : null
      }
      const emitQueue = (agentId: string) =>
        bus.emit("chat.queue", {
          agentId,
          queue: queues.get(agentId) ?? [],
          hold: holdOf(agentId),
        })

      const insertMessage = (
        agentId: string,
        author: "user" | "agent",
        text: string,
        replyTo: string | null,
        model: string | null,
        files: readonly FilePart[] = [],
        from: Actor | null = null,
        joined: { readonly to: string; readonly readAt: number | null } | null = null,
        skill: SkillPart | null = null,
      ) => {
        const id = randomUUID()
        db.run(
          `INSERT INTO message (id, agent_id, author, parts, status, reply_to, model, created_at, from_device, from_name, joined_to, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          agentId,
          author,
          JSON.stringify(
            author === "user"
              ? [...(skill ? [skill] : []), ...(text ? [{ kind: "text", text }] : []), ...files]
              : [],
          ),
          author === "user" ? "done" : "streaming",
          replyTo,
          model,
          Date.now(),
          from?.id ?? null,
          from?.name ?? null,
          joined?.to ?? null,
          joined?.readAt ?? null,
        )
        const row = messageRow(id) as MessageRow
        emitMessage(row)
        placesChanged(agentId)
        return row
      }

      /** The text of a message for the model. A reply quotes what it answers. */
      const turnText = (r: MessageRow) => {
        const skill = messageSkill(toMessage(r))
        // The agent reads the instructions of a skill chip first, then the text (spec 017).
        const text = [
          skill ? skillLead(skill.name, skill.instructions) : "",
          messageText(toMessage(r)),
        ]
          .filter(Boolean)
          .join("\n\n")
        const quoted = r.reply_to ? messageRow(r.reply_to) : undefined
        const quote = quoted
          ? `${messageText(toMessage(quoted))
              .slice(0, QUOTE_MAX)
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n")}\n\n`
          : ""
        const files = messageFiles(toMessage(r))
          .map((f) => `[Attached file: ${f.path}]`)
          .join("\n")
        return quote + [text, files].filter(Boolean).join("\n\n")
      }

      /**
       * The conversation so far, as turns for the provider. With `notes`, a message of the user
       * brings the notes that it had when it was asked. A message that joined a turn and was read
       * there goes before the reply of that turn, because the reply answers it too.
       */
      const buildTurns = (agentId: string, exceptId: string, notes: boolean): Turn[] => {
        const kept = rows(agentId).filter(
          (r) =>
            r.id !== exceptId &&
            !(r.author === "agent" && r.status === "failed") &&
            !isNoteOnly(r.parts),
        )
        const replies = new Set(kept.filter((r) => r.author === "agent").map((r) => r.id))
        const joinedTo = (r: MessageRow) =>
          r.joined_to !== null && r.read_at !== null && replies.has(r.joined_to)
            ? r.joined_to
            : null
        const ordered: MessageRow[] = []
        for (const r of kept) {
          if (joinedTo(r)) continue
          if (r.author === "agent") ordered.push(...kept.filter((j) => joinedTo(j) === r.id))
          ordered.push(r)
        }
        return ordered.map((r) => ({
          role: r.author === "user" ? "user" : "assistant",
          content:
            turnText(r) +
            (notes && r.author === "user" && r.context ? `\n\n${NOTES_LEAD}\n${r.context}` : ""),
        }))
      }

      /** Answers the last message. `resumed` is a task that waited through a restart: it goes on. */
      const runTurn = Effect.fn("Chat.runTurn")(function* (agentId: string, resumed?: Task) {
        const own = agentRow(agentId)
        if (!own) return
        const kept = resumed?.messageId ? messageRow(resumed.messageId) : undefined
        const lastUser = rows(agentId)
          .filter((r) => r.author === "user")
          .at(-1)
        // A routine with a model of its own uses it for its turn (spec 009).
        const ownModel = lastUser && !resumed ? origins.get(lastUser.id)?.model : undefined
        const agent: AgentModelRow = ownModel
          ? {
              ...own,
              model_account_id: ownModel.accountId,
              model_name: ownModel.model,
              model_effort: ownModel.effort,
            }
          : own
        const reply = kept ?? insertMessage(agentId, "agent", "", null, agent.model_name)
        const asked = lastUser ? toMessage(lastUser) : undefined
        const turnEffort = lastUser ? origins.get(lastUser.id)?.effort : undefined
        const textOf = (m: ChatMessage) =>
          messageText(m) ||
          messageFiles(m)
            .map((f) => f.name)
            .join(", ")
        // Messages that a stopped turn did not read come after its reply. The new turn answers
        // all of them, as one request, in the order that the user sent them (spec 003).
        const all = rows(agentId)
        const lastReply = all.findLastIndex((r) => r.author === "agent" && r.id !== reply.id)
        const open = all
          .slice(lastReply + 1)
          .filter((r) => r.author === "user" && r.joined_to === null)
        const askedAt = lastUser ? asks.get(lastUser.id) : undefined
        if (lastUser) asks.delete(lastUser.id)
        const source = (lastUser ? origins.get(lastUser.id)?.source : undefined) ?? "chat"
        const prompt =
          (open.length > 1
            ? open.map((r) => textOf(toMessage(r))).join("\n\n")
            : asked
              ? textOf(asked)
              : "") || "(no text)"
        const task =
          resumed ??
          (yield* tasks.create({
            agentId,
            prompt,
            source,
            sourceId: (lastUser ? origins.get(lastUser.id)?.sourceId : undefined) ?? agentId,
            messageId: reply.id,
            retryOf: retryLinks.get(agentId) ?? null,
            // A routine or a workflow starts its task with no message of the user (spec 005).
            askedAt: source === "chat" && !retryLinks.has(agentId) ? (askedAt ?? null) : null,
          }))
        if (!resumed) {
          retryLinks.delete(agentId)
          if (lastUser) origins.get(lastUser.id)?.onStart?.(task.id)
        }
        const parts: MessagePart[] = kept ? (JSON.parse(kept.parts) as MessagePart[]) : []
        const resume = kept ? resumeOf(parts) : undefined
        // The mark of the turn (spec 007, "Outside content"). A turn that waited through a
        // restart gets it back from its saved steps and from the card that waits.
        const origin = lastUser && !resumed ? origins.get(lastUser.id) : undefined
        const mark = newTurnMark(origin?.starter ?? starterOf(task.source), origin?.outside ?? null)
        if (kept) holdOutside(mark, outsideOfParts(parts))
        const counted = kept
          ? db.get<{ input_tokens: number | null; output_tokens: number | null }>(
              "SELECT input_tokens, output_tokens FROM message WHERE id = ?",
              kept.id,
            )
          : undefined
        const usage = { input: counted?.input_tokens ?? 0, output: counted?.output_tokens ?? 0 }
        const controller = new AbortController()
        // The silent limit counts for every kind of turn. A change of the setting counts for the
        // turns that start after it (spec 013).
        const watch = turnWatch({
          limitMinutes: (yield* settings.get).silentLimit,
          progress: (progress) => tasks.setProgress(task.id, progress),
          userHoldsBrowser: () => tools.browserState(agentId).control,
        })
        let lastEmit = 0
        let lastSave = 0
        // Messages that the user sends now join this turn (spec 003).
        const turn: LiveTurn = {
          replyId: reply.id,
          waiting: [],
          handed: new Set(),
          watchers: new Set(),
          question: () =>
            parts.find(
              (p): p is Extract<MessagePart, { kind: "tool" }> =>
                p.kind === "tool" && p.state === "waiting" && p.ask?.kind === "question",
            )?.id,
          answeredInChat: (callId) => {
            const index = parts.findIndex((p) => p.kind === "tool" && p.id === callId)
            const part = parts[index]
            if (part?.kind !== "tool") return
            parts[index] = { ...part, answeredInChat: true }
            save("streaming")
            publish()
          },
        }
        const inbox: TurnInbox = {
          take: () => {
            const taken = turn.waiting.splice(0)
            for (const message of taken) {
              turn.handed.add(message.id)
              const row = messageRow(message.id)
              if (row) emitMessage(row)
            }
            return taken
          },
          watch: (ready) => {
            turn.watchers.add(ready)
            return () => turn.watchers.delete(ready)
          },
        }
        live.set(agentId, turn)
        // The first part that the user sees is saved and shown at once, and its time is kept.
        let replied = task.firstReplyAt !== null
        const firstReply = () => !replied && hasVisibleReply(parts)
        const markReplied = () => {
          replied = true
          tasks.replied(task.id)
        }

        const save = (
          status: MessageStatus,
          error?: { code: string; detail: string; resetsAt: number | null },
        ) => {
          db.run(
            `UPDATE message SET parts = ?, status = ?, error_code = ?, error_detail = ?, error_resets_at = ?,
              input_tokens = ?, output_tokens = ?, finished_at = ? WHERE id = ?`,
            JSON.stringify(parts),
            status,
            error?.code ?? null,
            error?.detail ?? null,
            error?.resetsAt ?? null,
            usage.input,
            usage.output,
            status === "streaming" ? null : Date.now(),
            reply.id,
          )
        }
        const publish = () => {
          const row = messageRow(reply.id)
          if (row) emitMessage({ ...row, parts: JSON.stringify(parts) })
        }

        const onEvent = (event: AgentEvent) =>
          Effect.sync(() => {
            watch.sense(event)
            if (event.type === "usage") {
              usage.input = event.input ?? usage.input
              usage.output = event.output ?? usage.output
              return
            }
            if (event.type === "joined") {
              // The agent read a message of the user: the muted line goes away.
              turn.handed.delete(event.id)
              db.run("UPDATE message SET read_at = ? WHERE id = ?", Date.now(), event.id)
              const row = messageRow(event.id)
              if (row) emitMessage(row)
            }
            const boundary = applyEvent(parts, event)
            activity.setStep(agentId, runningStepKind(parts))
            const now = Date.now()
            const first = firstReply()
            if (boundary || first || now - lastSave >= SAVE_EVERY_MS) {
              save("streaming")
              lastSave = now
            }
            if (boundary || first || now - lastEmit >= EMIT_EVERY_MS) {
              publish()
              lastEmit = now
            }
            if (first) markReplied()
          })

        const stream = Effect.gen(function* () {
          if (!agent.model_account_id || !agent.model_name) {
            return yield* new AppError({ code: "provider_not_connected" })
          }
          // The data changed since the restart, so the card cannot go on.
          if (resumed && !resume) return yield* new AppError({ code: "app_stopped" })
          const isRuntime = providers.isRuntime(agent.model_account_id)
          const remembered = memory.forTurn(agentId, asked ? messageText(asked) : "")
          // Claude Code reads the start of a request from the cache of the model, but only when
          // that start is the same as in the turn before. What the app tells it about this
          // message therefore goes with the message, and is kept with it, and not into the
          // instructions, which come first in the request and would change at each message.
          const withNotes = providers.runtimeKind(agent.model_account_id) === "claude_code"
          const notes =
            remembered.length > 0
              ? `What you remember:\n${remembered.map((m) => `- ${m.text}`).join("\n")}`
              : ""
          if (withNotes && lastUser)
            db.run("UPDATE message SET context = ? WHERE id = ?", notes || null, lastUser.id)
          const known = knowledge.prompt(
            agentId,
            asked ? messageText(asked) : "",
            isRuntime ? "files" : "tools",
          )
          const system = [
            agent.instructions,
            `Your workspace folder is ${agent.workspace}. Files you write go there. Use your tools to work with files, run commands and fetch pages, and ask the user when you need a decision.`,
            withNotes ? "" : notes,
            known ?? "",
          ]
            .filter(Boolean)
            .join("\n\n")
          const changePart = (
            callId: string,
            change: (p: Extract<MessagePart, { kind: "tool" }>) => MessagePart,
          ) => {
            // After a stop the reply is saved as stopped, and a late change must not undo that.
            if (controller.signal.aborted) return
            const index = parts.findIndex((p) => p.kind === "tool" && p.id === callId)
            const part = parts[index]
            if (part?.kind !== "tool") return
            parts[index] = change(part)
            save("streaming")
            publish()
            // A question card or an approval card is a reply that the user sees.
            if (firstReply()) markReplied()
          }
          const context: ToolContext = {
            agentId,
            workspace: agent.workspace,
            permission: agent.permission,
            signal: controller.signal,
            onWaiting: (callId, ask) => {
              tasks.setWaiting(task.id, ask !== null)
              watch.waiting(ask !== null)
              if (ask)
                notifier.attention({
                  agentId,
                  serverId: agent.server_id,
                  channelId: null,
                  callId,
                  kind: askKind(ask),
                  always: askAllowsAlways(ask),
                  summary: askSummary(ask),
                  step: askStep(ask, toolNameOf(parts, callId)),
                  target: { kind: "agent", id: agentId, messageId: reply.id },
                  ...(ask.askedAt !== undefined ? { askedAt: ask.askedAt } : {}),
                })
              else notifier.clearAttention(agentId, callId)
              changePart(callId, (p) => {
                const { ask: _drop, ...rest } = p
                if (!ask) return { ...rest, state: "running" }
                // A card that waited through a restart keeps the time of its first ask.
                return {
                  ...rest,
                  state: "waiting",
                  ask: p.ask && sameAsk(p.ask, ask) ? p.ask : ask,
                }
              })
            },
            onMemory: (callId, memory) => changePart(callId, (p) => ({ ...p, memory })),
            origin: { kind: "agent", id: agentId, messageId: reply.id },
            onDecision: (callId, answer, by) =>
              changePart(callId, (p) => ({ ...p, decision: { answer, by } })),
            onKnowledge: (callId, note) => changePart(callId, (p) => ({ ...p, knowledge: note })),
            onSecret: (callId, result) => changePart(callId, (p) => ({ ...p, secret: result })),
            onSettings: (callId, note) => changePart(callId, (p) => ({ ...p, settings: note })),
            knowledgeChanges: { count: 0 },
            turn: mark,
            taskId: task.id,
          }
          // A step of a workflow can ask for its own effort for this one turn. It is read for each
          // turn, so a retry decides again from the step and the model, not from the first try.
          // The levels come from the model list of the account, as for the effort of an agent. A
          // list that cannot be read leaves the levels that the vendor documents for the model.
          let offered: readonly string[] = []
          if (turnEffort) {
            const accounts = yield* providers.accounts
            const listed = yield* providers
              .models(agent.model_account_id)
              .pipe(Effect.orElseSucceed((): readonly ModelInfo[] | undefined => undefined))
            const kind = accounts.find((a) => a.id === agent.model_account_id)?.kind ?? "custom"
            offered = offeredEfforts(kind, agent.model_name, listed)
          }
          const events = yield* providers.events(
            agent.model_account_id,
            {
              model: agent.model_name,
              effort: stepTurnEffort(turnEffort, agent.model_effort, offered),
              system,
              turns: buildTurns(agentId, reply.id, withNotes),
              tools: tools.defs({
                memory: agent.memory_enabled === 1,
                knowledge: knowledge.enabled(agentId),
                // Changes from the chat are for agents of an API provider (spec 002).
                settings: !isRuntime,
              }),
              signal: controller.signal,
              workspace: agent.workspace,
              permission: agent.permission,
              useTools: true,
              ...(resume ? { resume } : {}),
              inbox,
            },
            {
              execute: (call) => tools.execute(context, call),
              approve: (request) => tools.approval(context, request),
              // An agent runtime has no browser of its own. It calls the app for it, and the
              // card of each call is the one that an API agent would show.
              ...(isRuntime
                ? {
                    bridge: tools.bridge(context, (event) => {
                      if (!controller.signal.aborted) Effect.runSync(onEvent(event))
                    }),
                  }
                : {}),
            },
          )
          yield* Stream.fromAsyncIterable(closing(events, controller, watch), (e) => e).pipe(
            // The program also reports its own calls of these tools. The app shows its own cards.
            Stream.runForEach((event) => {
              if (isRuntime && event.type === "tool" && bridgeToolName(event.call.name) !== null) {
                watch.sense(event)
                return Effect.void
              }
              // A web, browser or connection step of the program itself gives outside content.
              if (isRuntime && event.type === "tool" && event.state !== "running")
                holdOutside(mark, outsideOfCall(event.call.name, event.call.input))
              return onEvent(event)
            }),
          )
        })

        activity.setWorking(agentId, agent.server_id, true)
        // A vendor program writes the Knowledge folder itself. The folder is read again after it.
        const writesFiles = !!agent.model_account_id && providers.isRuntime(agent.model_account_id)
        knowledge.begin(agentId)
        // A turn that shows no sign of life for the silent limit stops like after a Stop, and its
        // task fails with the reason (spec 005).
        const watched = Effect.raceFirst(stream, watch.silent)
        yield* tasks.run(task.id, agentId, watched, resumed ? { resumed: true } : undefined).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              watch.stop()
              controller.abort()
              live.delete(agentId)
              // A message that the agent did not read starts the next turn (spec 003). It is a
              // plain message after the reply now.
              const unread = [...turn.waiting.map((m) => m.id), ...turn.handed]
              if (unread.length > 0) {
                db.run(
                  "UPDATE message SET joined_to = NULL WHERE id IN (SELECT value FROM json_each(?))",
                  JSON.stringify(unread),
                )
                for (const id of unread) {
                  const row = messageRow(id)
                  if (row) emitMessage(row)
                }
                unreadLeft.add(agentId)
              }
              knowledge.end(agentId, writesFiles ? "agent" : "user")
              notifier.clearAgent(agentId)
              // A step that did not finish cannot keep a running mark or a question card.
              for (const [i, part] of parts.entries()) {
                if (part.kind !== "tool" || (part.state !== "running" && part.state !== "waiting"))
                  continue
                const { ask: _ask, ...rest } = part
                parts[i] = { ...rest, state: "failed" }
              }
              if (Exit.isSuccess(exit)) {
                save("done")
                notifier.notify({
                  kind: "reply",
                  agentId,
                  serverId: agent.server_id,
                  title: agent.name,
                  body: messageText({ parts }),
                  target: { kind: "agent", id: agentId, messageId: reply.id },
                })
              } else if (Cause.hasInterruptsOnly(exit.cause)) save("stopped")
              else {
                const failure = Cause.squash(exit.cause)
                if (failure instanceof ProviderFailure) {
                  save("failed", {
                    code: failure.code,
                    detail: failure.detail ?? "",
                    resetsAt: failure.resetsAt ?? null,
                  })
                } else if (failure instanceof AppError) {
                  save("failed", {
                    code: failure.code,
                    detail: failure.detail ?? "",
                    resetsAt: null,
                  })
                } else {
                  console.error("reply failed", Cause.pretty(exit.cause))
                  save("failed", { code: "unknown", detail: "", resetsAt: null })
                }
              }
              const row = messageRow(reply.id)
              if (row) emitMessage(row)
              activity.setWorking(agentId, agent.server_id, false)
              placesChanged(agentId)
            }),
          ),
          Effect.ignore,
        )
      })

      /** Answers the last message, then each queued message in order. */
      const worker = (agentId: string, resumed?: Task) =>
        Effect.gen(function* () {
          let first = resumed
          for (;;) {
            yield* runTurn(agentId, first)
            first = undefined
            // Messages that the turn did not read go first: they are in the chat already.
            if (unreadLeft.delete(agentId)) continue
            const next = queues.get(agentId)?.shift()
            if (!next) return
            emitQueue(agentId)
            insertQueued(agentId, next)
          }
        })

      const kick = (agentId: string) =>
        FiberMap.run(workers, agentId, worker(agentId), { onlyIfMissing: true })
      const isRunning = (agentId: string) => FiberMap.has(workers, agentId)

      const usableAgent = (agentId: string, model?: AgentModel) =>
        Effect.gen(function* () {
          const agent = agentRow(agentId)
          if (!agent || agent.archived_at !== null)
            return yield* new AppError({ code: "agent_not_found" })
          // A routine with a model of its own needs that account, not the one of the agent.
          const accountId = model ? model.accountId : agent.model_account_id
          const name = model ? model.model : agent.model_name
          // A vendor program may have been signed out since the last look; this looks again.
          if (!accountId || !name || !(yield* providers.verify(accountId))) {
            return yield* new AppError({ code: "provider_not_connected" })
          }
          return agent
        })

      /**
       * Puts a message of the user into the running turn (spec 003). While a question card waits,
       * the message is its answer. Otherwise the agent reads it at the next step.
       */
      const join = Effect.fn("Chat.join")(function* (
        agentId: string,
        turn: LiveTurn,
        message: {
          readonly text: string
          readonly replyTo: string | null
          readonly files: readonly FilePart[]
          readonly skill: SkillPart | null
        },
        sender: Actor | null,
      ) {
        const question = turn.question()
        const row = insertMessage(
          agentId,
          "user",
          message.text,
          message.replyTo,
          null,
          message.files,
          sender,
          { to: turn.replyId, readAt: question ? Date.now() : null },
          message.skill,
        )
        if (question) {
          turn.answeredInChat(question)
          yield* tools.respond(agentId, question, turnText(row))
          return
        }
        turn.waiting.push({ id: row.id, text: turnText(row) })
        for (const ready of [...turn.watchers]) ready()
      })

      /** True when a message that the user sends now joins the running turn of the agent. */
      const joinable = (agentId: string) =>
        Effect.gen(function* () {
          const turn = live.get(agentId)
          if (!turn || holdOf(agentId)) return undefined
          return (yield* settings.get).duringTurn === "join" ? turn : undefined
        })

      const send = Effect.fn("Chat.send")(function* (input: ChatSend, origin?: TaskOrigin) {
        const sender = yield* CurrentActor
        const agent = yield* usableAgent(input.agentId, origin?.model)
        const paths = input.files ?? []
        // A skill chip that is off, deleted, or not for this agent is refused (spec 017).
        const chosen = input.skillId
          ? yield* skills.usable(input.agentId, input.skillId)
          : undefined
        const skill: SkillPart | null = chosen
          ? { kind: "skill", name: chosen.name, instructions: chosen.instructions }
          : null
        // A message needs text, a file, or a chip.
        if (!input.text.trim() && paths.length === 0 && !skill)
          return yield* new AppError({ code: "invalid_input" })
        // A routine or a workflow always starts new work; only the user joins a turn.
        const turn = origin ? undefined : yield* joinable(input.agentId)
        const isFull = (queues.get(input.agentId)?.length ?? 0) >= QUEUE_MAX
        if (!turn && (yield* isRunning(input.agentId)) && isFull)
          return yield* new AppError({ code: "queue_full" })
        const files = yield* Effect.try({
          try: () => copyAttachments(agent.workspace, paths),
          catch: (e) => (e instanceof AppError ? e : new AppError({ code: "file_unreadable" })),
        })
        // The turn can have ended while the files were copied.
        if (turn && live.get(input.agentId) === turn) {
          yield* join(
            input.agentId,
            turn,
            { text: input.text, replyTo: input.replyTo, files, skill },
            sender,
          )
          return { queued: false }
        }
        if (yield* isRunning(input.agentId)) {
          const queue = queues.get(input.agentId) ?? []
          if (queue.length >= QUEUE_MAX) return yield* new AppError({ code: "queue_full" })
          const item: QueuedMessage = {
            id: randomUUID(),
            text: input.text,
            replyTo: input.replyTo,
            files,
            ...(skill ? { skill } : {}),
          }
          asks.set(item.id, Date.now())
          if (origin) origins.set(item.id, origin)
          if (sender) senders.set(item.id, sender)
          queue.push(item)
          queues.set(input.agentId, queue)
          emitQueue(input.agentId)
          return { queued: true }
        }
        const row = insertMessage(
          input.agentId,
          "user",
          input.text,
          input.replyTo,
          null,
          files,
          sender,
          null,
          skill,
        )
        asks.set(row.id, row.created_at)
        if (origin) origins.set(row.id, origin)
        yield* kick(input.agentId)
        return { queued: false }
      })

      const stop = Effect.fn("Chat.stop")(function* (agentId: string) {
        const fiber = yield* FiberMap.get(workers, agentId)
        if (fiber._tag === "Some") yield* Fiber.interrupt(fiber.value)
        // Messages that the turn did not read start the next turn (spec 003).
        if (unreadLeft.delete(agentId)) {
          yield* kick(agentId)
          return
        }
        // The turn has ended, so the next queued message goes now.
        const next = queues.get(agentId)?.shift()
        if (next) {
          emitQueue(agentId)
          insertQueued(agentId, next)
          yield* kick(agentId)
        }
      })

      const lastRow = (agentId: string) => rows(agentId).at(-1)

      const retry = Effect.fn("Chat.retry")(function* (agentId: string, messageId: string) {
        yield* usableAgent(agentId)
        if (yield* isRunning(agentId)) return yield* new AppError({ code: "agent_working" })
        const last = lastRow(agentId)
        // A reply that a restart cut off before the request reached the model has nothing in it
        // and ran no step. "Send again" asks it again in place (spec 003).
        const cutBefore =
          last?.status === "stopped" &&
          (() => {
            const found = cutTaskOf(last.id)
            return found?.progress === "not_sent"
          })()
        if (
          !last ||
          last.id !== messageId ||
          last.author !== "agent" ||
          (last.status !== "failed" && !cutBefore)
        ) {
          return yield* new AppError({ code: "cannot_retry" })
        }
        // The new turn tries the failed task again (spec 005), so the Today page drops its row.
        const failed = db.get<{ id: string }>(
          "SELECT id FROM task WHERE message_id = ? AND agent_id = ? AND state = 'failed' AND origin IS NULL ORDER BY created_at DESC LIMIT 1",
          messageId,
          agentId,
        )
        if (failed) retryLinks.set(agentId, failed.id)
        db.run("DELETE FROM message WHERE id = ?", messageId)
        bus.emit("chat.removed", { agentId, messageId })
        yield* kick(agentId)
      })

      const edit = Effect.fn("Chat.edit")(function* (
        agentId: string,
        messageId: string,
        text: string,
      ) {
        yield* usableAgent(agentId)
        if (yield* isRunning(agentId)) return yield* new AppError({ code: "agent_working" })
        const all = rows(agentId)
        const index = all.findIndex((r) => r.id === messageId)
        const target = all[index]
        if (target?.author !== "user" || all.slice(index + 1).some((r) => r.author === "user")) {
          return yield* new AppError({ code: "cannot_edit" })
        }
        db.transaction(() => {
          db.run(
            "UPDATE message SET parts = ?, edited_at = ? WHERE id = ?",
            JSON.stringify([
              // An edit keeps the chip and its copy of the instructions (spec 017).
              ...[messageSkill(toMessage(target))].filter(Boolean),
              { kind: "text", text },
              ...messageFiles(toMessage(target)),
            ]),
            Date.now(),
            messageId,
          )
          for (const later of all.slice(index + 1))
            db.run("DELETE FROM message WHERE id = ?", later.id)
        })
        for (const later of all.slice(index + 1))
          bus.emit("chat.removed", { agentId, messageId: later.id })
        const edited = messageRow(messageId) as MessageRow
        asks.set(messageId, edited.edited_at ?? Date.now())
        emitMessage(edited)
        yield* kick(agentId)
      })

      tasks.onRetry("chat", (task) =>
        Effect.suspend(() => {
          retryLinks.set(task.agentId, task.id)
          // A reply that failed is asked again. A stopped one has nothing to replace, so the
          // question is sent again as a new message. A task of the other computer (spec 019)
          // runs here as a new task, and its messages stay as they are.
          if (task.originName !== null)
            return Effect.asVoid(send({ agentId: task.agentId, text: task.prompt, replyTo: null }))
          return retry(task.agentId, task.messageId ?? "").pipe(
            Effect.catch(() => {
              // Set before the send, because the turn can start at once.
              retryLinks.set(task.agentId, task.id)
              return Effect.asVoid(
                send({ agentId: task.agentId, text: task.prompt, replyTo: null }),
              )
            }),
          )
        }),
      )

      // The turns of tasks that waited through a restart start again. Each keeps the place of its
      // agent, so a message that comes now waits in the queue behind it.
      for (const task of reviving) {
        yield* FiberMap.run(workers, task.agentId, worker(task.agentId, task), {
          onlyIfMissing: true,
        })
      }

      return Chat.of({
        note: (agentId, part) => {
          const id = randomUUID()
          db.run(
            `INSERT INTO message (id, agent_id, author, parts, status, reply_to, model, created_at, from_device, from_name)
             VALUES (?, ?, 'agent', ?, 'done', NULL, NULL, ?, NULL, NULL)`,
            id,
            agentId,
            JSON.stringify([part]),
            Date.now(),
          )
          const row = messageRow(id)
          if (row) emitMessage(row)
          placesChanged(agentId)
        },
        announce: (messageId) => {
          const row = db.get<MessageRow>("SELECT * FROM message WHERE id = ?", messageId)
          if (row) emitMessage(row)
        },
        history: (agentId) =>
          Effect.sync(() => {
            const list = rows(agentId)
            return {
              messages: presentAll(list),
              queue: queues.get(agentId) ?? [],
              hold: holdOf(agentId),
              cut: cutOf(list),
            }
          }),
        send,
        sendNow: (agentId, itemId) =>
          Effect.gen(function* () {
            const queue = queues.get(agentId) ?? []
            const item = queue.find((q) => q.id === itemId)
            if (!item) return yield* new AppError({ code: "queue_item_gone" })
            const turn = live.get(agentId)
            // A program that takes no input during a turn cannot get it now (spec 003).
            if (!turn || holdOf(agentId)) return yield* new AppError({ code: "invalid_input" })
            queues.set(
              agentId,
              queue.filter((q) => q.id !== itemId),
            )
            emitQueue(agentId)
            const sender = senders.get(itemId) ?? null
            senders.delete(itemId)
            origins.delete(itemId)
            // "Send now" keeps the chip of the queued message (spec 017).
            yield* join(agentId, turn, { ...item, skill: item.skill ?? null }, sender)
          }),
        deleteUnread: (agentId, messageId) =>
          Effect.suspend(() => {
            const turn = live.get(agentId)
            const index = turn?.waiting.findIndex((m) => m.id === messageId) ?? -1
            if (!turn || index < 0) return Effect.fail(new AppError({ code: "message_read" }))
            turn.waiting.splice(index, 1)
            db.run("DELETE FROM message WHERE id = ?", messageId)
            bus.emit("chat.removed", { agentId, messageId })
            placesChanged(agentId)
            return Effect.void
          }),
        stop,
        retry,
        edit,
        updateQueued: (agentId, itemId, text) =>
          Effect.suspend(() => {
            const queue = queues.get(agentId) ?? []
            const index = queue.findIndex((q) => q.id === itemId)
            const item = queue[index]
            if (!item) return Effect.fail(new AppError({ code: "queue_item_gone" }))
            queue[index] = { ...item, text }
            emitQueue(agentId)
            return Effect.void
          }),
        removeQueued: (agentId, itemId) =>
          Effect.sync(() => {
            queues.set(
              agentId,
              (queues.get(agentId) ?? []).filter((q) => q.id !== itemId),
            )
            emitQueue(agentId)
          }),
        markRead: (agentId) =>
          Effect.sync(() => {
            db.run("UPDATE agent SET last_read_at = ? WHERE id = ?", Date.now(), agentId)
            placesChanged(agentId)
          }),
      })
    }),
  )
}
