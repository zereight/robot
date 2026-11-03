import { describe, expect, test } from "bun:test"
import {
  CANVAS_MIN,
  clampSideWidth,
  HANDLE_WIDTH,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  setSideWidth,
  sideWidth,
} from "./sideWidth.ts"

describe("clampSideWidth", () => {
  test("keeps a width inside the limits", () => {
    expect(clampSideWidth(100)).toBe(SIDE_MIN)
    expect(clampSideWidth(5000)).toBe(SIDE_MAX)
    expect(clampSideWidth(401.4)).toBe(401)
  })

  test("leaves room for the canvas in a small workspace", () => {
    const workspace = 700
    expect(clampSideWidth(SIDE_MAX, workspace)).toBe(workspace - CANVAS_MIN - HANDLE_WIDTH)
  })

  test("never goes under the lowest width, also in a very small workspace", () => {
    expect(clampSideWidth(SIDE_MAX, 300)).toBe(SIDE_MIN)
    expect(clampSideWidth(0, 300)).toBe(SIDE_MIN)
  })

  test("a wide workspace does not raise the highest width", () => {
    expect(clampSideWidth(SIDE_MAX + 200, 3000)).toBe(SIDE_MAX)
  })
})

describe("setSideWidth", () => {
  test("starts at the default, and stores a clamped width", () => {
    expect(sideWidth()).toBe(SIDE_DEFAULT)
    setSideWidth(9999)
    expect(sideWidth()).toBe(SIDE_MAX)
    setSideWidth(SIDE_DEFAULT)
    expect(sideWidth()).toBe(SIDE_DEFAULT)
  })
})
