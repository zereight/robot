import { describe, expect, test } from "bun:test"
import { labelPlace } from "./labelPlace.ts"

const box = (x: number, y: number, w = 176, h = 60) => ({ x, y, w, h })

describe("labelPlace", () => {
  test("between two nodes in a row the label sits above them, not on a border", () => {
    const from = box(240, 24)
    const to = box(456, 24)
    const line = { x1: 416, y1: 54, x2: 456, y2: 54 }
    expect(labelPlace(line, "Approve", [from, to])).toEqual({ x: 436, y: 14 })
  })

  test("with room around the line the label stays by its middle", () => {
    const from = box(24, 24)
    const to = box(456, 24)
    const line = { x1: 200, y1: 54, x2: 456, y2: 54 }
    expect(labelPlace(line, "Approve", [from, to])).toEqual({ x: 328, y: 46 })
  })

  test("a label inside the gap of stacked nodes moves up until it clears them", () => {
    const above = box(240, 24)
    const below = box(240, 120)
    const line = { x1: 416, y1: 54, x2: 240, y2: 150 }
    expect(labelPlace(line, "A longer option label", [above, below])).toEqual({ x: 328, y: 14 })
  })
})
