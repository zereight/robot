/** A box in CSS px of the app window. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The part of `box` that `clip` shows. The Teams page is a native view above the screen, so it
 * must not cover what lies outside the scroll area that holds its box. Returns null when nothing
 * of the box shows.
 */
export const clipBox = (box: Box, clip: Box): Box | null => {
  const x = Math.max(box.x, clip.x)
  const y = Math.max(box.y, clip.y)
  const right = Math.min(box.x + box.width, clip.x + clip.width)
  const bottom = Math.min(box.y + box.height, clip.y + clip.height)
  if (right - x < 1 || bottom - y < 1) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(right - x),
    height: Math.round(bottom - y),
  }
}
