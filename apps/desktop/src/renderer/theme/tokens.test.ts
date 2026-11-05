import { describe, expect, test } from "bun:test"
import { contrast } from "./contrast.ts"
import { palettes } from "./tokens.ts"

describe("theme contrast", () => {
  for (const [theme, p] of Object.entries(palettes)) {
    const surfaces = {
      rail: p.rail,
      sidebar: p.sidebar,
      main: p.main,
      elevated: p.elevated,
      hover: p.hover,
      selected: p.selected,
    }
    for (const [surface, background] of Object.entries(surfaces)) {
      test(`${theme}: text on ${surface} is at least 4.5:1`, () => {
        expect(contrast(p.text, background)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(p.textMuted, background)).toBeGreaterThanOrEqual(4.5)
      })
      // Coloured text (links, status words, errors) is read on every surface too (spec 013).
      test(`${theme}: coloured text on ${surface} is at least 4.5:1`, () => {
        for (const ink of [p.accentInk, p.success, p.danger, p.focus]) {
          expect(contrast(ink, background)).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
    test(`${theme}: text on accent is at least 4.5:1`, () => {
      expect(contrast(p.accentText, p.accent)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${theme}: danger text on main is at least 4.5:1`, () => {
      expect(contrast(p.danger, p.main)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${theme}: the glyph of the mark of the user stands out from its disc at 7:1`, () => {
      expect(contrast(p.avatarGlyph, p.avatarTile)).toBeGreaterThanOrEqual(7)
    })
  }

  test("light: the rim of the mark of the user shows on every surface at 3:1", () => {
    const p = palettes.light
    for (const surface of [p.rail, p.sidebar, p.main, p.hover, p.selected]) {
      expect(contrast(p.avatarRim, surface)).toBeGreaterThanOrEqual(3)
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
