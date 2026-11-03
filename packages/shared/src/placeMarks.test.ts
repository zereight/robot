import { describe, expect, test } from "bun:test"
import {
  carriedMarks,
  holdsMarks,
  MARK_FIELDS,
  markKinds,
  mergedMarks,
  NO_MARKS,
  type PlaceMarks,
} from "./placeMarks.ts"

describe("the marks of a place (spec 007)", () => {
  test("a place with no mark holds none, and a place with a label holds one", () => {
    expect(holdsMarks(NO_MARKS)).toBe(false)
    expect(markKinds(NO_MARKS)).toEqual([])
    expect(holdsMarks({ sensitive: "keys" })).toBe(true)
    expect(markKinds({ sensitive: "keys" })).toEqual(["sensitive"])
  })

  test("a carry copies every field of the marks, and the copy is a new object", () => {
    const marks: PlaceMarks = { sensitive: "cloud" }
    const carried = carriedMarks(marks)
    expect(carried).toEqual(marks)
    expect(carried).not.toBe(marks)
    // Every field that the type names is a field of the copy: a new mark follows with no change.
    expect(Object.keys(carriedMarks({ ...NO_MARKS }))).toEqual([...MARK_FIELDS])
  })

  test("a place keeps a mark that it holds, and takes the mark that it holds not yet", () => {
    expect(mergedMarks({ sensitive: "keys" }, { sensitive: "cloud" })).toEqual({
      sensitive: "keys",
    })
    expect(mergedMarks(NO_MARKS, { sensitive: "cloud" })).toEqual({ sensitive: "cloud" })
    expect(mergedMarks(NO_MARKS, NO_MARKS)).toEqual(NO_MARKS)
  })
})
