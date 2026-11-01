import { randomUUID } from "node:crypto"
import { charLength, MEMORY_TEXT_MAX, type MemoryItem, relevantMemory } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"

export interface MemoryService {
  /** The items of one agent, newest first. A query keeps the items that contain it. */
  list(agentId: string, query?: string): Effect.Effect<readonly MemoryItem[]>
  add(
    agentId: string,
    text: string,
    source: "user" | "agent",
    messageId?: string | null,
  ): Effect.Effect<MemoryItem, AppError>
  update(id: string, text: string): Effect.Effect<MemoryItem, AppError>
  remove(id: string): Effect.Effect<void>
  /** What an agent reads before a turn: the items that relate to the message. Empty when off. */
  forTurn(agentId: string, message: string): readonly MemoryItem[]
}

interface Row {
  id: string
  agent_id: string
  text: string
  source: "user" | "agent"
  created_at: number
  updated_at: number
}

const toItem = (r: Row): MemoryItem => ({
  id: r.id,
  agentId: r.agent_id,
  text: r.text,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class Memory extends Context.Service<Memory, MemoryService>()("robot/main/Memory") {
  static readonly layer = Layer.effect(
    Memory,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const rows = (agentId: string) =>
        db.all<Row>(
          "SELECT * FROM memory WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
          agentId,
        )
      const changed = (agentId: string) => bus.emit("memory.changed", { agentId })
      const check = (text: string) =>
        Effect.suspend(() => {
          const value = text.trim()
          return value && charLength(value) <= MEMORY_TEXT_MAX
            ? Effect.succeed(value)
            : Effect.fail(new AppError({ code: "invalid_input" }))
        })

      return Memory.of({
        list: (agentId, query) =>
          Effect.sync(() => {
            const q = query?.trim().toLocaleLowerCase()
            return rows(agentId)
              .map(toItem)
              .filter((i) => !q || i.text.toLocaleLowerCase().includes(q))
          }),
        add: (agentId, text, source, messageId = null) =>
          Effect.gen(function* () {
            const value = yield* check(text)
            if (!db.get("SELECT 1 AS x FROM agent WHERE id = ?", agentId))
              return yield* new AppError({ code: "agent_not_found" })
            const id = randomUUID()
            const now = Date.now()
            db.run(
              "INSERT INTO memory (id, agent_id, text, source, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              id,
              agentId,
              value,
              source,
              messageId,
              now,
              now,
            )
            changed(agentId)
            return toItem(db.get<Row>("SELECT * FROM memory WHERE id = ?", id) as Row)
          }),
        update: (id, text) =>
          Effect.gen(function* () {
            const value = yield* check(text)
            const row = db.get<Row>("SELECT * FROM memory WHERE id = ?", id)
            if (!row) return yield* new AppError({ code: "memory_not_found" })
            db.run("UPDATE memory SET text = ?, updated_at = ? WHERE id = ?", value, Date.now(), id)
            changed(row.agent_id)
            return toItem(db.get<Row>("SELECT * FROM memory WHERE id = ?", id) as Row)
          }),
        remove: (id) =>
          Effect.sync(() => {
            const row = db.get<Row>("SELECT * FROM memory WHERE id = ?", id)
            if (!row) return
            db.run("DELETE FROM memory WHERE id = ?", id)
            changed(row.agent_id)
          }),
        forTurn: (agentId, message) => {
          const on = db.get<{ memory_enabled: number }>(
            "SELECT memory_enabled FROM agent WHERE id = ?",
            agentId,
          )
          if (on?.memory_enabled !== 1) return []
          return relevantMemory(rows(agentId).map(toItem), message)
        },
      })
    }),
  )
}
