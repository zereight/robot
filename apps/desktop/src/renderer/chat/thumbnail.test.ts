import { describe, expect, test } from "bun:test"
import { fitEdge } from "./thumbnail.ts"

describe("fitEdge", () => {
  test("cuts the longer side to the edge and keeps the proportions", () => {
    expect(fitEdge(400, 300, 256)).toEqual({ width: 256, height: 192 })
    expect(fitEdge(300, 400, 256)).toEqual({ width: 192, height: 256 })
    expect(fitEdge(4000, 4000, 256)).toEqual({ width: 256, height: 256 })
  })

  test("a picture that is not longer than the edge stays as it is", () => {
    expect(fitEdge(256, 100, 256)).toBeNull()
    expect(fitEdge(1, 1, 256)).toBeNull()
  })

  test("a long thin picture keeps at least one pixel on the short side", () => {
    expect(fitEdge(10_000, 3, 256)).toEqual({ width: 256, height: 1 })
  })

  test("a size that is not a size gives nothing to cut", () => {
    expect(fitEdge(0, 100, 256)).toBeNull()
    expect(fitEdge(100, -1, 256)).toBeNull()
    expect(fitEdge(Number.NaN, 100, 256)).toBeNull()
    expect(fitEdge(Number.POSITIVE_INFINITY, 100, 256)).toBeNull()
  })
})
