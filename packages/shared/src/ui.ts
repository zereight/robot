import { Schema, Struct } from "effect"

export const PlaceKind = Schema.Literals(["agent", "channel"])
export type PlaceKind = typeof PlaceKind.Type

export const PlaceRef = Schema.Struct({ kind: PlaceKind, id: Schema.String })
export type PlaceRef = typeof PlaceRef.Type

export const Page = Schema.Literals(["chats", "workflows", "tasks", "usage", "help"])
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
  readonly kind: "local"
}

/** One row in the place list. */
export interface Place {
  readonly kind: PlaceKind
  readonly id: string
  readonly name: string
  readonly unread: number
  readonly working: boolean
  readonly lastMessage: string | null
}

/** A built-in place list section. */
export type SectionId = "channels" | "agents"

export interface PlaceSection {
  readonly id: SectionId
  readonly places: readonly Place[]
}

/** Keeps places whose name contains the query, ignoring case. */
export const filterPlaces = (sections: readonly PlaceSection[], query: string) => {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return sections
  return sections.map((s) => ({
    ...s,
    places: s.places.filter((p) => p.name.toLocaleLowerCase().includes(q)),
  }))
}
