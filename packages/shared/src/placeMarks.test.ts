import { describe, expect, test } from "bun:test"
import {
  carriedMarks,
  holdsMarks,
  holdsProgramMark,
  isPlaceOutside,
  MARK_FIELDS,
  markKinds,
  mergedMarks,
  NO_MARKS,
  type PlaceMarks,
  parsePlaceOutside,
  placeOutsideText,
} from "./placeMarks.ts"

const keys: PlaceMarks = { ...NO_MARKS, sensitive: "keys" }
const teams: PlaceMarks = { ...NO_MARKS, outside: { source: { kind: "teams" }, program: true } }

describe("the marks of a place (spec 007)", () => {
  test("a place with no mark holds none, and a place with a label holds one", () => {
    expect(holdsMarks(NO_MARKS)).toBe(false)
    expect(markKinds(NO_MARKS)).toEqual([])
    expect(holdsMarks(keys)).toBe(true)
    expect(markKinds(keys)).toEqual(["sensitive"])
  })

  test("the outside mark is a mark of its own, and it holds the program mark", () => {
    expect(holdsMarks(teams)).toBe(true)
    expect(markKinds(teams)).toEqual(["outside"])
    expect(markKinds({ ...teams, sensitive: "keys" })).toEqual(["outside", "sensitive"])
    expect(holdsProgramMark(teams)).toBe(true)
    expect(holdsProgramMark(keys)).toBe(false)
    expect(holdsProgramMark(NO_MARKS)).toBe(false)
  })

  test("a carry copies every field of the marks, and the copy is a new object", () => {
    const marks: PlaceMarks = { ...teams, sensitive: "cloud" }
    const carried = carriedMarks(marks)
    expect(carried).toEqual(marks)
    expect(carried).not.toBe(marks)
    // Every field that the type names is a field of the copy: a new mark follows with no change.
    expect(Object.keys(carriedMarks({ ...NO_MARKS }))).toEqual([...MARK_FIELDS].sort())
  })

  test("a place keeps a mark that it holds, and takes the mark that it holds not yet", () => {
    expect(mergedMarks(keys, { ...NO_MARKS, sensitive: "cloud" })).toEqual(keys)
    expect(mergedMarks(NO_MARKS, { ...NO_MARKS, sensitive: "cloud" })).toEqual({
      ...NO_MARKS,
      sensitive: "cloud",
    })
    expect(mergedMarks(NO_MARKS, NO_MARKS)).toEqual(NO_MARKS)
    expect(mergedMarks(NO_MARKS, teams)).toEqual(teams)
    // The first source stays.
    const here: PlaceMarks = {
      ...NO_MARKS,
      outside: { source: { kind: "agent", name: "Bo" }, program: true },
    }
    expect(mergedMarks(here, teams).outside?.source).toEqual({ kind: "agent", name: "Bo" })
    expect(mergedMarks(teams, NO_MARKS)).toEqual(teams)
  })

  test("a place gets the program mark from a carried mark, and keeps its own first source", () => {
    const plain: PlaceMarks = {
      ...NO_MARKS,
      outside: { source: { kind: "page", host: "a.test" }, program: false },
    }
    const merged = mergedMarks(plain, teams)
    expect(merged.outside).toEqual({ source: { kind: "page", host: "a.test" }, program: true })
    expect(mergedMarks(teams, plain).outside?.program).toBe(true)
  })
})

describe("the stored form of the outside mark", () => {
  test("it round-trips, and text that is no mark reads as no mark", () => {
    const mark = { source: { kind: "teams" }, program: true } as const
    expect(parsePlaceOutside(placeOutsideText(mark))).toEqual(mark)
    expect(placeOutsideText(null)).toBeNull()
    expect(parsePlaceOutside(null)).toBeNull()
    expect(parsePlaceOutside("")).toBeNull()
    expect(parsePlaceOutside("not json")).toBeNull()
    expect(parsePlaceOutside('{"source":{"kind":"other"},"program":true}')).toBeNull()
    expect(parsePlaceOutside('{"source":{"kind":"teams"}}')).toBeNull()
    expect(parsePlaceOutside('{"source":{"kind":"teams"},"program":true,"x":1}')).toBeNull()
  })

  test("the guard checks the source and the flag", () => {
    expect(isPlaceOutside({ source: { kind: "agent", name: "Bo" }, program: false })).toBe(true)
    expect(isPlaceOutside({ source: { kind: "teams" }, program: "yes" })).toBe(false)
    expect(isPlaceOutside(null)).toBe(false)
    expect(isPlaceOutside([])).toBe(false)
  })
})
