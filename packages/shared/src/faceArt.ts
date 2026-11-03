/**
 * The drawing of an agent face, as data. A face is a very dark disc with features of light, as
 * the app mark is. The desktop and the phone draw the same parts in the same layers, so a face
 * looks the same on both. A renderer needs no filter: the glow is a stack of wider, fainter copies
 * of the features under the sharp ones.
 */

/** The three colours of a face, as CSS colours. */
export interface FaceTones {
  /** The dark disc, tinted by the hue. */
  readonly tile: string
  /** The light that spills round the features. */
  readonly glow: string
  /** The features themselves: near white, with a trace of the hue. */
  readonly core: string
  /** The thin rim of light round the face, or round a picture in its place. */
  readonly ring: string
}

/**
 * The colours of a face. The hue picks the colour of the light. The tile is very dark in both
 * themes, so the features can be light.
 */
export const faceTones = (hue: number): FaceTones => {
  const angle = hue * 36
  return {
    tile: `hsl(${angle}, 42%, 9%)`,
    glow: `hsl(${angle}, 100%, 66%)`,
    core: `hsl(${angle}, 100%, 94%)`,
    ring: `hsla(${angle}, 100%, 66%, 0.4)`,
  }
}

/** The names of the shapes of a part, as in SVG. */
export type FacePartTag = "circle" | "ellipse" | "rect" | "path"

/** One part of the features of a face, in a square of 64 units. */
export interface FacePart {
  readonly tag: FacePartTag
  /** The geometry, with the names of SVG attributes. */
  readonly geometry: Readonly<Record<string, number | string>>
  /** An outline of this width. A part without it is a solid shape. */
  readonly line?: number
  /** How strong an outline is, from 0 to 1. The default is 1. */
  readonly strength?: number
  /** The eyes close together when the face blinks. */
  readonly eyes?: true
}

const dot = (cx: number, cy: number, r: number, eyes?: true): FacePart => ({
  tag: "circle",
  geometry: { cx, cy, r },
  ...(eyes ? { eyes } : {}),
})
const stroke = (d: string, width = 3): FacePart => ({ tag: "path", geometry: { d }, line: width })

const shapes: readonly (readonly FacePart[])[] = [
  // 0: two round eyes and a smile.
  [dot(24, 28, 4, true), dot(40, 28, 4, true), stroke("M23 39 Q32 47 41 39")],
  // 1: two tall eyes and a flat mouth.
  [
    { tag: "ellipse", geometry: { cx: 24, cy: 28, rx: 3, ry: 5.5 }, eyes: true },
    { tag: "ellipse", geometry: { cx: 40, cy: 28, rx: 3, ry: 5.5 }, eyes: true },
    stroke("M26 42 H38"),
  ],
  // 2: a visor, a thin line of light with two bright points in it.
  [
    {
      tag: "rect",
      geometry: { x: 15, y: 22, width: 34, height: 12, rx: 6 },
      line: 2,
      strength: 0.6,
      eyes: true,
    },
    dot(24, 28, 3, true),
    dot(40, 28, 3, true),
    stroke("M28 43 H36"),
  ],
  // 3: one eye, a ring of light with a bright centre that looks a little aside.
  [
    { tag: "circle", geometry: { cx: 32, cy: 29, r: 6.5 }, line: 3, eyes: true },
    dot(33, 28.2, 2.5, true),
    stroke("M26 43 Q32 47 38 43"),
  ],
  // 4: eyes that are already closed, so this shape does not blink.
  [stroke("M19 30 Q24 25 29 30"), stroke("M35 30 Q40 25 45 30"), dot(32, 42, 3)],
  // 5: an antenna, square eyes and a smile.
  [
    stroke("M32 6 V14"),
    dot(32, 7, 3),
    { tag: "rect", geometry: { x: 20, y: 25, width: 7, height: 7, rx: 1.5 }, eyes: true },
    { tag: "rect", geometry: { x: 37, y: 25, width: 7, height: 7, rx: 1.5 }, eyes: true },
    stroke("M24 41 Q32 46 40 41"),
  ],
]

/** The features of a face shape. A shape outside the list draws as the last one. */
export const faceParts = (shape: number): readonly FacePart[] =>
  shapes[Math.min(Math.max(Math.trunc(shape), 0), shapes.length - 1)] as readonly FacePart[]

/** One layer of the light of a face. */
export interface FaceLayer {
  readonly colour: string
  /** Every line and solid shape of the layer is this much wider, in units of the drawing. */
  readonly grow: number
  /** How strong the layer is, from 0 to 1. */
  readonly alpha: number
}

/** The paint of one part in one layer, with the names of the props of `react-native-svg`. */
export interface FacePaint {
  readonly fill: string
  readonly fillOpacity?: number
  readonly stroke: string
  readonly strokeOpacity?: number
  readonly strokeWidth?: number
  readonly strokeLinecap?: "round"
  readonly strokeLinejoin: "round"
}

export const facePaint = (part: FacePart, layer: FaceLayer): FacePaint => {
  const { colour, grow, alpha } = layer
  if (part.line === undefined) {
    // A solid shape widens with a stroke of its own colour.
    return {
      fill: colour,
      fillOpacity: alpha,
      stroke: grow > 0 ? colour : "none",
      strokeOpacity: alpha,
      strokeWidth: grow,
      strokeLinejoin: "round",
    }
  }
  return {
    fill: "none",
    stroke: colour,
    strokeOpacity: alpha * (part.strength ?? 1),
    strokeWidth: part.line + grow,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  }
}

/**
 * The wide, faint layers of the glow, from the widest to the tightest. Each layer costs a wide
 * stroke of light alpha, and that is what a long list of faces pays for in drawing time. So the
 * number of layers follows the size of the face.
 */
const halos = [
  { grow: 10, alpha: 0.06 },
  { grow: 7, alpha: 0.12 },
  { grow: 5, alpha: 0.2 },
  { grow: 2.4, alpha: 0.3 },
] as const

/** Below this size, in px, a face has one layer of glow. */
export const SMALL_FACE = 28

/** From this size, in px, a face has four layers of glow. The sizes between have two. */
export const LARGE_FACE = 48

/**
 * The layers of a face, from the bottom: the glow, then the sharp core. A small face has fewer
 * layers of glow, because the layers of a small face cannot be told apart, and a long list of
 * small faces must stay cheap to draw. The most that a screen shows is a few large faces and
 * many small ones.
 */
export const faceLayers = (hue: number, size: number): readonly FaceLayer[] => {
  const tones = faceTones(hue)
  const glow = size < SMALL_FACE ? [halos[2]] : size < LARGE_FACE ? [halos[1], halos[3]] : halos
  return [
    ...glow.map((halo) => ({ colour: tones.glow, ...halo })),
    { colour: tones.core, grow: 0, alpha: 1 },
  ]
}
