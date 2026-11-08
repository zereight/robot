import { Schema, Struct } from "effect"
import type { LinkState } from "./link.ts"

export const PlaceKind = Schema.Literals(["workflow"])
export type PlaceKind = typeof PlaceKind.Type

export const PlaceRef = Schema.Struct({ kind: PlaceKind, id: Schema.String })
export type PlaceRef = typeof PlaceRef.Type

/** The app opens on the workflow list (spec 001). */
export const Page = Schema.Literals(["workflows", "tasks", "help"])
export type Page = typeof Page.Type

export const PLACE_LIST_MIN = 200
export const PLACE_LIST_MAX = 400
export const PLACE_LIST_DEFAULT = 240
export const NARROW_WIDTH = 800
/** The workflow list docks at this window width and wider; below it opens as an overlay. */
export const LIST_DOCK_MIN = 1100

/** The side column of the workflow editor holds the panel of a node and the list of runs. */
export const WORKFLOW_SIDE_MIN = 240
export const WORKFLOW_SIDE_MAX = 720
export const WORKFLOW_SIDE_DEFAULT = 340
/** The panel column of the studio: the chat of the open workflow (spec 001). */
export const PANEL_MIN = 320
export const PANEL_MAX = 720
export const PANEL_DEFAULT = 360
/** The canvas of the workflow editor keeps at least this width, so a wide column never hides it. */
export const WORKFLOW_CANVAS_MIN = 240
/** The width of the drag handle between the canvas and the side column. */
export const WORKFLOW_HANDLE_WIDTH = 6

/** Window layout state that the app keeps between runs. */
export const UiState = Schema.Struct({
  serverId: Schema.NullOr(Schema.String),
  page: Page,
  /** The open workflow of each server, by server id. */
  places: Schema.Record(Schema.String, PlaceRef),
  /** The panel column of the studio is open (spec 001). The name is from the earlier panel. */
  activityPanel: Schema.Boolean,
  /** The tab of the Tasks page: "Tasks" or "Events" (spec 005, 038). It stays after a restart. */
  tasksTab: Schema.Literals(["tasks", "events"]),
  placeListWidth: Schema.Number.check(
    Schema.isBetween({ minimum: PLACE_LIST_MIN, maximum: PLACE_LIST_MAX }),
  ),
  /** The width of the side column of the workflow editor, in px. */
  workflowSideWidth: Schema.Number.check(
    Schema.isBetween({ minimum: WORKFLOW_SIDE_MIN, maximum: WORKFLOW_SIDE_MAX }),
  ),
  /** The run strip is folded to its tab row, so the canvas gets the height (spec 001). */
  stripFolded: Schema.Boolean,
  /** The node panel is folded to its header, so the user sees the canvas below it (spec 001). */
  nodePanelFolded: Schema.Boolean,
  /** The width of the panel column of the studio, in px (spec 001). */
  panelWidth: Schema.Number.check(Schema.isBetween({ minimum: PANEL_MIN, maximum: PANEL_MAX })),
})
export type UiState = typeof UiState.Type

export const UiStatePatch = UiState.mapFields(Struct.map(Schema.optionalKey))
export type UiStatePatch = typeof UiStatePatch.Type

export const defaultUiState: UiState = {
  serverId: null,
  page: "workflows",
  places: {},
  activityPanel: true,
  tasksTab: "tasks",
  placeListWidth: PLACE_LIST_DEFAULT,
  workflowSideWidth: WORKFLOW_SIDE_DEFAULT,
  panelWidth: PANEL_DEFAULT,
  stripFolded: false,
  nodePanelFolded: false,
}

export const clampPlaceListWidth = (width: number) =>
  Math.round(Math.min(PLACE_LIST_MAX, Math.max(PLACE_LIST_MIN, width)))

export const clampPanelWidth = (width: number) =>
  Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, width)))

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
   * True when the server is online and lets this device create and change workflows (spec 012). The
   * plus buttons and the fields of workflows show only then. Absent for this computer.
   */
  readonly canChange?: boolean
}
