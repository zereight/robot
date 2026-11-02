import { createMemo } from "solid-js"
import { encode } from "uqr"

/**
 * A QR code as an SVG. The colours are fixed (black on white) in both themes, because phone
 * cameras read that best.
 */
export const QrCode = (props: { text: string; label: string; testId?: string }) => {
  const qr = createMemo(() => encode(props.text, { ecc: "M", border: 2 }))
  const path = createMemo(() => {
    const { data } = qr()
    let d = ""
    for (const [y, row] of data.entries()) {
      for (let x = 0; x < row.length; x++) if (row[x]) d += `M${x} ${y}h1v1h-1z`
    }
    return d
  })
  return (
    <svg
      viewBox={`0 0 ${qr().size} ${qr().size}`}
      role="img"
      aria-label={props.label}
      width="168"
      height="168"
      shape-rendering="crispEdges"
      data-testid={props.testId}
    >
      <rect width={qr().size} height={qr().size} fill="#ffffff" />
      <path d={path()} fill="#000000" />
    </svg>
  )
}
