/**
 * Where the label of a connection sits: above the middle of its line, moved up while its box
 * touches a node, so it never overlaps one.
 */
export const labelPlace = (
  line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  text: string,
  boxes: readonly {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }[],
): { x: number; y: number } => {
  const x = (line.x1 + line.x2) / 2
  const half = Math.max(
    12,
    [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 255 ? 7 : 3.5), 0),
  )
  let y = (line.y1 + line.y2) / 2 - 8
  for (let i = 0; i < 40; i++) {
    const hit = boxes.some(
      (b) => x + half > b.x && x - half < b.x + b.w && y + 3 > b.y && y - 12 < b.y + b.h,
    )
    if (!hit) break
    y -= 16
  }
  return { x, y }
}
