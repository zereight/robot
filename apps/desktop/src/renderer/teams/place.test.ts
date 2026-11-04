import { describe, expect, test } from "bun:test"
import { wholeBox } from "./place.ts"

describe("the place of the Teams page", () => {
  const area = { x: 240, y: 0, width: 760, height: 600 }

  test("a box inside the area keeps its place and its size", () => {
    expect(wholeBox({ x: 280, y: 100, width: 600, height: 300 }, area)).toEqual({
      x: 280,
      y: 100,
      width: 600,
      height: 300,
    })
  })

  test("a box that scrolled out at the bottom has no place, so the page hides", () => {
    expect(wholeBox({ x: 280, y: 450, width: 600, height: 300 }, area)).toBeNull()
  })

  test("a box that scrolled out at the top has no place, so the page hides", () => {
    expect(wholeBox({ x: 280, y: -100, width: 600, height: 300 }, area)).toBeNull()
  })

  test("a box that is out of the area has no place, so the page hides", () => {
    expect(wholeBox({ x: 280, y: 700, width: 600, height: 300 }, area)).toBeNull()
    expect(wholeBox({ x: 0, y: 100, width: 200, height: 300 }, area)).toBeNull()
  })

  test("a box wider than the area has no place", () => {
    expect(wholeBox({ x: 200, y: 10, width: 900, height: 100 }, area)).toBeNull()
  })

  test("a box that touches the edges of the area is whole", () => {
    expect(wholeBox({ x: 240, y: 0, width: 760, height: 600 }, area)).toEqual(area)
  })

  test("a cut of 1 px or less is a round-off, not a cut", () => {
    expect(wholeBox({ x: 280, y: -0.5, width: 600, height: 300 }, area)).not.toBeNull()
    expect(wholeBox({ x: 280, y: 300.9, width: 600, height: 300 }, area)).not.toBeNull()
    expect(wholeBox({ x: 280, y: -3, width: 600, height: 300 }, area)).toBeNull()
  })

  test("a box with no area has no place", () => {
    expect(wholeBox({ x: 280, y: 100, width: 0, height: 300 }, area)).toBeNull()
    expect(wholeBox({ x: 280, y: 100, width: 600, height: Number.NaN }, area)).toBeNull()
  })

  test("a box that scrolls keeps its size at every step", () => {
    // The size never changes while the box scrolls, so the page keeps the same scale.
    for (let top = 0; top <= 300; top += 25) {
      const place = wholeBox({ x: 280, y: top, width: 600, height: 300 }, area)
      expect(place).toEqual({ x: 280, y: top, width: 600, height: 300 })
    }
  })
})
