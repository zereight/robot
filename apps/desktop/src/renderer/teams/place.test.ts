import { describe, expect, test } from "bun:test"
import { clipBox } from "./place.ts"

describe("the place of the Teams page", () => {
  const area = { x: 240, y: 0, width: 760, height: 600 }

  test("a box inside the area keeps its size", () => {
    expect(clipBox({ x: 280, y: 100, width: 600, height: 300 }, area)).toEqual({
      x: 280,
      y: 100,
      width: 600,
      height: 300,
    })
  })

  test("a box that scrolled out at the bottom is cut", () => {
    expect(clipBox({ x: 280, y: 450, width: 600, height: 300 }, area)).toEqual({
      x: 280,
      y: 450,
      width: 600,
      height: 150,
    })
  })

  test("a box that scrolled out at the top is cut", () => {
    expect(clipBox({ x: 280, y: -100, width: 600, height: 300 }, area)).toEqual({
      x: 280,
      y: 0,
      width: 600,
      height: 200,
    })
  })

  test("a box that is out of the area has no place, so the page hides", () => {
    expect(clipBox({ x: 280, y: 700, width: 600, height: 300 }, area)).toBeNull()
    expect(clipBox({ x: 0, y: 100, width: 200, height: 300 }, area)).toBeNull()
  })

  test("a box wider than the area stops at its edge", () => {
    expect(clipBox({ x: 200, y: 10, width: 900, height: 100 }, area)).toEqual({
      x: 240,
      y: 10,
      width: 760,
      height: 100,
    })
  })
})
