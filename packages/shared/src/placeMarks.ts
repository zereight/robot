import type { SensitiveLabel } from "./sensitive.ts"

// A place that holds marks is a direct chat (the agent) or a channel: `PlaceRef` of `ui.ts`. A
// later slice adds the thread, which is a place too.

/**
 * The marks of one place, stored with the place and synced with it (spec 007, 019). A place holds
 * a mark when its next turn will hold what the mark names.
 *
 * - `sensitive`: the label of the first credential place that a turn of this place read
 *   (spec 007, "Sensitive places").
 *
 * The mark of outside content joins here when the place carries it (spec 007, "Outside content").
 */
export interface PlaceMarks {
  readonly sensitive: SensitiveLabel | null
}

export const NO_MARKS: PlaceMarks = { sensitive: null }

/** True when a place holds at least one mark. */
export const holdsMarks = (marks: PlaceMarks): boolean => marks.sensitive !== null

/** The kinds of mark that a place holds, in the order that the header line and the confirm show them. */
export const markKinds = (marks: PlaceMarks): readonly "sensitive"[] =>
  marks.sensitive === null ? [] : ["sensitive"]

/** The marks of a place, carried to another place: a new thread or a handover copies them (spec 003). */
export const carriedMarks = (marks: PlaceMarks): PlaceMarks => ({ sensitive: marks.sensitive })
