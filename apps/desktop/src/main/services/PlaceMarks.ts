import {
  carriedMarks,
  isSensitiveLabel,
  type PlaceMarks as Marks,
  NO_MARKS,
  type PlaceRef,
  type SensitiveLabel,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

export interface PlaceMarksService {
  /** The marks that the place holds now. A place that does not exist holds none. */
  get(place: PlaceRef): Marks
  /**
   * A turn of the place read a credential place (spec 007, "Sensitive places"). The first label
   * stays: a later read does not change it, and a turn that read before it keeps its label.
   */
  holdSensitive(place: PlaceRef, label: SensitiveLabel): void
  /**
   * "Clear": removes every mark of the place for the next turns (spec 007, "The mark of a place").
   * It gives back the marks that it removed. A running turn keeps its own marks.
   */
  clear(place: PlaceRef): Marks
  /**
   * Copies the marks of one place to another place, which holds them from now on. A handover
   * (spec 003) gives the new thread the marks of the place it came from. A mark that the target
   * holds already stays.
   */
  carry(from: PlaceRef, to: PlaceRef): void
}

const TABLE: Readonly<Record<PlaceRef["kind"], string>> = { agent: "agent", channel: "channel" }

/**
 * The marks of a place (spec 007): the one place in the code where a mark is read, set, cleared
 * or carried. A mark is stored with the place and syncs with it (spec 019).
 */
export class PlaceMarks extends Context.Service<PlaceMarks, PlaceMarksService>()(
  "robot/main/PlaceMarks",
) {
  static readonly layer = Layer.effect(
    PlaceMarks,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus

      const read = (place: PlaceRef): Marks => {
        const row = db.get<{ sensitive_mark: string | null }>(
          `SELECT sensitive_mark FROM ${TABLE[place.kind]} WHERE id = ?`,
          place.id,
        )
        return row && isSensitiveLabel(row.sensitive_mark)
          ? { sensitive: row.sensitive_mark }
          : NO_MARKS
      }

      /** Writes the marks. The time of the place moves, so sync stamps the change as new. */
      const write = (place: PlaceRef, marks: Marks) => {
        db.run(
          `UPDATE ${TABLE[place.kind]} SET sensitive_mark = ?, updated_at = ? WHERE id = ?`,
          marks.sensitive,
          Date.now(),
          place.id,
        )
        // The header line of the place and the lists of the window read the marks again.
        if (place.kind === "channel") bus.emit("channels.changed", { channelId: place.id })
        else {
          const row = db.get<{ server_id: string }>(
            "SELECT server_id FROM agent WHERE id = ?",
            place.id,
          )
          if (row) bus.emit("agents.changed", { serverId: row.server_id })
        }
      }

      return PlaceMarks.of({
        get: read,
        holdSensitive: (place, label) => {
          if (read(place).sensitive !== null) return
          write(place, { sensitive: label })
        },
        clear: (place) => {
          const before = read(place)
          if (before.sensitive !== null) write(place, NO_MARKS)
          return before
        },
        carry: (from, to) => {
          const marks = carriedMarks(read(from))
          const here = read(to)
          const next: Marks = { sensitive: here.sensitive ?? marks.sensitive }
          if (next.sensitive !== here.sensitive) write(to, next)
        },
      })
    }),
  )
}
