import type { SensitiveLabel } from "./sensitive.ts"
import type { PlaceRef } from "./ui.ts"

/**
 * A place that holds marks: a direct chat (the agent, which is its main thread), a thread of a
 * direct chat, or a channel (spec 007, "The mark of a place"). A thread is a place of its own, so a
 * new thread starts with no mark and a handover can give it the marks of another place.
 */
export type MarkPlace = PlaceRef | { readonly kind: "thread"; readonly id: string }

/**
 * The marks of one place, stored with the place and synced with it (spec 007, 019). A place holds
 * a mark when its next turn will hold what the mark names.
 *
 * - `sensitive`: the label of the first credential place that a turn of this place read
 *   (spec 007, "Sensitive places").
 *
 * The mark of outside content joins here when the place carries it (spec 007, "Outside content").
 * A new mark is a new field: the store, the carry and the header line walk over every field.
 */
export interface PlaceMarks {
  readonly sensitive: SensitiveLabel | null
}

export const NO_MARKS: PlaceMarks = { sensitive: null }

/** The name of every mark field. A new field of `PlaceMarks` fails to compile until it is listed. */
export const MARK_FIELDS = ["sensitive"] as const satisfies readonly (keyof PlaceMarks)[]

/** True when a place holds at least one mark. */
export const holdsMarks = (marks: PlaceMarks): boolean => MARK_FIELDS.some((f) => marks[f] !== null)

/** The kinds of mark that a place holds, in the order that the header line and the confirm show them. */
export const markKinds = (marks: PlaceMarks): readonly (typeof MARK_FIELDS)[number][] =>
  MARK_FIELDS.filter((f) => marks[f] !== null)

/**
 * The marks of a place, carried to another place: a handover gives the new thread the marks of
 * the place it came from (spec 003, 007). It copies every field.
 */
export const carriedMarks = (marks: PlaceMarks): PlaceMarks => ({ ...marks })

/**
 * The marks that a place holds after it gets `carried` marks: a mark that the place holds already
 * stays, and a mark that it holds not yet comes from `carried`.
 */
export const mergedMarks = (here: PlaceMarks, carried: PlaceMarks): PlaceMarks =>
  Object.fromEntries(MARK_FIELDS.map((f) => [f, here[f] ?? carried[f]])) as unknown as PlaceMarks
