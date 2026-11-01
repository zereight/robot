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
    }
    test(`${theme}: text on accent is at least 4.5:1`, () => {
      expect(contrast(p.accentText, p.accent)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${theme}: danger text on main is at least 4.5:1`, () => {
      expect(contrast(p.danger, p.main)).toBeGreaterThanOrEqual(4.5)
    })
  }

  test("known ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5)
  })
})
