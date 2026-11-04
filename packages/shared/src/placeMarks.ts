import { isOutsideSource, type OutsideSource } from "./outside.ts"
import type { SensitiveLabel } from "./sensitive.ts"
import type { PlaceRef } from "./ui.ts"

/**
 * A place that holds marks: a direct chat (the agent, which is its main thread), a thread of a
 * direct chat, or a channel (spec 007, "The mark of a place"). A thread is a place of its own, so a
 * new thread starts with no mark and a handover can give it the marks of another place.
 */
export type MarkPlace = PlaceRef | { readonly kind: "thread"; readonly id: string }

/**
 * The outside content that the next turns of a place hold (spec 007, "The mark of a place"): the
 * first source, and whether the content holds the program mark. A turn that gets outside content
 * (a page, a connection, a message of another agent, a hit of "search chats") sets it, because the
 * agent still sees the text in later turns. `program` is false for ordinary outside content.
 */
export interface PlaceOutside {
  readonly source: OutsideSource
  readonly program: boolean
}

/** True when a value has the shape of the outside mark of a place. Sync and the store use it. */
export const isPlaceOutside = (v: unknown): v is PlaceOutside => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return (
    Object.keys(o).every((k) => k === "source" || k === "program") &&
    typeof o.program === "boolean" &&
    isOutsideSource(o.source)
  )
}

/** The outside mark as a column stores it: JSON text, or null. Text that is no mark reads as none. */
export const parsePlaceOutside = (text: string | null | undefined): PlaceOutside | null => {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return isPlaceOutside(value) ? value : null
  } catch {
    return null
  }
}

/** The outside mark as a column stores it. */
export const placeOutsideText = (mark: PlaceOutside | null): string | null =>
  mark ? JSON.stringify(mark) : null

/**
 * The marks of one place, stored with the place and synced with it (spec 007, 019). A place holds
 * a mark when its next turn will hold what the mark names.
 *
 * - `outside`: the first source of outside content that the next turns hold, and the program
 *   mark (spec 007, "Outside content" and "Program mark"),
 * - `sensitive`: the label of the first credential place that a turn of this place read
 *   (spec 007, "Sensitive places").
 *
 * A new mark is a new field: the store, the carry and the header line walk over every field.
 */
export interface PlaceMarks {
  readonly outside: PlaceOutside | null
  readonly sensitive: SensitiveLabel | null
}

export const NO_MARKS: PlaceMarks = { outside: null, sensitive: null }

/** The name of every mark field. A new field of `PlaceMarks` fails to compile until it is listed. */
export const MARK_FIELDS = ["outside", "sensitive"] as const satisfies readonly (keyof PlaceMarks)[]

/** True when a place holds at least one mark. */
export const holdsMarks = (marks: PlaceMarks): boolean => MARK_FIELDS.some((f) => marks[f] !== null)

/** True when the next turns of a place hold the program mark. */
export const holdsProgramMark = (marks: PlaceMarks): boolean => marks.outside?.program === true

/** The kinds of mark that a place holds, in the order that the header line and the confirm show them. */
export const markKinds = (marks: PlaceMarks): readonly (typeof MARK_FIELDS)[number][] =>
  MARK_FIELDS.filter((f) => marks[f] !== null)

/**
 * The marks of a place, carried to another place: a handover gives the new thread the marks of
 * the place it came from (spec 003, 007). It copies every field.
 */
export const carriedMarks = (marks: PlaceMarks): PlaceMarks => ({ ...marks })

/**
 * The outside mark of a place that already holds `here`, after it gets `carried`: the first source
 * stays, and the place holds the program mark when either mark holds it.
 */
const mergedOutside = (here: PlaceOutside | null, carried: PlaceOutside | null) =>
  here && carried
    ? here.program === carried.program
      ? here
      : { source: here.source, program: here.program || carried.program }
    : (here ?? carried)

/**
 * The marks that a place holds after it gets `carried` marks: a mark that the place holds already
 * stays, and a mark that it holds not yet comes from `carried`.
 */
export const mergedMarks = (here: PlaceMarks, carried: PlaceMarks): PlaceMarks => ({
  outside: mergedOutside(here.outside, carried.outside),
  sensitive: here.sensitive ?? carried.sensitive,
})
