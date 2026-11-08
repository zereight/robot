export interface LabelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const labelHalf = (text: string): number =>
  Math.max(
    12,
    [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 255 ? 7 : 3.5), 0),
  )

export const labelBox = (x: number, y: number, text: string): LabelBox => {
  const half = labelHalf(text)
  return { x: x - half, y: y - 12, w: half * 2, h: 15 }
}

export const labelPlace = (
  line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  text: string,
  boxes: readonly LabelBox[],
  placed: readonly LabelBox[] = [],
): { x: number; y: number } => {
  const obstacles = [...boxes, ...placed]
  const hits = (x: number, y: number) => {
    const b = labelBox(x, y, text)
    return obstacles.some(
      (o) => b.x + b.w > o.x && b.x < o.x + o.w && b.y + b.h > o.y && b.y < o.y + o.h,
    )
  }
  const dx = line.x2 - line.x1
  const dy = line.y2 - line.y1
  const len = Math.hypot(dx, dy)
  const nx = len === 0 ? 0 : -dy / len
  const ny = len === 0 ? -1 : dx / len
  const s = ny < 0 || (ny === 0 && nx < 0) ? 1 : -1
  const step = { x: s * nx * 16, y: s * ny * 16 }
  let x = (line.x1 + line.x2) / 2
  let y = (line.y1 + line.y2) / 2 - 8
  for (let i = 0; i < 40 && hits(x, y); i++) {
    x += step.x
    y += step.y
  }
  return { x, y }
}
