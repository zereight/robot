import { type MoveDirection, moveInOrder } from "./sections.ts"
import { allPlaces, type Place, type PlaceRef, type PlaceSection } from "./ui.ts"

/** The group "Pinned" holds at most this many places (spec 001, "Pinned places"). */
export const PINNED_MAX = 10

/** True when the group cannot take one more place. */
export const pinsFull = (count: number) => count >= PINNED_MAX

export const isPinned = (place: Place) => place.pinRank !== undefined

/** The places of the group "Pinned" of every built-in section, in the order of the group. */
export const pinnedPlaces = (sections: readonly PlaceSection[]): readonly Place[] =>
  sections
    .flatMap((s) => allPlaces(s))
    .filter(isPinned)
    .sort((a, b) => (a.pinRank as number) - (b.pinRank as number))

/**
 * The sections without the pinned places: a pinned place shows in its group only. A part with no
 * pinned place stays the same object, so a list that keeps rows by object does not redraw them.
 */
export const withoutPinned = (sections: readonly PlaceSection[]): readonly PlaceSection[] => {
  const rest = (places: readonly Place[]) =>
    places.some(isPinned) ? places.filter((p) => !isPinned(p)) : places
  return sections.map((s) => {
    const places = rest(s.places)
    const nested = s.sections.map((u) => {
      const kept = rest(u.places)
      return kept === u.places ? u : { ...u, places: kept }
    })
    const same = places === s.places && nested.every((u, i) => u === s.sections[i])
    return same ? s : { ...s, places, sections: nested }
  })
}

/**
 * Orders the items of one list: the ones with a position first, by position, then the others in the
 * order that they came in (by name). The sort is stable.
 */
export const orderByPosition = <T>(
  items: readonly T[],
  positionOf: (item: T) => number | null | undefined,
): T[] =>
  items
    .map((item, index) => ({ item, index, position: positionOf(item) ?? null }))
    .sort((a, b) => {
      if (a.position === null || b.position === null) {
        if (a.position === b.position) return a.index - b.index
        return a.position === null ? 1 : -1
      }
      return a.position - b.position || a.index - b.index
    })
    .map((x) => x.item)

/**
 * The list that holds a place, in the order that it shows: the group "Pinned", a user section,
 * "Unassigned", or the places of Channels that are in no section. Empty when the place is unknown.
 */
export const listOfPlace = (sections: readonly PlaceSection[], ref: PlaceRef): readonly Place[] => {
  const pinned = pinnedPlaces(sections)
  if (pinned.some((p) => p.kind === ref.kind && p.id === ref.id)) return pinned
  for (const section of sections) {
    for (const list of [section.places, ...section.sections.map((u) => u.places)]) {
      const rest = list.filter((p) => !isPinned(p))
      if (rest.some((p) => p.kind === ref.kind && p.id === ref.id)) return rest
    }
  }
  return []
}

const refOf = (place: Place): PlaceRef => ({ kind: place.kind, id: place.id })
const same = (a: PlaceRef, b: PlaceRef) => a.kind === b.kind && a.id === b.id

/** True when "Move up" or "Move down" does something for the place. */
export const canMovePlace = (
  list: readonly Place[],
  ref: PlaceRef,
  direction: MoveDirection,
): boolean => {
  const at = list.findIndex((p) => same(refOf(p), ref))
  if (at < 0) return false
  return direction === "up" ? at > 0 : at < list.length - 1
}

/** The list after one step up or down. At an end it is the same list. */
export const moveInList = (
  list: readonly Place[],
  ref: PlaceRef,
  direction: MoveDirection,
): readonly PlaceRef[] => {
  const key = (r: PlaceRef) => `${r.kind}:${r.id}`
  const keys = moveInOrder(
    list.map((p) => key(refOf(p))),
    key(ref),
    direction,
  )
  const byKey = new Map(list.map((p) => [key(refOf(p)), refOf(p)]))
  return keys.map((k) => byKey.get(k) as PlaceRef)
}

/**
 * The list after the place is dropped before another place of the list, or last when `before` is
 * null. A drop on the place itself changes nothing.
 */
export const dropInList = (
  list: readonly Place[],
  ref: PlaceRef,
  before: PlaceRef | null,
): readonly PlaceRef[] => {
  if (before && same(before, ref)) return list.map(refOf)
  const rest = list.map(refOf).filter((r) => !same(r, ref))
  const at = before ? rest.findIndex((r) => same(r, before)) : rest.length
  rest.splice(at < 0 ? rest.length : at, 0, ref)
  return rest
}
