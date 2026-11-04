/**
 * The size of a picture that is cut down so that its longer side is `edge` pixels, with the same
 * proportions. Null when the picture is not longer than that, or has no size: it stays as it is.
 */
export const fitEdge = (
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (!(width > 0) || !(height > 0) || !(Math.max(width, height) > edge)) return null
  const scale = edge / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
