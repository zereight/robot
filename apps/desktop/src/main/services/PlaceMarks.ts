import {
  carriedMarks,
  holdsMarks,
  isSensitiveLabel,
  MARK_FIELDS,
  type MarkPlace,
  type PlaceMarks as Marks,
  mergedMarks,
  NO_MARKS,
  type OutsideSource,
  parsePlaceOutside,
  placeOutsideText,
  type SensitiveLabel,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

export interface PlaceMarksService {
  /** The marks that the place holds now. A place that does not exist holds none. */
  get(place: MarkPlace): Marks
  /**
   * A turn of the place read a credential place (spec 007, "Sensitive places"). The first label
   * stays: a later read does not change it, and a turn that read before it keeps its label.
   */
  holdSensitive(place: MarkPlace, label: SensitiveLabel): void
  /**
   * A turn of the place holds the program mark (spec 007, "Program mark"). The next turns of the
   * place hold outside content with the program mark, until "Clear". The first source stays.
   */
  holdProgram(place: MarkPlace, source: OutsideSource): void
  /**
   * "Clear": removes every mark of the place for the next turns (spec 007, "The mark of a place").
   * It gives back the marks that it removed. A running turn keeps its own marks.
   */
  clear(place: MarkPlace): Marks
  /**
   * Copies every mark of one place to another place, which holds them from now on. A handover
   * (spec 003) gives the new thread the marks of the place it came from. A mark that the target
   * holds already stays.
   */
  carry(from: MarkPlace, to: MarkPlace): void
}

const TABLE: Readonly<Record<MarkPlace["kind"], string>> = {
  agent: "agent",
  channel: "channel",
  thread: "thread",
}

/**
 * The column of each mark field. A new field of the marks fails to compile until it has a column
 * here, so the store, the clear and the carry cover it with no other change.
 */
const COLUMN = {
  outside: "outside_mark",
  sensitive: "sensitive_mark",
} as const satisfies Record<keyof Marks, string>

/** The value of one mark field as the column stores it. */
const stored = (marks: Marks, field: keyof Marks): string | null =>
  field === "outside" ? placeOutsideText(marks.outside) : marks[field]

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

      const read = (place: MarkPlace): Marks => {
        const row = db.get<Record<string, string | null>>(
          `SELECT ${MARK_FIELDS.map((f) => COLUMN[f]).join(", ")} FROM ${TABLE[place.kind]} WHERE id = ?`,
          place.id,
        )
        if (!row) return NO_MARKS
        const sensitive = row[COLUMN.sensitive]
        return {
          outside: parsePlaceOutside(row[COLUMN.outside]),
          sensitive: isSensitiveLabel(sensitive) ? sensitive : null,
        } satisfies Marks
      }

      /** Writes the marks. The time of the place moves, so sync stamps the change as new. */
      const write = (place: MarkPlace, marks: Marks) => {
        db.run(
          `UPDATE ${TABLE[place.kind]} SET ${MARK_FIELDS.map((f) => `${COLUMN[f]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          ...MARK_FIELDS.map((f) => stored(marks, f)),
          Date.now(),
          place.id,
        )
        // The header line of the place and the lists of the window read the marks again.
        if (place.kind === "channel") bus.emit("channels.changed", { channelId: place.id })
        else if (place.kind === "thread") {
          const row = db.get<{ agent_id: string }>(
            "SELECT agent_id FROM thread WHERE id = ?",
            place.id,
          )
          if (row) bus.emit("chat.threads", { agentId: row.agent_id })
        } else {
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
          const here = read(place)
          if (here.sensitive !== null) return
          write(place, { ...here, sensitive: label })
        },
        holdProgram: (place, source) => {
          const here = read(place)
          if (here.outside?.program) return
          write(place, {
            ...here,
            outside: { source: here.outside?.source ?? source, program: true },
          })
        },
        clear: (place) => {
          const before = read(place)
          if (holdsMarks(before)) write(place, NO_MARKS)
          return before
        },
        carry: (from, to) => {
          const here = read(to)
          const next = mergedMarks(here, carriedMarks(read(from)))
          if (MARK_FIELDS.some((f) => next[f] !== here[f])) write(to, next)
        },
      })
    }),
  )
}
