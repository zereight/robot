import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  ATTACH_BYTES,
  ATTACH_MAX,
  type ChatMessage,
  type ChatSend,
  type FilePart,
  type MessagePart,
  type MessageStatus,
  messageFiles,
  messageText,
  QUEUE_MAX,
  type QueuedMessage,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Fiber, FiberMap, Layer, Stream } from "effect"
import { type StreamEvent, streamChat, type Turn } from "../providers/chat.ts"
import { ProviderFailure } from "../providers/client.ts"
import { Activity } from "./Activity.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Providers } from "./Providers.ts"

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
}

export interface ChatService {
  history(
    agentId: string,
  ): Effect.Effect<{ messages: readonly ChatMessage[]; queue: readonly QueuedMessage[] }>
  /** Sends at once when the agent is free; otherwise puts the message in the queue. */
  send(input: ChatSend): Effect.Effect<{ queued: boolean }, AppError>
  stop(agentId: string): Effect.Effect<void>
  retry(agentId: string, messageId: string): Effect.Effect<void, AppError>
  edit(agentId: string, messageId: string, text: string): Effect.Effect<void, AppError>
  updateQueued(agentId: string, itemId: string, text: string): Effect.Effect<void, AppError>
  removeQueued(agentId: string, itemId: string): Effect.Effect<void>
  markRead(agentId: string): Effect.Effect<void>
}

/** How often a streaming reply is sent to the window and written to disk. */
const EMIT_EVERY_MS = 50
const SAVE_EVERY_MS = 500
const QUOTE_MAX = 500

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

const toMessage = (row: MessageRow): ChatMessage => ({
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
})

/** Adds a stream event to the parts. Returns true when a new part starts (a part boundary). */
export const applyEvent = (parts: MessagePart[], event: StreamEvent): boolean => {
  if (event.type === "usage") return false
  const last = parts.at(-1)
  if (last && last.kind === event.type) {
    parts[parts.length - 1] = { kind: event.type, text: last.text + event.text }
    return false
  }
  parts.push({ kind: event.type, text: event.text })
  return true
}

export class Chat extends Context.Service<Chat, ChatService>()("robot/main/Chat") {
  static readonly layer = Layer.effect(
    Chat,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const providers = yield* Providers
      const activity = yield* Activity
      const workers = yield* FiberMap.make<string>()
      const queues = new Map<string, QueuedMessage[]>()

      // A reply that was streaming when the app closed keeps its parts and counts as stopped.
      db.run("UPDATE message SET status = 'stopped' WHERE status = 'streaming'")

      const agentRow = (agentId: string) =>
        db.get<AgentModelRow>(
          "SELECT id, server_id, name, instructions, archived_at, model_account_id, model_name, model_effort, workspace FROM agent WHERE id = ?",
          agentId,
        )
      const messageRow = (id: string) =>
        db.get<MessageRow>("SELECT * FROM message WHERE id = ?", id)
      const rows = (agentId: string) =>
        db.all<MessageRow>(
          "SELECT * FROM message WHERE agent_id = ? ORDER BY created_at, rowid",
          agentId,
        )

      const placesChanged = (agentId: string) => {
        const agent = agentRow(agentId)
        if (agent) bus.emit("places.changed", { serverId: agent.server_id })
      }
      const emitMessage = (row: MessageRow) => bus.emit("chat.message", toMessage(row))
      const emitQueue = (agentId: string) =>
        bus.emit("chat.queue", { agentId, queue: queues.get(agentId) ?? [] })

      const insertMessage = (
        agentId: string,
        author: "user" | "agent",
        text: string,
        replyTo: string | null,
        model: string | null,
        files: readonly FilePart[] = [],
      ) => {
        const id = randomUUID()
        db.run(
          `INSERT INTO message (id, agent_id, author, parts, status, reply_to, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          agentId,
          author,
          JSON.stringify(
            author === "user" ? [...(text ? [{ kind: "text", text }] : []), ...files] : [],
          ),
          author === "user" ? "done" : "streaming",
          replyTo,
          model,
          Date.now(),
        )
        const row = messageRow(id) as MessageRow
        emitMessage(row)
        placesChanged(agentId)
        return row
      }

      /** The conversation so far, as turns for the provider. A reply quotes what it answers. */
      const buildTurns = (agentId: string, exceptId: string): Turn[] =>
        rows(agentId)
          .filter((r) => r.id !== exceptId && !(r.author === "agent" && r.status === "failed"))
          .map((r) => {
            const text = messageText(toMessage(r))
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
            return {
              role: r.author === "user" ? "user" : "assistant",
              content: quote + [text, files].filter(Boolean).join("\n\n"),
            }
          })

      const runTurn = Effect.fn("Chat.runTurn")(function* (agentId: string) {
        const agent = agentRow(agentId)
        if (!agent) return
        const reply = insertMessage(agentId, "agent", "", null, agent.model_name)
        const parts: MessagePart[] = []
        const usage = { input: 0, output: 0 }
        const controller = new AbortController()
        let lastEmit = 0
        let lastSave = 0

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

        const onEvent = (event: StreamEvent) =>
          Effect.sync(() => {
            if (event.type === "usage") {
              usage.input = event.input ?? usage.input
              usage.output = event.output ?? usage.output
              return
            }
            const boundary = applyEvent(parts, event)
            const now = Date.now()
            if (boundary || now - lastSave >= SAVE_EVERY_MS) {
              save("streaming")
              lastSave = now
            }
            if (boundary || now - lastEmit >= EMIT_EVERY_MS) {
              publish()
              lastEmit = now
            }
          })

        const stream = Effect.gen(function* () {
          if (!agent.model_account_id || !agent.model_name) {
            return yield* new AppError({ code: "provider_not_connected" })
          }
          const connection = yield* providers.connection(agent.model_account_id)
          const events = streamChat({
            connection,
            model: agent.model_name,
            effort: agent.model_effort,
            system: agent.instructions,
            turns: buildTurns(agentId, reply.id),
            signal: controller.signal,
          })
          yield* Stream.fromAsyncIterable(events, (e) => e).pipe(Stream.runForEach(onEvent))
        })

        activity.setWorking(agentId, agent.server_id, true)
        yield* stream.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              controller.abort()
              if (Exit.isSuccess(exit)) save("done")
              else if (Cause.hasInterruptsOnly(exit.cause)) save("stopped")
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
      const worker = (agentId: string) =>
        Effect.gen(function* () {
          for (;;) {
            yield* runTurn(agentId)
            const next = queues.get(agentId)?.shift()
            if (!next) return
            emitQueue(agentId)
            insertMessage(agentId, "user", next.text, next.replyTo, null, next.files)
          }
        })

      const kick = (agentId: string) =>
        FiberMap.run(workers, agentId, worker(agentId), { onlyIfMissing: true })
      const isRunning = (agentId: string) => FiberMap.has(workers, agentId)

      const usableAgent = (agentId: string) =>
        Effect.suspend(() => {
          const agent = agentRow(agentId)
          if (!agent || agent.archived_at !== null)
            return Effect.fail(new AppError({ code: "agent_not_found" }))
          if (
            !agent.model_account_id ||
            !agent.model_name ||
            !providers.isConnected(agent.model_account_id)
          ) {
            return Effect.fail(new AppError({ code: "provider_not_connected" }))
          }
          return Effect.succeed(agent)
        })

      const send = Effect.fn("Chat.send")(function* (input: ChatSend) {
        const agent = yield* usableAgent(input.agentId)
        const paths = input.files ?? []
        if (!input.text.trim() && paths.length === 0)
          return yield* new AppError({ code: "invalid_input" })
        const isFull = (queues.get(input.agentId)?.length ?? 0) >= QUEUE_MAX
        if ((yield* isRunning(input.agentId)) && isFull)
          return yield* new AppError({ code: "queue_full" })
        const files = yield* Effect.try({
          try: () => copyAttachments(agent.workspace, paths),
          catch: (e) => (e instanceof AppError ? e : new AppError({ code: "file_unreadable" })),
        })
        if (yield* isRunning(input.agentId)) {
          const queue = queues.get(input.agentId) ?? []
          if (queue.length >= QUEUE_MAX) return yield* new AppError({ code: "queue_full" })
          queue.push({ id: randomUUID(), text: input.text, replyTo: input.replyTo, files })
          queues.set(input.agentId, queue)
          emitQueue(input.agentId)
          return { queued: true }
        }
        insertMessage(input.agentId, "user", input.text, input.replyTo, null, files)
        yield* kick(input.agentId)
        return { queued: false }
      })

      const stop = Effect.fn("Chat.stop")(function* (agentId: string) {
        const fiber = yield* FiberMap.get(workers, agentId)
        if (fiber._tag === "Some") yield* Fiber.interrupt(fiber.value)
        // The turn has ended, so the next queued message goes now.
        const next = queues.get(agentId)?.shift()
        if (next) {
          emitQueue(agentId)
          insertMessage(agentId, "user", next.text, next.replyTo, null, next.files)
          yield* kick(agentId)
        }
      })

      const lastRow = (agentId: string) => rows(agentId).at(-1)

      const retry = Effect.fn("Chat.retry")(function* (agentId: string, messageId: string) {
        yield* usableAgent(agentId)
        if (yield* isRunning(agentId)) return yield* new AppError({ code: "agent_working" })
        const last = lastRow(agentId)
        if (!last || last.id !== messageId || last.author !== "agent" || last.status !== "failed") {
          return yield* new AppError({ code: "cannot_retry" })
        }
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
            JSON.stringify([{ kind: "text", text }, ...messageFiles(toMessage(target))]),
            Date.now(),
            messageId,
          )
          for (const later of all.slice(index + 1))
            db.run("DELETE FROM message WHERE id = ?", later.id)
        })
        for (const later of all.slice(index + 1))
          bus.emit("chat.removed", { agentId, messageId: later.id })
        emitMessage(messageRow(messageId) as MessageRow)
        yield* kick(agentId)
      })

      return Chat.of({
        history: (agentId) =>
          Effect.sync(() => ({
            messages: rows(agentId).map(toMessage),
            queue: queues.get(agentId) ?? [],
          })),
        send,
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
