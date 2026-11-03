import type { PageBounds } from "../services/Platform.ts"

/**
 * The size that the page of an agent browser is laid out in, in CSS px. It never depends on the
 * place of the page, so the window can grow or shrink and the page, and what the agent reads from
 * it, stay the same. The ratio is the one of the small box in the activity panel (16:10).
 */
export const PAGE_VIEW = { width: 1280, height: 800 } as const

export interface PageFit {
  /** Where the native view sits: the largest box of the ratio of the page, in the middle. */
  readonly bounds: PageBounds
  /** How much the page is drawn smaller (or larger) than its own size. */
  readonly scale: number
}

/**
 * Fits the page into a place. The page keeps its own size and its ratio. It is drawn at the scale
 * that fills the place in one direction, and what is left over at the sides stays empty. Returns
 * `undefined` when the place has no area, because there is nothing to draw in.
 */
export const fitPage = (place: PageBounds): PageFit | undefined => {
  const scale = Math.min(place.width / PAGE_VIEW.width, place.height / PAGE_VIEW.height)
  if (!Number.isFinite(scale) || scale <= 0) return undefined
  const width = Math.max(1, Math.round(PAGE_VIEW.width * scale))
  const height = Math.max(1, Math.round(PAGE_VIEW.height * scale))
  return {
    scale,
    bounds: {
      x: Math.round(place.x + (place.width - width) / 2),
      y: Math.round(place.y + (place.height - height) / 2),
      width,
      height,
    },
  }
}
