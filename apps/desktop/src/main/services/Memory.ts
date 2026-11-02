import { randomUUID } from "node:crypto"
import {
  charLength,
  DAY_MS,
  isMemoryMode,
  looksLikeSecret,
  MEMORY_HISTORY_DAYS,
  MEMORY_HISTORY_MAX,
  MEMORY_PROPOSAL_DAYS,
  MEMORY_PROPOSALS_MAX,
  MEMORY_TEXT_MAX,
  MEMORY_USER_TEXT_MAX,
  type MemoryActor,
  type MemoryChange,
  type MemoryHistoryRow,
  type MemoryItem,
  type MemoryMode,
  type MemoryPlace,
  type MemoryProposal,
  type MemorySave,
  type MemorySource,
  memoryUndo,
  REDACTED,
  relevantMemory,
  sameMemoryText,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"

/** Where a save was made: the direct chat of the agent, or a channel. */
export interface MemoryOrigin {
  readonly kind: "agent" | "channel"
  readonly id: string
  readonly messageId: string
}

/** What a save would do, with no change made. A text that is refused has its reason. */
export type MemoryPlan =
  | { readonly kind: "item" }
  | { readonly kind: "proposal" }
  | Extract<MemorySave, { kind: "known" | "empty" | "too_long" | "secret" | "off" }>

export interface MemoryService {
  /** The items of one agent, newest first. A query keeps the items that contain it. */
  list(agentId: string, query?: string): Effect.Effect<readonly MemoryItem[]>
  /**
   * Adds an item as the user, or for an accepted proposal. A text typed by hand may be longer than
   * the tool takes and may look like a secret. Every item makes a history row.
   */
  add(
    agentId: string,
    text: string,
    source: MemorySource,
    messageId?: string | null,
  ): Effect.Effect<MemoryItem, AppError>
  update(id: string, text: string): Effect.Effect<MemoryItem, AppError>
  remove(id: string): Effect.Effect<void>
  /** What an agent reads before a turn: the items that relate to the message. Empty when off. */
  forTurn(agentId: string, message: string): readonly MemoryItem[]

  /**
   * What `save` would do for this text: make an item, make a proposal, or refuse. It changes
   * nothing, so the tool can ask the user before a save that is guarded (spec 007).
   */
  plan(agentId: string, text: string): Effect.Effect<MemoryPlan>
  /** What the memory tool does for an agent: it saves at once or makes a proposal. */
  save(agentId: string, text: string, origin?: MemoryOrigin): Effect.Effect<MemorySave>
  mode(agentId: string): Effect.Effect<MemoryMode>
  setMode(agentId: string, mode: MemoryMode): Effect.Effect<void, AppError>

  /** The proposals of an agent, oldest first. Ended ones are gone. */
  proposals(agentId: string): Effect.Effect<readonly MemoryProposal[]>
  /** Makes an item of a proposal. `text` is the edited text of "Edit and save". */
  accept(id: string, text?: string): Effect.Effect<MemoryItem, AppError>
  dismiss(id: string): Effect.Effect<void>

  /** The changes to the memory of an agent, newest first. */
  history(agentId: string): Effect.Effect<readonly MemoryHistoryRow[]>
  historyRow(id: string): Effect.Effect<MemoryHistoryRow | undefined>
  /** Takes one change back, if the item is still as that change made it. */
  undo(id: string): Effect.Effect<void, AppError>
}

interface Row {
  id: string
  agent_id: string
  text: string
  source: MemorySource
  created_at: number
  updated_at: number
}

interface ProposalRow {
  id: string
  agent_id: string
  text: string
  place_kind: "agent" | "channel" | null
  place_id: string | null
  created_at: number
}

interface HistoryDb {
  id: string
  agent_id: string
  memory_id: string
  at: number
  actor: MemoryActor
  kind: MemoryChange
  source: MemorySource
  old_text: string | null
  new_text: string | null
  hidden: number
  undo_of: string | null
  undone_by: string | null
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
      const secrets = yield* Secrets

      const rows = (agentId: string) =>
        db.all<Row>(
          "SELECT * FROM memory WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
          agentId,
        )
      const itemRow = (id: string) => db.get<Row>("SELECT * FROM memory WHERE id = ?", id)
      const changed = (agentId: string) => bus.emit("memory.changed", { agentId })

      /** The keys of the model accounts. A text that holds one looks like a secret (spec 014). */
      const storedKeys = () =>
        db
          .all<{ id: string }>("SELECT id FROM provider_account")
          .map((a) => secrets.get(secretKey(a.id)))
          .filter((k): k is string => k !== null)
      const looksSecret = (text: string | null) =>
        text !== null && looksLikeSecret(text, storedKeys())

      /** The text of an item that the user types: not empty, at most the limit for a hand-typed text. */
      const checkUser = (text: string) =>
        Effect.suspend(() => {
          const value = text.trim()
          return value && charLength(value) <= MEMORY_USER_TEXT_MAX
            ? Effect.succeed(value)
            : Effect.fail(new AppError({ code: "invalid_input" }))
        })

      // ------------------------------------------------------------------------ retention

      /** History keeps 90 days and 1000 rows for each agent. The oldest rows go first. */
      const pruneHistory = (agentId: string) => {
        db.run(
          "DELETE FROM memory_history WHERE agent_id = ? AND at < ?",
          agentId,
          Date.now() - MEMORY_HISTORY_DAYS * DAY_MS,
        )
        db.run(
          `DELETE FROM memory_history WHERE agent_id = ? AND id IN (
             SELECT id FROM memory_history WHERE agent_id = ?
             ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
          agentId,
          agentId,
          MEMORY_HISTORY_MAX,
        )
      }
      /** A proposal that nobody answers ends after 30 days. */
      const pruneProposals = (agentId: string) =>
        db.run(
          "DELETE FROM memory_proposal WHERE agent_id = ? AND created_at <= ?",
          agentId,
          Date.now() - MEMORY_PROPOSAL_DAYS * DAY_MS,
        )

      // ------------------------------------------------------------------------ history

      const record = (
        agentId: string,
        memoryId: string,
        actor: MemoryActor,
        kind: MemoryChange,
        source: MemorySource,
        oldText: string | null,
        newText: string | null,
        undoOf: string | null = null,
      ) => {
        const id = randomUUID()
        db.run(
          `INSERT INTO memory_history
             (id, agent_id, memory_id, at, actor, kind, source, old_text, new_text, undo_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          agentId,
          memoryId,
          Date.now(),
          actor,
          kind,
          source,
          oldText,
          newText,
          undoOf,
        )
        pruneHistory(agentId)
        return id
      }

      const historyDb = (id: string) =>
        db.get<HistoryDb>("SELECT * FROM memory_history WHERE id = ?", id)

      const secretRow = (r: HistoryDb) =>
        r.hidden === 1 || looksSecret(r.old_text) || looksSecret(r.new_text)

      const toHistory = (r: HistoryDb): MemoryHistoryRow => {
        const secret = secretRow(r)
        return {
          id: r.id,
          agentId: r.agent_id,
          at: r.at,
          actor: r.actor,
          kind: r.kind,
          before: secret && r.old_text !== null ? REDACTED : r.old_text,
          after: secret && r.new_text !== null ? REDACTED : r.new_text,
          undo: memoryUndo({
            kind: r.kind,
            after: r.new_text,
            itemText: itemRow(r.memory_id)?.text ?? null,
            revived: r.undone_by !== null,
            secret,
          }),
          undone: r.undone_by !== null,
        }
      }

      // ------------------------------------------------------------------------ items

      const insertItem = (
        agentId: string,
        value: string,
        source: MemorySource,
        messageId: string | null,
      ) => {
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
        return id
      }

      const needAgent = (agentId: string) =>
        db.get<{ memory_enabled: number; memory_mode: string }>(
          "SELECT memory_enabled, memory_mode FROM agent WHERE id = ?",
          agentId,
        )

      const addItem = (
        agentId: string,
        value: string,
        source: MemorySource,
        actor: MemoryActor,
        messageId: string | null,
      ) => {
        const id = insertItem(agentId, value, source, messageId)
        const historyId = record(agentId, id, actor, "added", source, null, value)
        changed(agentId)
        return { item: toItem(itemRow(id) as Row), historyId }
      }

      const placeOf = (r: ProposalRow): MemoryPlace | null => {
        if (!r.place_kind || !r.place_id) return null
        const name =
          r.place_kind === "channel"
            ? db.get<{ name: string }>("SELECT name FROM channel WHERE id = ?", r.place_id)?.name
            : db.get<{ name: string }>("SELECT name FROM agent WHERE id = ?", r.place_id)?.name
        return { kind: r.place_kind, id: r.place_id, name: name ?? null }
      }
      const toProposal = (r: ProposalRow): MemoryProposal => ({
        id: r.id,
        agentId: r.agent_id,
        text: r.text,
        createdAt: r.created_at,
        place: placeOf(r),
      })
      const proposalRows = (agentId: string) => {
        pruneProposals(agentId)
        return db.all<ProposalRow>(
          "SELECT * FROM memory_proposal WHERE agent_id = ? ORDER BY created_at, rowid",
          agentId,
        )
      }

      /**
       * What a save of this text does. The tool does not save a secret and does not suggest one
       * (the user can type it). A fact that is known is not added again: spaces at both ends and
       * the case of letters do not matter, and a proposal counts as known only while the agent
       * suggests.
       */
      type Decision =
        | { kind: "refuse"; result: MemoryPlan & MemorySave }
        | { kind: "item" | "proposal"; value: string }
      const decide = (agentId: string, text: string): Decision => {
        const agent = needAgent(agentId)
        if (agent?.memory_enabled !== 1) return { kind: "refuse", result: { kind: "off" } }
        const value = text.trim()
        if (!value) return { kind: "refuse", result: { kind: "empty" } }
        if (charLength(value) > MEMORY_TEXT_MAX)
          return { kind: "refuse", result: { kind: "too_long" } }
        if (looksSecret(value)) return { kind: "refuse", result: { kind: "secret" } }
        if (rows(agentId).some((i) => sameMemoryText(i.text, value)))
          return { kind: "refuse", result: { kind: "known" } }
        if (agent.memory_mode !== "ask") return { kind: "item", value }
        if (proposalRows(agentId).some((p) => sameMemoryText(p.text, value)))
          return { kind: "refuse", result: { kind: "known" } }
        return { kind: "proposal", value }
      }

      // Proposals that ended while the app was off, and history past its limits, go at the start.
      for (const a of db.all<{ id: string }>("SELECT id FROM agent")) {
        pruneProposals(a.id)
        pruneHistory(a.id)
      }

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
            const value = yield* checkUser(text)
            if (!needAgent(agentId)) return yield* new AppError({ code: "agent_not_found" })
            return addItem(
              agentId,
              value,
              source,
              source === "agent" ? "agent" : source === "proposal" ? "proposal" : "user",
              messageId,
            ).item
          }),
        update: (id, text) =>
          Effect.gen(function* () {
            const value = yield* checkUser(text)
            const row = itemRow(id)
            if (!row) return yield* new AppError({ code: "memory_not_found" })
            // The same text is no change: no new time, no history row.
            if (row.text === value) return toItem(row)
            db.run("UPDATE memory SET text = ?, updated_at = ? WHERE id = ?", value, Date.now(), id)
            record(row.agent_id, id, "user", "edited", row.source, row.text, value)
            changed(row.agent_id)
            return toItem(itemRow(id) as Row)
          }),
        remove: (id) =>
          Effect.sync(() => {
            const row = itemRow(id)
            if (!row) return
            db.run("DELETE FROM memory WHERE id = ?", id)
            record(row.agent_id, id, "user", "deleted", row.source, row.text, null)
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

        plan: (agentId, text) =>
          Effect.sync((): MemoryPlan => {
            const d = decide(agentId, text)
            return d.kind === "refuse" ? d.result : { kind: d.kind }
          }),
        save: (agentId, text, origin) =>
          Effect.sync((): MemorySave => {
            const d = decide(agentId, text)
            if (d.kind === "refuse") return d.result
            if (d.kind === "item") {
              const saved = addItem(agentId, d.value, "agent", "agent", origin?.messageId ?? null)
              return { kind: "saved", item: saved.item, historyId: saved.historyId }
            }
            const waiting = proposalRows(agentId)
            // At most 20 wait. A new one replaces the oldest.
            const over = waiting.length - (MEMORY_PROPOSALS_MAX - 1)
            for (const old of waiting.slice(0, Math.max(0, over)))
              db.run("DELETE FROM memory_proposal WHERE id = ?", old.id)
            const id = randomUUID()
            db.run(
              `INSERT INTO memory_proposal (id, agent_id, text, place_kind, place_id, message_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              id,
              agentId,
              d.value,
              origin?.kind ?? null,
              origin?.id ?? null,
              origin?.messageId ?? null,
              Date.now(),
            )
            changed(agentId)
            return {
              kind: "suggested",
              proposal: toProposal(
                db.get<ProposalRow>(
                  "SELECT * FROM memory_proposal WHERE id = ?",
                  id,
                ) as ProposalRow,
              ),
            }
          }),
        mode: (agentId) =>
          Effect.sync(() => {
            const value = needAgent(agentId)?.memory_mode
            return isMemoryMode(value) ? value : "now"
          }),
        setMode: (agentId, mode) =>
          Effect.gen(function* () {
            if (!isMemoryMode(mode)) return yield* new AppError({ code: "invalid_input" })
            if (!needAgent(agentId)) return yield* new AppError({ code: "agent_not_found" })
            // A change of the choice leaves the proposals as they are.
            db.run("UPDATE agent SET memory_mode = ? WHERE id = ?", mode, agentId)
            changed(agentId)
          }),

        proposals: (agentId) => Effect.sync(() => proposalRows(agentId).map(toProposal)),
        accept: (id, text) =>
          Effect.gen(function* () {
            const row = db.get<ProposalRow>("SELECT * FROM memory_proposal WHERE id = ?", id)
            if (!row) return yield* new AppError({ code: "memory_proposal_not_found" })
            // A proposal that ended cannot be saved any more.
            if (!proposalRows(row.agent_id).some((p) => p.id === id))
              return yield* new AppError({ code: "memory_proposal_not_found" })
            const value = yield* checkUser(text ?? row.text)
            const saved = addItem(row.agent_id, value, "proposal", "proposal", null)
            db.run("DELETE FROM memory_proposal WHERE id = ?", id)
            changed(row.agent_id)
            return saved.item
          }),
        dismiss: (id) =>
          Effect.sync(() => {
            const row = db.get<ProposalRow>("SELECT * FROM memory_proposal WHERE id = ?", id)
            if (!row) return
            db.run("DELETE FROM memory_proposal WHERE id = ?", id)
            changed(row.agent_id)
          }),

        history: (agentId) =>
          Effect.sync(() => {
            pruneHistory(agentId)
            return db
              .all<HistoryDb>(
                "SELECT * FROM memory_history WHERE agent_id = ? ORDER BY at DESC, rowid DESC",
                agentId,
              )
              .map(toHistory)
          }),
        historyRow: (id) =>
          Effect.sync(() => {
            const row = historyDb(id)
            return row ? toHistory(row) : undefined
          }),
        undo: (id) =>
          Effect.gen(function* () {
            const row = historyDb(id)
            if (!row) return yield* new AppError({ code: "memory_history_not_found" })
            if (!toHistory(row).undo.on) return yield* new AppError({ code: "memory_undo_off" })
            const agentId = row.agent_id
            let made: string
            if (row.kind === "added") {
              // Undo of "added" removes the item.
              const item = itemRow(row.memory_id) as Row
              db.run("DELETE FROM memory WHERE id = ?", item.id)
              made = record(
                agentId,
                item.id,
                "undo",
                "deleted",
                row.source,
                item.text,
                null,
                row.id,
              )
            } else if (row.kind === "edited") {
              // Undo of "edited" puts back the text before.
              const item = itemRow(row.memory_id) as Row
              const back = row.old_text ?? ""
              db.run(
                "UPDATE memory SET text = ?, updated_at = ? WHERE id = ?",
                back,
                Date.now(),
                item.id,
              )
              made = record(
                agentId,
                item.id,
                "undo",
                "edited",
                item.source,
                item.text,
                back,
                row.id,
              )
            } else {
              // Undo of "deleted" makes the item again with its text. It is a new item, because a
              // deletion that sync carried stands for the old one (spec 019).
              const back = row.old_text ?? ""
              const itemId = insertItem(agentId, back, row.source, null)
              made = record(agentId, itemId, "undo", "added", row.source, null, back, row.id)
            }
            db.run("UPDATE memory_history SET undone_by = ? WHERE id = ?", made, row.id)
            // An undo that is undone leaves the change it took back standing again.
            if (row.actor === "undo" && row.undo_of)
              db.run("UPDATE memory_history SET undone_by = NULL WHERE id = ?", row.undo_of)
            changed(agentId)
          }),
      })
    }),
  )
}
