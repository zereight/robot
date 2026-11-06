import { describe, expect, test } from "bun:test"
import { palettes as desktopPalettes } from "../../../desktop/src/renderer/theme/tokens.ts"
import { contrast, mark, palettes } from "./palette.ts"

describe("the mark of the user follows the theme", () => {
  for (const [theme, p] of Object.entries(palettes)) {
    test(`${theme}: the glyph stands out from the disc at 7:1`, () => {
      expect(contrast(p.avatarGlyph, p.avatarTile)).toBeGreaterThanOrEqual(7)
    })
  }

  test("light: the rim shows on every surface at 3:1", () => {
    const p = palettes.light
    for (const surface of [p.background, p.surface, p.elevated, p.pressed, p.selected]) {
      expect(contrast(p.avatarRim, surface)).toBeGreaterThanOrEqual(3)
    }
  })

  test("the dark theme keeps the look that it had, and the app mark does not change", () => {
    expect([palettes.dark.avatarTile, palettes.dark.avatarGlyph, palettes.dark.avatarGlow]).toEqual(
      [mark.tile, mark.eyes, mark.glow],
    )
    expect(mark).toEqual({ tile: "#0a0817", eyes: "#eafff8", glow: "#7affd4" })
  })

  test("the colours are the same as on the desktop", () => {
    // Each app keeps its own palette. A change on one side must be made on the other too.
    for (const theme of ["dark", "light"] as const) {
      const phone = palettes[theme]
      const desktop = desktopPalettes[theme]
      expect(phone.avatarTile).toBe(desktop.avatarTile)
      expect(phone.avatarGlyph).toBe(desktop.avatarGlyph)
      expect(phone.avatarGlow).toBe(desktop.avatarGlow)
    }
    // The rim of the dark theme is the same colour with an alpha, written in the other notation.
    expect(palettes.light.avatarRim).toBe(desktopPalettes.light.avatarRim)
  })
})
