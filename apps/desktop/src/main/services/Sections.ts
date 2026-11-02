import { randomUUID } from "node:crypto"
import {
  checkSectionName,
  type MoveDirection,
  moveInOrder,
  nameKey,
  type PlaceKind,
  type PlaceRef,
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
        changed(owner.server_id, place.kind)
        if (place.kind === "channel") bus.emit("channels.changed", { channelId: place.id })
      })

      return Sections.of({
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
