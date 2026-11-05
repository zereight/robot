import { describe, expect, test } from "bun:test"
import { contrast } from "./contrast.ts"
import { palettes } from "./tokens.ts"

// What each theme must hold. The rules come from DESIGN.md, so a change to the look that breaks
// one of them fails here first. The surfaces are listed in the order of the ladder: each one sits
// above the one before it.
const surfaces = ["rail", "sidebar", "main", "elevated"] as const
const states = ["rail", "sidebar", "main", "elevated", "hover", "selected"] as const

describe("theme contrast", () => {
  for (const [theme, p] of Object.entries(palettes)) {
    for (const surface of states) {
      const background = p[surface]
      test(`${theme}: text on ${surface} is at least 4.5:1`, () => {
        expect(contrast(p.text, background)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(p.textMuted, background)).toBeGreaterThanOrEqual(4.5)
      })
      // Coloured text (links, status words, errors) is read on every surface too (spec 013).
      test(`${theme}: coloured text on ${surface} is at least 4.5:1`, () => {
        for (const ink of [p.accentInk, p.success, p.neon, p.danger, p.focus]) {
          expect(contrast(ink, background)).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
    test(`${theme}: text on accent is at least 4.5:1`, () => {
      expect(contrast(p.accentText, p.accent)).toBeGreaterThanOrEqual(4.5)
    })

    // DESIGN.md, "The Lift Rule". A filled button that the pointer is over must be easier to read
    // than the same button at rest, never harder, and the change must be visible.
    test(`${theme}: the accent under the pointer lifts the text, and shows as a change`, () => {
      expect(contrast(p.accentText, p.accentHover)).toBeGreaterThanOrEqual(
        contrast(p.accentText, p.accent),
      )
      expect(contrast(p.accent, p.accentHover)).toBeGreaterThanOrEqual(1.1)
    })
    test(`${theme}: the danger colour under the pointer lifts the text, and shows as a change`, () => {
      expect(contrast(p.dangerText, p.dangerHover)).toBeGreaterThanOrEqual(
        contrast(p.dangerText, p.danger),
      )
      expect(contrast(p.danger, p.dangerHover)).toBeGreaterThanOrEqual(1.1)
    })
    test(`${theme}: text on danger is at least 4.5:1`, () => {
      expect(contrast(p.dangerText, p.danger)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${theme}: text on the colours under the pointer is at least 4.5:1`, () => {
      expect(contrast(p.accentText, p.accentHover)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.dangerText, p.dangerHover)).toBeGreaterThanOrEqual(4.5)
    })
    // A danger button fills with the danger colour and writes on it (spec 000, "Danger buttons").
    test(`${theme}: text on danger is at least 4.5:1`, () => {
      expect(contrast(p.dangerText, p.danger)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${theme}: danger text on main is at least 4.5:1`, () => {
      expect(contrast(p.danger, p.main)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${theme}: the glyph of the mark of the user stands out from its disc at 7:1`, () => {
      expect(contrast(p.avatarGlyph, p.avatarTile)).toBeGreaterThanOrEqual(7)
    })

    // DESIGN.md, "Elevation". The surface carries the structure, so one step must be visible on
    // the next without a border. This is the rule that the flat look rests on.
    test(`${theme}: a neighbouring surface step is visible`, () => {
      for (let i = 1; i < surfaces.length; i += 1) {
        const under = p[surfaces[i - 1] as (typeof surfaces)[number]]
        const over = p[surfaces[i] as (typeof surfaces)[number]]
        expect(contrast(under, over)).toBeGreaterThanOrEqual(1.05)
      }
    })

    // A row that the pointer crosses must not look selected, and a selected row must not look
    // like either of them. The three states keep their order from rest to selection.
    test(`${theme}: hover and selection stand apart from rest`, () => {
      expect(contrast(p.hover, p.main)).toBeGreaterThanOrEqual(1.11)
      expect(contrast(p.selected, p.hover)).toBeGreaterThanOrEqual(1.08)
    })

    // DESIGN.md, "The Seam Rule". A border shows where two regions meet.
    test(`${theme}: the seam is visible against the surfaces it separates`, () => {
      expect(contrast(p.border, p.main)).toBeGreaterThanOrEqual(1.4)
      expect(contrast(p.border, p.sidebar)).toBeGreaterThanOrEqual(1.3)
    })

    // DESIGN.md, "The Tinted-Neutral Rule". Every neutral belongs to the same night as the app
    // mark: it carries a little of its hue and no more than a hint. A pure grey next to the mark
    // reads as a different product; a strong tint turns the room into a colour field.
    // The light theme cannot hold much chroma near white, so the top of its ladder carries less.
    test(`${theme}: every neutral carries the tint of the night`, () => {
      const floor = theme === "dark" ? 0.01 : 0.003
      for (const name of [...surfaces, "hover", "selected", "border"] as const) {
        const chroma = chromaOf(p[name])
        expect(chroma).toBeGreaterThanOrEqual(floor)
        expect(chroma).toBeLessThanOrEqual(0.03)
      }
    })
  }

  test("light: the rim of the mark of the user shows on every surface at 3:1", () => {
    const p = palettes.light
    for (const name of ["rail", "sidebar", "main", "hover", "selected"] as const) {
      expect(contrast(p.avatarRim, p[name])).toBeGreaterThanOrEqual(3)
    }
  })

  test("the app mark does not change with the theme", () => {
    const { dark, light } = palettes
    expect([light.markTile, light.markEyes, light.markGlow]).toEqual([
      dark.markTile,
      dark.markEyes,
      dark.markGlow,
    ])
  })

  test("the dark theme keeps the look of the mark of the user", () => {
    const p = palettes.dark
    expect([p.avatarTile, p.avatarGlyph, p.avatarGlow]).toEqual([
      p.markTile,
      p.markEyes,
      p.markGlow,
    ])
  })

  test("known ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5)
  })
})

/** The OKLCH chroma of a `#rrggbb` colour. */
function chromaOf(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const linear = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((value) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const [r, g, b] = linear as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return Math.hypot(a, bb)
}
