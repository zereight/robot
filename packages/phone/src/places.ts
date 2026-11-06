import { MESSAGE_PAGE } from "@robot/link"
import type { Place, PlaceSection } from "@robot/shared"

// Small helpers of the place list and the message lists. The app cannot load the runtime code of
// `@robot/shared` (it needs Effect), so the few rules that it needs are here.

/** The collapse key of "Unassigned". The same key as in the desktop list. */
export const UNASSIGNED_SECTION_ID = "unassigned:agents"

/** The built-in sections that the phone shows: Agents only. An older server also sends Channels. */
export const shownSections = (sections: readonly PlaceSection[] | null): readonly PlaceSection[] =>
  (sections ?? []).filter((s) => s.id === "agents")

/** Every place of a built-in section, in the order the list shows: user sections first. */
export const allPlaces = (section: PlaceSection): readonly Place[] => [
  ...section.sections.flatMap((s) => s.places),
  ...section.places,
]

/** What a collapsed header shows: the sum of the unread counts, and whether a place works. */
export const summarize = (places: readonly Place[]) => ({
  unread: places.reduce((sum, p) => sum + p.unread, 0),
  working: places.some((p) => p.working),
})

/** The unread count of a whole server, for the Servers screen. */
export const serverUnread = (sections: readonly PlaceSection[] | null) =>
  shownSections(sections).reduce((sum, s) => sum + summarize(allPlaces(s)).unread, 0)

interface Message {
  readonly id: string
  readonly createdAt: number
}

/** The newest messages, as many as one page of the cache (spec 012: 200). */
export const newest = <T extends Message>(list: readonly T[], limit = MESSAGE_PAGE) =>
  list.length > limit ? list.slice(list.length - limit) : list

/** A list with a new or changed message, in the order of time. */
export const upsertMessage = <T extends Message>(list: readonly T[], message: T): readonly T[] => {
  const at = list.findIndex((m) => m.id === message.id)
  if (at >= 0) return list.map((m, i) => (i === at ? message : m))
  const next = [...list, message]
  // A new message is almost always the newest one; sort only when it is not.
  const before = list.at(-1)
  return before && before.createdAt > message.createdAt
    ? next.sort((a, b) => a.createdAt - b.createdAt)
    : next
}

export const removeMessage = <T extends Message>(list: readonly T[], id: string) =>
  list.filter((m) => m.id !== id)
