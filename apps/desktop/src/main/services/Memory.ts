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
  type MemoryChannel,
  type MemoryChannelRef,
  type MemoryFilter,
  type MemoryHistoryRow,
  type MemoryItem,
  type MemoryMode,
  type MemoryPlace,
  type MemoryProposal,
  type MemorySave,
  type MemoryScope,
  type MemorySource,
  memoryUndo,
  REDACTED,
  relevantMemory,
  sameMemoryText,
} from "@robot/shared"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"

/** The filter of the tab Items as a request carries it (spec 008, flow 6). */
export const MemoryFilterSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("general") }),
  Schema.Struct({
    kind: Schema.Literal("channel"),
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
])

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
  | Extract<MemorySave, { kind: "known" | "empty" | "too_long" | "secret" | "off" | "not_member" }>

export interface MemoryService {
  /**
   * The items of one agent, newest first. A query keeps the items that contain it. The filter
   * (spec 008, flow 6) keeps all items, the general items, or the notes of one channel.
   */
  list(agentId: string, query?: string, filter?: MemoryFilter): Effect.Effect<readonly MemoryItem[]>
  /**
   * The channels for the filter and for a move: every channel that has a note of the agent, and
   * every channel that the agent is a member of. Sorted by name.
   */
  scopes(agentId: string): Effect.Effect<readonly MemoryScope[]>
  /**
   * Moves an item to "General" (`null`) or to a channel that the agent is a member of. A move is
   * a change with a history row. The same place is no change.
   */
  move(id: string, channelId: string | null): Effect.Effect<MemoryItem, AppError>
  /**
   * Removes the notes for a channel that is deleted (spec 008, "Channel notes"). Each note gets
   * a history row by "the delete of a channel". Call it before the channel row goes, so that the
   * rows still hold its name.
   */
  deleteChannel(channelId: string): Effect.Effect<void>
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
  /**
   * What an agent reads before a turn: the items that relate to the message. Empty when off. In a
   * turn of a channel (`channelId`) these are its general items and its notes for that channel,
   * when the agent is a member. In any other turn they are its general items only (spec 008).
   */
  forTurn(agentId: string, message: string, channelId?: string): readonly MemoryItem[]

  /**
   * What `save` would do for this text: make an item, make a proposal, or refuse. It changes
   * nothing, so the tool can ask the user before a save that is guarded (spec 007).
   */
  plan(agentId: string, text: string, channelId?: string): Effect.Effect<MemoryPlan>
  /**
   * What the memory tool does for an agent: it saves at once or makes a proposal. With
   * `channelId` the item or the proposal is a note for that channel; the agent must be a member.
   */
  save(
    agentId: string,
    text: string,
    origin?: MemoryOrigin,
    channelId?: string,
  ): Effect.Effect<MemorySave>
  /**
   * The one tool of a memory check (spec 008): it makes a proposal, whatever the choice "Memory
   * saving" says, so that the user decides each one. The rules of a proposal hold: 500 characters,
   * no duplicate, no secret, at most 20 that wait. The proposal is marked as made by a check.
   */
  suggest(agentId: string, text: string): Effect.Effect<MemorySave>
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
  channel_id: string | null
}

interface ProposalRow {
  id: string
  agent_id: string
  text: string
  place_kind: "agent" | "channel" | null
  place_id: string | null
  created_at: number
  from_check: number
  channel_id: string | null
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
  channel_before: string | null
  channel_after: string | null
  channel_name_before: string | null
  channel_name_after: string | null
}

/** The channel of an item before and after a change (spec 008). */
interface ChannelPair {
  readonly before: string | null
  readonly after: string | null
}
const NO_CHANNEL: ChannelPair = { before: null, after: null }

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

      // ---------------------------------------------------------------------- channels

      const channelName = (id: string) =>
        db.get<{ name: string }>("SELECT name FROM channel WHERE id = ?", id)?.name ?? null
      const channelExists = (id: string) =>
        db.get("SELECT 1 AS x FROM channel WHERE id = ?", id) !== undefined
      const isMember = (agentId: string, channelId: string) =>
        db.get(
          "SELECT 1 AS x FROM channel_member WHERE channel_id = ? AND agent_id = ?",
          channelId,
          agentId,
        ) !== undefined
      /** The channel of a note, with the name now and whether the agent is a member. */
      const channelOf = (agentId: string, id: string | null): MemoryChannel | null =>
        id === null ? null : { id, name: channelName(id), member: isMember(agentId, id) }
      const toItem = (r: Row): MemoryItem => ({
        id: r.id,
        agentId: r.agent_id,
        text: r.text,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        channel: channelOf(r.agent_id, r.channel_id),
      })
      /** The items that an agent reads: general ones, and the notes of the channel when it is a member. */
      const readable = (agentId: string, channelId: string | undefined) =>
        rows(agentId).filter(
          (r) =>
            r.channel_id === null ||
            (channelId !== undefined && r.channel_id === channelId && isMember(agentId, channelId)),
        )

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
        channels: ChannelPair = NO_CHANNEL,
      ) => {
        const id = randomUUID()
        db.run(
          `INSERT INTO memory_history
             (id, agent_id, memory_id, at, actor, kind, source, old_text, new_text, undo_of,
              channel_before, channel_after, channel_name_before, channel_name_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          channels.before,
          channels.after,
          channels.before === null ? null : channelName(channels.before),
          channels.after === null ? null : channelName(channels.after),
        )
        pruneHistory(agentId)
        return id
      }

      const historyDb = (id: string) =>
        db.get<HistoryDb>("SELECT * FROM memory_history WHERE id = ?", id)

      const secretRow = (r: HistoryDb) =>
        r.hidden === 1 || looksSecret(r.old_text) || looksSecret(r.new_text)

      /** A channel of a row: the name now, or the name at the time when the channel is gone. */
      const refOf = (id: string | null, snapshot: string | null): MemoryChannelRef | null =>
        id === null ? null : { id, name: channelName(id) ?? snapshot }

      const toHistory = (r: HistoryDb): MemoryHistoryRow => {
        const secret = secretRow(r)
        const item = itemRow(r.memory_id)
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
            itemText: item?.text ?? null,
            afterChannel: r.channel_after,
            itemChannel: item?.channel_id ?? null,
            // A move goes back to the place it came from: that channel must still be there.
            backExists: r.channel_before === null || channelExists(r.channel_before),
            revived: r.undone_by !== null,
            secret,
          }),
          undone: r.undone_by !== null,
          channelBefore: refOf(r.channel_before, r.channel_name_before),
          channelAfter: refOf(r.channel_after, r.channel_name_after),
        }
      }

      // ------------------------------------------------------------------------ items

      const insertItem = (
        agentId: string,
        value: string,
        source: MemorySource,
        messageId: string | null,
        channelId: string | null = null,
      ) => {
        const id = randomUUID()
        const now = Date.now()
        db.run(
          "INSERT INTO memory (id, agent_id, text, source, message_id, created_at, updated_at, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          agentId,
          value,
          source,
          messageId,
          now,
          now,
          channelId,
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
        channelId: string | null = null,
      ) => {
        const id = insertItem(agentId, value, source, messageId, channelId)
        const historyId = record(agentId, id, actor, "added", source, null, value, null, {
          before: null,
          after: channelId,
        })
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
        fromCheck: r.from_check === 1,
        channel:
          r.channel_id === null ? null : { id: r.channel_id, name: channelName(r.channel_id) },
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
      const decide = (
        agentId: string,
        text: string,
        forceProposal = false,
        channelId: string | null = null,
      ): Decision => {
        const agent = needAgent(agentId)
        if (agent?.memory_enabled !== 1) return { kind: "refuse", result: { kind: "off" } }
        // A note is for a channel that the agent is a member of (spec 008, flow 6).
        if (channelId !== null && !(channelExists(channelId) && isMember(agentId, channelId)))
          return { kind: "refuse", result: { kind: "not_member" } }
        const value = text.trim()
        if (!value) return { kind: "refuse", result: { kind: "empty" } }
        if (charLength(value) > MEMORY_TEXT_MAX)
          return { kind: "refuse", result: { kind: "too_long" } }
        if (looksSecret(value)) return { kind: "refuse", result: { kind: "secret" } }
        // A fact is known when the agent reads it in the place where it would read the new one: a
        // general item is read everywhere, and a note only in its channel. So a note for one
        // channel does not stop the same text as a note for another channel (spec 008).
        if (
          rows(agentId).some(
            (i) =>
              sameMemoryText(i.text, value) &&
              (i.channel_id === null || i.channel_id === channelId),
          )
        )
          return { kind: "refuse", result: { kind: "known" } }
        if (agent.memory_mode !== "ask" && !forceProposal) return { kind: "item", value }
        if (
          proposalRows(agentId).some(
            (p) => sameMemoryText(p.text, value) && p.channel_id === channelId,
          )
        )
          return { kind: "refuse", result: { kind: "known" } }
        return { kind: "proposal", value }
      }

      /**
       * Stores a proposal. At most 20 wait: a new one replaces the oldest. `origin` names the chat
       * where the agent made it, and is null for a proposal of a memory check.
       */
      const propose = (
        agentId: string,
        value: string,
        origin: MemoryOrigin | null,
        fromCheck: boolean,
        channelId: string | null = null,
      ): MemorySave => {
        const waiting = proposalRows(agentId)
        const over = waiting.length - (MEMORY_PROPOSALS_MAX - 1)
        for (const old of waiting.slice(0, Math.max(0, over)))
          db.run("DELETE FROM memory_proposal WHERE id = ?", old.id)
        const id = randomUUID()
        db.run(
          `INSERT INTO memory_proposal (id, agent_id, text, place_kind, place_id, message_id, created_at, from_check, channel_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          agentId,
          value,
          origin?.kind ?? null,
          origin?.id ?? null,
          origin?.messageId ?? null,
          Date.now(),
          fromCheck ? 1 : 0,
          channelId,
        )
        changed(agentId)
        return {
          kind: "suggested",
          proposal: toProposal(
            db.get<ProposalRow>("SELECT * FROM memory_proposal WHERE id = ?", id) as ProposalRow,
          ),
        }
      }

      // Proposals that ended while the app was off, and history past its limits, go at the start.
      for (const a of db.all<{ id: string }>("SELECT id FROM agent")) {
        pruneProposals(a.id)
        pruneHistory(a.id)
      }

      return Memory.of({
        list: (agentId, query, filter) =>
          Effect.sync(() => {
            const q = query?.trim().toLocaleLowerCase()
            return rows(agentId)
              .filter(
                (r) =>
                  !filter ||
                  filter.kind === "all" ||
                  (filter.kind === "general" ? r.channel_id === null : r.channel_id === filter.id),
              )
              .map(toItem)
              .filter((i) => !q || i.text.toLocaleLowerCase().includes(q))
          }),
        scopes: (agentId) =>
          Effect.sync((): readonly MemoryScope[] => {
            const notes = new Map<string, number>()
            for (const r of rows(agentId))
              if (r.channel_id !== null) notes.set(r.channel_id, (notes.get(r.channel_id) ?? 0) + 1)
            const members = new Set(
              db
                .all<{ channel_id: string }>(
                  "SELECT channel_id FROM channel_member WHERE agent_id = ?",
                  agentId,
                )
                .map((m) => m.channel_id),
            )
            const out: MemoryScope[] = []
            for (const id of new Set([...notes.keys(), ...members])) {
              const name = channelName(id)
              if (name !== null)
                out.push({ id, name, notes: notes.get(id) ?? 0, member: members.has(id) })
            }
            return out.sort((a, b) => a.name.localeCompare(b.name))
          }),
        move: (id, channelId) =>
          Effect.gen(function* () {
            const row = itemRow(id)
            if (!row) return yield* new AppError({ code: "memory_not_found" })
            if (channelId !== null) {
              if (!channelExists(channelId))
                return yield* new AppError({ code: "channel_not_found" })
              // An item goes only to a channel that the agent is a member of.
              if (!isMember(row.agent_id, channelId))
                return yield* new AppError({ code: "memory_not_member" })
            }
            // The same place is no change: no new time, no history row.
            if (row.channel_id === channelId) return toItem(row)
            db.run(
              "UPDATE memory SET channel_id = ?, updated_at = ? WHERE id = ?",
              channelId,
              Date.now(),
              id,
            )
            record(row.agent_id, id, "user", "moved", row.source, null, row.text, null, {
              before: row.channel_id,
              after: channelId,
            })
            changed(row.agent_id)
            return toItem(itemRow(id) as Row)
          }),
        deleteChannel: (channelId) =>
          Effect.sync(() => {
            const notes = db.all<Row>("SELECT * FROM memory WHERE channel_id = ?", channelId)
            for (const note of notes) {
              db.run("DELETE FROM memory WHERE id = ?", note.id)
              record(
                note.agent_id,
                note.id,
                "channel_deleted",
                "deleted",
                note.source,
                note.text,
                null,
                null,
                { before: channelId, after: null },
              )
            }
            // A proposal for the channel stays: it is not memory, and the user decides. Save
            // makes a general item of it, because the channel is gone.
            for (const agentId of new Set(notes.map((n) => n.agent_id))) changed(agentId)
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
            record(row.agent_id, id, "user", "edited", row.source, row.text, value, null, {
              before: row.channel_id,
              after: row.channel_id,
            })
            changed(row.agent_id)
            return toItem(itemRow(id) as Row)
          }),
        remove: (id) =>
          Effect.sync(() => {
            const row = itemRow(id)
            if (!row) return
            db.run("DELETE FROM memory WHERE id = ?", id)
            record(row.agent_id, id, "user", "deleted", row.source, row.text, null, null, {
              before: row.channel_id,
              after: null,
            })
            changed(row.agent_id)
          }),
        forTurn: (agentId, message, channelId) => {
          const on = db.get<{ memory_enabled: number }>(
            "SELECT memory_enabled FROM agent WHERE id = ?",
            agentId,
          )
          if (on?.memory_enabled !== 1) return []
          return relevantMemory(readable(agentId, channelId).map(toItem), message)
        },

        plan: (agentId, text, channelId) =>
          Effect.sync((): MemoryPlan => {
            const d = decide(agentId, text, false, channelId ?? null)
            return d.kind === "refuse" ? d.result : { kind: d.kind }
          }),
        save: (agentId, text, origin, channelId) =>
          Effect.sync((): MemorySave => {
            const d = decide(agentId, text, false, channelId ?? null)
            if (d.kind === "refuse") return d.result
            if (d.kind === "item") {
              const saved = addItem(
                agentId,
                d.value,
                "agent",
                "agent",
                origin?.messageId ?? null,
                channelId ?? null,
              )
              return { kind: "saved", item: saved.item, historyId: saved.historyId }
            }
            return propose(agentId, d.value, origin ?? null, false, channelId ?? null)
          }),
        suggest: (agentId, text) =>
          Effect.sync((): MemorySave => {
            const d = decide(agentId, text, true)
            if (d.kind === "refuse") return d.result
            return propose(agentId, d.value, null, true)
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
            // A note for a channel that is gone becomes a general item: nothing is lost.
            const channelId =
              row.channel_id !== null && channelExists(row.channel_id) ? row.channel_id : null
            const saved = addItem(row.agent_id, value, "proposal", "proposal", null, channelId)
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
                { before: item.channel_id, after: null },
              )
            } else if (row.kind === "moved") {
              // Undo of "moved" puts the item back where it came from.
              const item = itemRow(row.memory_id) as Row
              db.run(
                "UPDATE memory SET channel_id = ?, updated_at = ? WHERE id = ?",
                row.channel_before,
                Date.now(),
                item.id,
              )
              made = record(
                agentId,
                item.id,
                "undo",
                "moved",
                item.source,
                null,
                item.text,
                row.id,
                { before: item.channel_id, after: row.channel_before },
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
                { before: item.channel_id, after: item.channel_id },
              )
            } else {
              // Undo of "deleted" makes the item again with its text. It is a new item, because a
              // deletion that sync carried stands for the old one (spec 019). A note comes back to
              // its channel when the channel is there. The delete of a channel makes a general
              // item (spec 008, "Channel notes").
              const back = row.old_text ?? ""
              const channelId =
                row.actor !== "channel_deleted" &&
                row.channel_before !== null &&
                channelExists(row.channel_before)
                  ? row.channel_before
                  : null
              const itemId = insertItem(agentId, back, row.source, null, channelId)
              made = record(agentId, itemId, "undo", "added", row.source, null, back, row.id, {
                before: null,
                after: channelId,
              })
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
