import { randomUUID } from "node:crypto"
import {
  checkSectionName,
  type MoveDirection,
  moveInOrder,
  nameKey,
  orderByPosition,
  type PlaceKind,
  type PlaceRef,
  pinsFull,
  type SectionCreate,
  sectionsFull,
  type UserSection,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"

interface SectionRow {
  id: string
  server_id: string
  kind: PlaceKind
  name: string
  position: number
}

export interface SectionsService {
  /** Every user section of a server: agent sections, then channel sections, each in order. */
  list(serverId: string): Effect.Effect<readonly UserSection[]>
  create(input: SectionCreate): Effect.Effect<UserSection, AppError>
  rename(id: string, name: string): Effect.Effect<UserSection, AppError>
  /** One step up or down among the sections of its kind. At an end it changes nothing. */
  move(id: string, direction: MoveDirection): Effect.Effect<void, AppError>
  /** Deletes a section. Its places move to "No section". No place is deleted. */
  remove(id: string): Effect.Effect<void, AppError>
  /** Puts a place in a section, or in none (`null`). */
  assign(place: PlaceRef, sectionId: string | null): Effect.Effect<void, AppError>
  /** Pins a place to the group "Pinned", or unpins it. It comes last in the list that it joins. */
  pin(place: PlaceRef, pinned: boolean): Effect.Effect<void, AppError>
  /** Puts a place last in the list that it is in now. A move to another section calls it. */
  last(place: PlaceRef): Effect.Effect<void>
  /** Sets the order of one list: each place gets the spot of its index. */
  order(items: readonly PlaceRef[]): Effect.Effect<void, AppError>
  /**
   * Checks that a place of `kind` on `serverId` may join the section. `null` always passes.
   * Returns the id to store.
   */
  check(
    serverId: string,
    kind: PlaceKind,
    sectionId: string | null,
  ): Effect.Effect<string | null, AppError>
}

const toSection = (row: SectionRow): UserSection => ({
  id: row.id,
  serverId: row.server_id,
  kind: row.kind,
  name: row.name,
  position: row.position,
})

/** The sections that users make inside Channels and Agents, and which places are in them. */
export class Sections extends Context.Service<Sections, SectionsService>()("robot/main/Sections") {
  static readonly layer = Layer.effect(
    Sections,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus

      const row = (id: string) =>
        db.get<SectionRow>(
          "SELECT id, server_id, kind, name, position FROM place_section WHERE id = ?",
          id,
        )
      const findRow = (id: string) =>
        Effect.suspend(() => {
          const found = row(id)
          return found
            ? Effect.succeed(found)
            : Effect.fail(new AppError({ code: "section_not_found" }))
        })
      const ofKind = (serverId: string, kind: PlaceKind) =>
        db.all<SectionRow>(
          `SELECT id, server_id, kind, name, position FROM place_section
           WHERE server_id = ? AND kind = ? ORDER BY position, created_at`,
          serverId,
          kind,
        )

      const tableOf = (kind: PlaceKind) => (kind === "agent" ? "agent" : "channel")
      const missing = (kind: PlaceKind) =>
        new AppError({ code: kind === "agent" ? "agent_not_found" : "channel_not_found" })

      interface PlaceRow {
        server_id: string
        pinned: number
        place_section_id: string | null
      }
      const placeRow = (place: PlaceRef) =>
        db.get<PlaceRow>(
          `SELECT server_id, pinned, place_section_id FROM ${tableOf(place.kind)} WHERE id = ?`,
          place.id,
        )

      /**
       * The places of the list that holds a place, in the order that they show: the ones with a
       * position first, then the others by name. A pinned place is in the group "Pinned", whatever
       * its section is.
       */
      const listOf = (place: PlaceRef, row: PlaceRow): PlaceRef[] => {
        const pick = (kind: PlaceKind, where: string, ...args: (string | null)[]) =>
          db
            .all<{ id: string; place_position: number | null }>(
              `SELECT id, place_position FROM ${tableOf(kind)} WHERE server_id = ? AND ${where}
               ${kind === "agent" ? "AND archived_at IS NULL" : ""} ORDER BY name_key`,
              row.server_id,
              ...args,
            )
            .map((r) => ({ kind, ...r }))
        const rows =
          row.pinned === 1
            ? [...pick("agent", "pinned = 1"), ...pick("channel", "pinned = 1")]
            : pick(place.kind, "pinned = 0 AND place_section_id IS ?", row.place_section_id)
        return orderByPosition(rows, (r) => r.place_position).map((r) => ({
          kind: r.kind,
          id: r.id,
        }))
      }

      /** Writes the spots of a list. */
      const write = (items: readonly PlaceRef[]) =>
        db.transaction(() => {
          for (const [index, item] of items.entries())
            db.run(
              `UPDATE ${tableOf(item.kind)} SET place_position = ? WHERE id = ?`,
              index,
              item.id,
            )
        })

      /** Puts a place last in the list that it is in now (after a move to another list). */
      const putLast = (place: PlaceRef) => {
        const row = placeRow(place)
        if (!row) return
        const others = listOf(place, row).filter(
          (p) => !(p.kind === place.kind && p.id === place.id),
        )
        write([...others, place])
      }

      /** Tells every list that shows places that something changed. */
      const changed = (serverId: string, kind: PlaceKind) => {
        bus.emit("places.changed", { serverId })
        if (kind === "agent") bus.emit("agents.changed", { serverId })
      }

      /** Checks a name against the others of the same kind. Returns the trimmed name. */
      const goodName = (serverId: string, kind: PlaceKind, name: string, exceptId: string) => {
        const others = ofKind(serverId, kind)
          .filter((s) => s.id !== exceptId)
          .map((s) => s.name)
        const problem = checkSectionName(name, others)
        if (problem === "taken") return Effect.fail(new AppError({ code: "section_name_taken" }))
        if (problem) return Effect.fail(new AppError({ code: "section_name_invalid" }))
        return Effect.succeed(name.trim())
      }

      const create = Effect.fn("Sections.create")(function* (input: SectionCreate) {
        const server = db.get("SELECT 1 AS x FROM server WHERE id = ?", input.serverId)
        if (!server) return yield* new AppError({ code: "invalid_input" })
        const name = yield* goodName(input.serverId, input.kind, input.name, "")
        const existing = ofKind(input.serverId, input.kind)
        if (sectionsFull(existing.length)) return yield* new AppError({ code: "section_limit" })
        const id = randomUUID()
        // A new section is last.
        const position = existing.reduce((max, s) => Math.max(max, s.position + 1), 0)
        db.run(
          `INSERT INTO place_section (id, server_id, kind, name, name_key, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.serverId,
          input.kind,
          name,
          nameKey(name),
          position,
          Date.now(),
        )
        changed(input.serverId, input.kind)
        return toSection(row(id) as SectionRow)
      })

      const rename = Effect.fn("Sections.rename")(function* (id: string, name: string) {
        const found = yield* findRow(id)
        const next = yield* goodName(found.server_id, found.kind, name, id)
        db.run(
          "UPDATE place_section SET name = ?, name_key = ? WHERE id = ?",
          next,
          nameKey(next),
          id,
        )
        changed(found.server_id, found.kind)
        return toSection(row(id) as SectionRow)
      })

      const move = Effect.fn("Sections.move")(function* (id: string, direction: MoveDirection) {
        const found = yield* findRow(id)
        const ids = ofKind(found.server_id, found.kind).map((s) => s.id)
        const next = moveInOrder(ids, id, direction)
        if (next === ids) return
        db.transaction(() => {
          for (const [position, sectionId] of next.entries())
            db.run("UPDATE place_section SET position = ? WHERE id = ?", position, sectionId)
        })
        changed(found.server_id, found.kind)
      })

      const remove = Effect.fn("Sections.remove")(function* (id: string) {
        const found = yield* findRow(id)
        db.transaction(() => {
          // The places move out first. The database also clears them if this were missed.
          db.run("UPDATE agent SET place_section_id = NULL WHERE place_section_id = ?", id)
          db.run("UPDATE channel SET place_section_id = NULL WHERE place_section_id = ?", id)
          db.run("DELETE FROM place_section WHERE id = ?", id)
        })
        changed(found.server_id, found.kind)
      })

      const check = (serverId: string, kind: PlaceKind, sectionId: string | null) =>
        Effect.suspend(() => {
          if (sectionId === null) return Effect.succeed(null)
          const found = row(sectionId)
          if (!found || found.server_id !== serverId)
            return Effect.fail(new AppError({ code: "section_not_found" }))
          if (found.kind !== kind)
            return Effect.fail(new AppError({ code: "section_kind_mismatch" }))
          return Effect.succeed(sectionId)
        })

      const assign = Effect.fn("Sections.assign")(function* (
        place: PlaceRef,
        sectionId: string | null,
      ) {
        const table = place.kind === "agent" ? "agent" : "channel"
        const owner = db.get<{ server_id: string }>(
          `SELECT server_id FROM ${table} WHERE id = ?`,
          place.id,
        )
        if (!owner)
          return yield* new AppError({
            code: place.kind === "agent" ? "agent_not_found" : "channel_not_found",
          })
        const stored = yield* check(owner.server_id, place.kind, sectionId)
        db.run(`UPDATE ${table} SET place_section_id = ? WHERE id = ?`, stored, place.id)
        // A place comes last in its new section. A pinned place keeps its spot in "Pinned".
        if (placeRow(place)?.pinned === 0) putLast(place)
        changed(owner.server_id, place.kind)
        if (place.kind === "channel") bus.emit("channels.changed", { channelId: place.id })
      })

      const pin = Effect.fn("Sections.pin")(function* (place: PlaceRef, pinned: boolean) {
        const row = placeRow(place)
        if (!row) return yield* missing(place.kind)
        if (row.pinned === (pinned ? 1 : 0)) return
        if (pinned) {
          const count = db.get<{ n: number }>(
            `SELECT (SELECT COUNT(*) FROM agent WHERE server_id = ?1 AND pinned = 1 AND archived_at IS NULL)
                  + (SELECT COUNT(*) FROM channel WHERE server_id = ?1 AND pinned = 1) AS n`,
            row.server_id,
          )?.n
          if (pinsFull(count ?? 0)) return yield* new AppError({ code: "pin_limit" })
        }
        db.run(
          `UPDATE ${tableOf(place.kind)} SET pinned = ? WHERE id = ?`,
          pinned ? 1 : 0,
          place.id,
        )
        putLast(place)
        changed(row.server_id, place.kind)
        if (place.kind === "channel") bus.emit("channels.changed", { channelId: place.id })
      })

      const order = Effect.fn("Sections.order")(function* (items: readonly PlaceRef[]) {
        if (items.length === 0 || items.length > 1000)
          return yield* new AppError({ code: "invalid_input" })
        const rows = items.map((item) => placeRow(item))
        for (const [index, row] of rows.entries())
          if (!row) return yield* missing((items[index] as PlaceRef).kind)
        const serverId = rows[0]?.server_id
        if (rows.some((row) => row?.server_id !== serverId))
          return yield* new AppError({ code: "invalid_input" })
        write(items)
        for (const kind of new Set(items.map((i) => i.kind))) changed(serverId as string, kind)
      })

      return Sections.of({
        pin,
        order,
        last: (place) => Effect.sync(() => putLast(place)),
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<SectionRow>(
                `SELECT id, server_id, kind, name, position FROM place_section
                 WHERE server_id = ? ORDER BY kind, position, created_at`,
                serverId,
              )
              .map(toSection),
          ),
        create,
        rename,
        move,
        remove,
        assign,
        check,
      })
    }),
  )
}
