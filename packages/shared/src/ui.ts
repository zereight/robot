import { Schema, Struct } from "effect"
import type { LinkState } from "./link.ts"

export const PlaceKind = Schema.Literals(["agent"])
export type PlaceKind = typeof PlaceKind.Type

export const PlaceRef = Schema.Struct({ kind: PlaceKind, id: Schema.String })
export type PlaceRef = typeof PlaceRef.Type

export const Page = Schema.Literals(["chats", "workflows", "routines", "tasks", "usage", "help"])
export type Page = typeof Page.Type

/** The page that shows this list. Routines and workflows are separate pages (spec 001). */
export const listPage = (kind: "routine" | "workflow") =>
  kind === "routine" ? "routines" : "workflows"

export const PLACE_LIST_MIN = 200
export const PLACE_LIST_MAX = 400
export const PLACE_LIST_DEFAULT = 240
export const NARROW_WIDTH = 800

/** The side column of the workflow editor holds the panel of a node and the list of runs. */
export const WORKFLOW_SIDE_MIN = 240
export const WORKFLOW_SIDE_MAX = 720
export const WORKFLOW_SIDE_DEFAULT = 340
/** The canvas of the workflow editor keeps at least this width, so a wide column never hides it. */
export const WORKFLOW_CANVAS_MIN = 240
/** The width of the drag handle between the canvas and the side column. */
export const WORKFLOW_HANDLE_WIDTH = 6

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
  /** The width of the side column of the workflow editor, in px. */
  workflowSideWidth: Schema.Number.check(
    Schema.isBetween({ minimum: WORKFLOW_SIDE_MIN, maximum: WORKFLOW_SIDE_MAX }),
  ),
  /** The open tab of the Tasks page: the tasks, or the events (spec 038). */
  tasksTab: Schema.Literals(["tasks", "events"]),
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
  workflowSideWidth: WORKFLOW_SIDE_DEFAULT,
  tasksTab: "tasks",
}

export const clampPlaceListWidth = (width: number) =>
  Math.round(Math.min(PLACE_LIST_MAX, Math.max(PLACE_LIST_MIN, width)))

/**
 * Keeps the width of the workflow side column inside the limits. `available` is the width of the
 * whole workspace, when it is known: a small window gives the column less than the highest width,
 * and never less than the lowest.
 */
export const clampWorkflowSideWidth = (width: number, available?: number) => {
  const room =
    available === undefined
      ? WORKFLOW_SIDE_MAX
      : available - WORKFLOW_CANVAS_MIN - WORKFLOW_HANDLE_WIDTH
  const max = Math.max(WORKFLOW_SIDE_MIN, Math.min(WORKFLOW_SIDE_MAX, room))
  return Math.round(Math.min(max, Math.max(WORKFLOW_SIDE_MIN, width)))
}

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
   * plus buttons and the fields of agents show only then. Absent for this computer.
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
   * The role line of an agent (spec 001, "Place rows"). It is absent for an
   * agent with no role line, and from a computer that does not send it yet, so a reader treats
   * absent as empty (spec 012). It is text of the user and is not translated.
   */
  readonly role?: string
  /**
   * The spot in the group "Pinned" (0 is first), or absent when the place is not pinned (spec 001,
   * "Pinned places"). A pinned place also stays in its section here, so a reader that does not know
   * the group (the phone) shows it there. A reader that knows it uses `pinnedPlaces`.
   */
  readonly pinRank?: number
}

/** A built-in place list section. */
export type SectionId = "agents"

/** The built-in section that holds places of a kind. */
export const builtInSection = (_kind: PlaceKind): SectionId => "agents"

/** The kind of place that a built-in section holds. */
export const sectionKind = (_id: SectionId): PlaceKind => "agent"

/** A section that the user made, with the places in it. */
export interface UserSectionView {
  readonly id: string
  /** Text of the user. It is not translated. */
  readonly name: string
  readonly places: readonly Place[]
}

export interface PlaceSection {
  readonly id: SectionId
  /** The places that are in no user section. They show last, in the section "Unassigned". */
  readonly places: readonly Place[]
  /** The user sections, in the order the user set. */
  readonly sections: readonly UserSectionView[]
}

/** The collapse key of "Unassigned". It is not the id of a user section. */
export const UNASSIGNED_SECTION_ID = "unassigned:agents"

/** True when places with no section show before the user sections. Agents show them last. */
export const loosePlacesFirst = (_id: SectionId) => false

/** Every place of a built-in section, in the order the list shows. */
export const allPlaces = (section: PlaceSection): readonly Place[] => {
  const nested = section.sections.flatMap((s) => s.places)
  return loosePlacesFirst(section.id)
    ? [...section.places, ...nested]
    : [...nested, ...section.places]
}

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
 * True when the typed text is a part of the name of the place, or a part of the role line of the
 * agent, ignoring case.
 */
export const placeMatches = (place: Place, query: string) => {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return true
  if (place.name.toLocaleLowerCase().includes(q)) return true
  return place.role?.toLocaleLowerCase().includes(q) ?? false
}

/**
 * Keeps places whose name or role line contains the query, ignoring case. A user section with no
 * match leaves the list. The order of sections and places does not change.
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
