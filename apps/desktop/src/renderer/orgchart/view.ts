import type { ChartLayout, Point, Rect } from "./layout.ts"

// The view of the org chart (spec 029, "The page"): where the chart sits in the canvas and how large
// it is drawn. The functions below are pure, so the rules (zoom around a point, "Fit to view" with
// room for the controls) are tested without a window.

/** Where the chart is drawn: the move of its origin in px, and the zoom (1 is 100%). */
export interface View {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export interface Size {
  readonly w: number
  readonly h: number
}

export interface Insets {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 2.5
/** One press of "+" or "-", and one button. */
export const ZOOM_STEP = 1.25
/** "Fit to view" makes a small chart no larger than this. */
export const FIT_ZOOM_MAX = 1
/** Free space around the chart after "Fit to view", in px. */
export const FIT_PADDING = 24

export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))

/** Where a point of the chart (in chart px) is in the canvas. */
export const toScreen = (view: View, p: Point): Point => ({
  x: view.x + p.x * view.zoom,
  y: view.y + p.y * view.zoom,
})

/** The zoom changes by `factor`, and the point `at` (in canvas px) stays where it is. */
export const zoomAt = (view: View, factor: number, at: Point): View => {
  const zoom = clampZoom(view.zoom * factor)
  const k = zoom / view.zoom
  return { zoom, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }
}

/**
 * The factor of one turn of the wheel. A pinch on a trackpad comes as the wheel with the control
 * key down and smaller steps, so it gets a stronger factor. A step in lines counts as 16 px.
 */
export const wheelFactor = (event: { deltaY: number; deltaMode: number; ctrlKey: boolean }) => {
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
  return Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015))
}

/** The box around everything that the chart draws: nodes, lines and the numbers on the lines. */
export const extent = (layout: ChartLayout): Rect => {
  let x0 = layout.bounds.x
  let y0 = layout.bounds.y
  let x1 = layout.bounds.x + layout.bounds.w
  let y1 = layout.bounds.y + layout.bounds.h
  for (const line of layout.lines) {
    for (const p of line.points) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
    if (line.label) {
      x0 = Math.min(x0, line.label.x)
      y0 = Math.min(y0, line.label.y)
      x1 = Math.max(x1, line.label.x + line.label.w)
      y1 = Math.max(y1, line.label.y + line.label.h)
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * "Fit to view": the zoom and the place that frame the whole chart with room around it. `insets`
 * is the part of the canvas that the chart must not use, for example the strip of the controls, so
 * that no node sits under them. A small chart is not made larger than 100%.
 */
export const fitView = (box: Rect, canvas: Size, insets: Insets): View => {
  const free = {
    x: insets.left + FIT_PADDING,
    y: insets.top + FIT_PADDING,
    w: Math.max(1, canvas.w - insets.left - insets.right - 2 * FIT_PADDING),
    h: Math.max(1, canvas.h - insets.top - insets.bottom - 2 * FIT_PADDING),
  }
  if (box.w <= 0 || box.h <= 0) return { x: free.x, y: free.y, zoom: 1 }
  const zoom = Math.min(FIT_ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(free.w / box.w, free.h / box.h)))
  return {
    zoom,
    x: free.x + (free.w - box.w * zoom) / 2 - box.x * zoom,
    y: free.y + (free.h - box.h * zoom) / 2 - box.y * zoom,
  }
}
