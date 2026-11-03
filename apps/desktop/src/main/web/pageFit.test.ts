import { describe, expect, test } from "bun:test"
import { fitPage, PAGE_VIEW } from "./pageFit.ts"

describe("fitPage", () => {
  test("a place of the ratio of the page is filled", () => {
    const fit = fitPage({ x: 20, y: 30, width: 320, height: 200 })
    expect(fit?.bounds).toEqual({ x: 20, y: 30, width: 320, height: 200 })
    expect(fit?.scale).toBeCloseTo(0.25, 5)
  })

  test("a place that is wider keeps empty room at the two sides", () => {
    const fit = fitPage({ x: 0, y: 0, width: 1000, height: 400 })
    // The height sets the scale: 400 / 800.
    expect(fit?.scale).toBeCloseTo(0.5, 5)
    expect(fit?.bounds).toEqual({ x: 180, y: 0, width: 640, height: 400 })
  })

  test("a place that is taller keeps empty room above and below", () => {
    const fit = fitPage({ x: 10, y: 10, width: 640, height: 600 })
    expect(fit?.scale).toBeCloseTo(0.5, 5)
    expect(fit?.bounds).toEqual({ x: 10, y: 110, width: 640, height: 400 })
  })

  test("the page stays inside its place", () => {
    for (const [width, height] of [
      [301, 199],
      [733, 417],
      [1840, 1010],
      [90, 900],
    ] as const) {
      const place = { x: 17, y: 41, width, height }
      const fit = fitPage(place)
      expect(fit).toBeDefined()
      const { bounds } = fit ?? { bounds: place }
      expect(bounds.x).toBeGreaterThanOrEqual(place.x)
      expect(bounds.y).toBeGreaterThanOrEqual(place.y)
      // One px of rounding is allowed.
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(place.x + place.width + 1)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(place.y + place.height + 1)
    }
  })

  test("the page fills the place in one direction", () => {
    const fit = fitPage({ x: 0, y: 0, width: 733, height: 417 })
    const bounds = fit?.bounds
    expect(
      Math.abs((bounds?.width ?? 0) - 733) <= 1 || Math.abs((bounds?.height ?? 0) - 417) <= 1,
    ).toBe(true)
  })

  test("a place larger than the page draws the page larger", () => {
    const fit = fitPage({ x: 0, y: 0, width: PAGE_VIEW.width * 2, height: PAGE_VIEW.height * 2 })
    expect(fit?.scale).toBeCloseTo(2, 5)
  })

  test("a place with no area has no fit", () => {
    expect(fitPage({ x: 0, y: 0, width: 0, height: 200 })).toBeUndefined()
    expect(fitPage({ x: 0, y: 0, width: 200, height: 0 })).toBeUndefined()
    expect(fitPage({ x: 0, y: 0, width: Number.NaN, height: 200 })).toBeUndefined()
  })
})
