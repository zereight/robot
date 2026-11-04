/** A box in CSS px of the app window. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The error of a measure that is allowed, in CSS px. A border or a round-off is not a cut. */
const SLACK = 1

/**
 * The place of the Teams page: `box` as it is, when the scroll area `clip` shows all of it.
 * Returns null when any part is cut off, or when the box has no area.
 *
 * The Teams page is a native view above the screen. The view cannot show a part of its page, and
 * the app draws the page at a size that follows the place that it gets. A cut place would make
 * the page smaller as the box scrolls out. So the page shows whole or not at all, and it never
 * covers what lies outside the scroll area that holds its box.
 */
export const wholeBox = (box: Box, clip: Box): Box | null => {
  if (!(box.width >= 1) || !(box.height >= 1)) return null
  const inside =
    box.x >= clip.x - SLACK &&
    box.y >= clip.y - SLACK &&
    box.x + box.width <= clip.x + clip.width + SLACK &&
    box.y + box.height <= clip.y + clip.height + SLACK
  if (!inside) return null
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}
