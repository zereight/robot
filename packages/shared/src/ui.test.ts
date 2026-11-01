import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  clampPlaceListWidth,
  defaultUiState,
  filterPlaces,
  type PlaceSection,
  UiState,
} from "./ui.ts"

const place = (name: string) => ({
  kind: "agent" as const,
  id: name,
  name,
  unread: 0,
  working: false,
  lastMessage: null,
})

describe("ui state", () => {
  test("defaults are valid", () => {
    expect(Schema.is(UiState)(defaultUiState)).toBe(true)
  })

  test("place list width stays between 200 and 400 px", () => {
    expect(clampPlaceListWidth(120)).toBe(200)
    expect(clampPlaceListWidth(512)).toBe(400)
    expect(clampPlaceListWidth(301.4)).toBe(301)
    expect(Schema.is(UiState)({ ...defaultUiState, placeListWidth: 401 })).toBe(false)
  })

  test("search keeps only places whose name matches", () => {
    const sections: PlaceSection[] = [
      { id: "agents", places: [place("Writer"), place("Reviewer"), place("Researcher")] },
    ]
    expect(filterPlaces(sections, "re")[0]?.places.map((p) => p.name)).toEqual([
      "Reviewer",
      "Researcher",
    ])
    expect(filterPlaces(sections, "WRI")[0]?.places.map((p) => p.name)).toEqual(["Writer"])
    expect(filterPlaces(sections, "  ")[0]?.places).toHaveLength(3)
  })
})
