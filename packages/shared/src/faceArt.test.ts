import { describe, expect, test } from "bun:test"
import { FACE_HUES, FACE_SHAPES } from "./agents.ts"
import { faceLayers, facePaint, faceParts, faceTones, LARGE_FACE, SMALL_FACE } from "./faceArt.ts"

const lightness = (colour: string) => Number(/(\d+)%\)$/.exec(colour)?.[1])

/** The relative luminance of an `hsl(h, s%, l%)` colour (WCAG 2). */
const luminance = (colour: string) => {
  const [h = 0, s = 0, l = 0] = (colour.match(/[\d.]+/g) ?? []).map(Number)
  const sat = s / 100
  const light = l / 100
  const a = sat * Math.min(light, 1 - light)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The surfaces of the light theme where a face sits: main, side list, and a selected row. */
const lightSurfaces = ["#ffffff", "#f3f3f4", "#e1e1e4"]
const hexLuminance = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}
const contrastWithHex = (colour: string, hex: string) => {
  const [hi, lo] = [luminance(colour), hexLuminance(hex)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe("face art", () => {
  test("each hue gives its own light on a dark tile", () => {
    const glows = new Set<string>()
    for (let hue = 0; hue < FACE_HUES; hue++) {
      const { tile, glow, core } = faceTones(hue)
      glows.add(glow)
      // The features must stand out from the tile.
      expect(lightness(tile)).toBeLessThan(15)
      expect(lightness(glow)).toBeGreaterThan(55)
      expect(lightness(core)).toBeGreaterThan(90)
    }
    expect(glows.size).toBe(FACE_HUES)
  })

  test("the features stand out from the tile at 7:1 or more, for every hue", () => {
    for (let hue = 0; hue < FACE_HUES; hue++) {
      const { tile, core } = faceTones(hue)
      expect(contrast(core, tile)).toBeGreaterThanOrEqual(7)
    }
  })

  test("the dark theme is the default, and its colours do not change", () => {
    for (let hue = 0; hue < FACE_HUES; hue++) {
      expect(faceTones(hue)).toEqual(faceTones(hue, "dark"))
      expect(faceLayers(hue, 40)).toEqual(faceLayers(hue, 40, "dark"))
    }
    expect(faceTones(2, "dark").tile).toBe("hsl(72, 42%, 9%)")
  })

  describe("the light theme", () => {
    test("each hue gives its own tint on a light tile, with dark features", () => {
      const tiles = new Set<string>()
      for (let hue = 0; hue < FACE_HUES; hue++) {
        const { tile, core } = faceTones(hue, "light")
        tiles.add(tile)
        expect(lightness(tile)).toBeGreaterThan(85)
        expect(lightness(core)).toBeLessThan(20)
      }
      expect(tiles.size).toBe(FACE_HUES)
    })

    test("the features stand out from the tile at 7:1 or more, for every hue", () => {
      for (let hue = 0; hue < FACE_HUES; hue++) {
        const { tile, core } = faceTones(hue, "light")
        expect(contrast(core, tile)).toBeGreaterThanOrEqual(7)
      }
    })

    test("the rim shows on a light surface at 3:1 or more, for every hue", () => {
      for (let hue = 0; hue < FACE_HUES; hue++) {
        const { ring } = faceTones(hue, "light")
        // A rim of light is a colour with an alpha in the dark theme. Here it must be solid.
        expect(ring.startsWith("hsl(")).toBe(true)
        for (const surface of lightSurfaces) {
          expect(contrastWithHex(ring, surface)).toBeGreaterThanOrEqual(3)
        }
      }
    })

    test("a face has no glow: the core is the only layer, at every size", () => {
      for (const size of [16, 24, 40, 64, 80]) {
        for (let hue = 0; hue < FACE_HUES; hue++) {
          expect(faceLayers(hue, size, "light")).toEqual([
            { colour: faceTones(hue, "light").core, grow: 0, alpha: 1 },
          ])
        }
      }
    })

    test("the hue colour for a swatch differs for every hue", () => {
      const glows = new Set<string>()
      for (let hue = 0; hue < FACE_HUES; hue++) glows.add(faceTones(hue, "light").glow)
      expect(glows.size).toBe(FACE_HUES)
    })
  })

  test("every shape has parts, and a shape out of range draws as the nearest one", () => {
    for (let shape = 0; shape < FACE_SHAPES; shape++) {
      expect(faceParts(shape).length).toBeGreaterThan(0)
    }
    expect(faceParts(-3)).toBe(faceParts(0))
    expect(faceParts(99)).toBe(faceParts(FACE_SHAPES - 1))
  })

  test("the first shape has features: a shape of 0 must not read as none", () => {
    expect(faceParts(0).length).toBeGreaterThan(1)
  })

  test("only the shape with closed eyes has no eyes to blink", () => {
    for (let shape = 0; shape < FACE_SHAPES; shape++) {
      const blinks = faceParts(shape).some((part) => part.eyes)
      expect(blinks).toBe(shape !== 4)
    }
  })

  test("the parts stay inside the square of 64 units", () => {
    for (let shape = 0; shape < FACE_SHAPES; shape++) {
      for (const part of faceParts(shape)) {
        if (part.tag === "circle") {
          const { cx, cy, r } = part.geometry as { cx: number; cy: number; r: number }
          expect(cx - r).toBeGreaterThanOrEqual(0)
          expect(cx + r).toBeLessThanOrEqual(64)
          expect(cy - r).toBeGreaterThanOrEqual(0)
          expect(cy + r).toBeLessThanOrEqual(64)
        }
      }
    }
  })

  test("a solid part widens with a stroke of its colour, and an outline gets wider", () => {
    const solid = faceParts(0)[0]
    const line = faceParts(0)[2]
    if (!solid || !line) throw new Error("the first shape lost its parts")
    const core = { colour: "white", grow: 0, alpha: 1 }
    const halo = { colour: "red", grow: 6, alpha: 0.2 }
    expect(facePaint(solid, core).stroke).toBe("none")
    expect(facePaint(solid, halo)).toMatchObject({
      stroke: "red",
      strokeWidth: 6,
      fillOpacity: 0.2,
    })
    expect(facePaint(line, core)).toMatchObject({ fill: "none", stroke: "white", strokeWidth: 3 })
    expect(facePaint(line, halo)).toMatchObject({ strokeWidth: 9, strokeOpacity: 0.2 })
  })

  describe("layers of light", () => {
    const halos = (size: number) => faceLayers(2, size).length - 1

    test("the top layer is the sharp core, and the layers under it are wider and fainter", () => {
      for (const size of [16, 24, 40, 64, 80]) {
        const layers = faceLayers(2, size)
        const core = layers[layers.length - 1]
        expect(core).toEqual({ colour: faceTones(2).core, grow: 0, alpha: 1 })
        const glow = layers.slice(0, -1)
        for (const layer of glow) expect(layer.colour).toBe(faceTones(2).glow)
        for (let i = 1; i < glow.length; i++) {
          expect(glow[i - 1]?.grow).toBeGreaterThan(glow[i]?.grow ?? 0)
        }
      }
    })

    test("a larger face has more layers of glow", () => {
      expect(halos(SMALL_FACE - 1)).toBe(1)
      expect(halos(SMALL_FACE)).toBe(2)
      expect(halos(LARGE_FACE - 1)).toBe(2)
      expect(halos(LARGE_FACE)).toBe(4)
    })

    // A chat shows many small faces. Each layer of glow is a wide stroke that the window draws
    // again on every repaint, so a small face keeps a small budget of drawn parts.
    test("a small face stays cheap to draw", () => {
      for (let shape = 0; shape < FACE_SHAPES; shape++) {
        const drawn = (size: number) => faceLayers(0, size).length * faceParts(shape).length
        expect(drawn(24)).toBeLessThanOrEqual(2 * 6)
        expect(drawn(40)).toBeLessThanOrEqual(3 * 6)
      }
    })
  })
})
