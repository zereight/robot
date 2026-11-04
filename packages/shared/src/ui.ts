import { Schema, Struct } from "effect"
import type { LinkState } from "./link.ts"

export const PlaceKind = Schema.Literals(["agent", "channel"])
export type PlaceKind = typeof PlaceKind.Type

export const PlaceRef = Schema.Struct({ kind: PlaceKind, id: Schema.String })
export type PlaceRef = typeof PlaceRef.Type

export const Page = Schema.Literals(["chats", "today", "workflows", "tasks", "usage", "help"])
export type Page = typeof Page.Type

export const PLACE_LIST_MIN = 200
export const PLACE_LIST_MAX = 400
export const PLACE_LIST_DEFAULT = 240
export const NARROW_WIDTH = 800

/** Window layout state that the app keeps between runs. */
export const UiState = Schema.Struct({
  serverId: Schema.NullOr(Schema.String),
  page: Page,
  /** The open place of each server, by server id. */
  places: Schema.Record(Schema.String, PlaceRef),
  /** Ids of collapsed place list sections. */
  collapsed: Schema.Array(Schema.String),
  activityPanel: Schema.Boolean,
  placeListWidth: Schema.Number.check(
    Schema.isBetween({ minimum: PLACE_LIST_MIN, maximum: PLACE_LIST_MAX }),
  ),
})
export type UiState = typeof UiState.Type

export const UiStatePatch = UiState.mapFields(Struct.map(Schema.optionalKey))
export type UiStatePatch = typeof UiStatePatch.Type

export const defaultUiState: UiState = {
  serverId: null,
  page: "chats",
  places: {},
  collapsed: [],
  activityPanel: true,
  placeListWidth: PLACE_LIST_DEFAULT,
}

export const clampPlaceListWidth = (width: number) =>
  Math.round(Math.min(PLACE_LIST_MAX, Math.max(PLACE_LIST_MIN, width)))

export interface Server {
  readonly id: string
  readonly name: string
  /** `local` is this computer. `linked` is another computer that this one opens (spec 012). */
  readonly kind: "local" | "linked"
  /** The link of a linked server: the id that "Remove" in Settings > Devices uses. */
  readonly linkId?: string
  /** The connection state of a linked server. Absent for this computer. */
  readonly state?: LinkState
  /** Which side must update the app, when the state is `update_app`. */
  readonly updateSide?: "this" | "server" | null
  /**
   * True when the server is online and lets this device create and change agents (spec 012). The
   * plus buttons and the fields of agents and channels show only then. Absent for this computer.
   */
  readonly canChange?: boolean
}

/** One row in the place list. */
export interface Place {
  readonly kind: PlaceKind
  readonly id: string
  readonly name: string
  readonly unread: number
  readonly working: boolean
  readonly lastMessage: string | null
  /** The user section that holds the place, or null for "No section". */
  readonly sectionId: string | null
  /**
   * The role line of an agent (spec 001, "Place rows"). A channel has none. It is absent for an
   * agent with no role line, and from a computer that does not send it yet, so a reader treats
   * absent as empty (spec 012). It is text of the user and is not translated.
   */
  readonly role?: string
}

/** A built-in place list section. */
export type SectionId = "channels" | "agents"

/** The built-in section that holds places of a kind. */
export const builtInSection = (kind: PlaceKind): SectionId =>
  kind === "agent" ? "agents" : "channels"

/** The kind of place that a built-in section holds. */
export const sectionKind = (id: SectionId): PlaceKind => (id === "agents" ? "agent" : "channel")

/** A section that the user made, with the places in it. */
export interface UserSectionView {
  readonly id: string
  /** Text of the user. It is not translated. */
  readonly name: string
  readonly places: readonly Place[]
}

export interface PlaceSection {
  readonly id: SectionId
  /** The places that are in no user section. They show first. */
  readonly places: readonly Place[]
  /** The user sections, in the order the user set. They show after the places above. */
  readonly sections: readonly UserSectionView[]
}

/** Every place of a built-in section, also those in its user sections. */
export const allPlaces = (section: PlaceSection): readonly Place[] => [
  ...section.places,
  ...section.sections.flatMap((s) => s.places),
]

export interface SectionSummary {
  readonly unread: number
  readonly working: boolean
}

/** What a collapsed header shows: the sum of the unread counts, and whether a place works. */
export const summarize = (places: readonly Place[]): SectionSummary => ({
  unread: places.reduce((sum, p) => sum + p.unread, 0),
  working: places.some((p) => p.working),
})

/**
 * True when the typed text is a part of the name of the place, or, for an agent, a part of its
 * role line, ignoring case. A channel has no role line, so only its name counts.
 */
export const placeMatches = (place: Place, query: string) => {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return true
  if (place.name.toLocaleLowerCase().includes(q)) return true
  return place.kind === "agent" && !!place.role && place.role.toLocaleLowerCase().includes(q)
}

/**
 * Keeps places whose name contains the query, or, for an agent, whose role line contains it,
 * ignoring case. A user section with no match leaves the list. The order of sections and places
 * does not change.
 */
export const filterPlaces = (sections: readonly PlaceSection[], query: string) => {
  if (!query.trim()) return sections
  const keep = (places: readonly Place[]) => places.filter((p) => placeMatches(p, query))
  return sections.map(
    (s): PlaceSection => ({
      ...s,
      places: keep(s.places),
      sections: s.sections
        .map((u) => ({ ...u, places: keep(u.places) }))
        .filter((u) => u.places.length > 0),
    }),
  )
}
