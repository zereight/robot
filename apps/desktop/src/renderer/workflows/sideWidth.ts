import { createSignal } from "solid-js"

/** The side column of the workflow editor holds the panel of a node and the list of runs. */
export const SIDE_MIN = 240
export const SIDE_MAX = 720
export const SIDE_DEFAULT = 340
/** The canvas keeps at least this width, so a wide side column never hides it. */
export const CANVAS_MIN = 240
/** The width of the drag handle between the canvas and the side column. */
export const HANDLE_WIDTH = 6

/**
 * Keeps a width inside the limits. `available` is the width of the whole workspace, when it is
 * known. A small window gives the side column less than SIDE_MAX, and never less than SIDE_MIN.
 */
export const clampSideWidth = (width: number, available?: number): number => {
  const room = available === undefined ? SIDE_MAX : available - CANVAS_MIN - HANDLE_WIDTH
  const max = Math.max(SIDE_MIN, Math.min(SIDE_MAX, room))
  return Math.round(Math.min(max, Math.max(SIDE_MIN, width)))
}

// The width belongs to the window, not to a workflow, so it lives here and stays when the user
// opens another workflow. It is not saved between runs of the app.
const [width, setWidth] = createSignal(SIDE_DEFAULT)

export const sideWidth = width
export const setSideWidth = (next: number, available?: number) =>
  setWidth(clampSideWidth(next, available))
