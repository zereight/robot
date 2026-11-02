import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  allPlaces,
  builtInSection,
  clampPlaceListWidth,
  defaultUiState,
  filterPlaces,
  type Place,
  type PlaceSection,
  sectionKind,
  summarize,
  UiState,
} from "./ui.ts"

const place = (name: string, extra: Partial<Place> = {}): Place => ({
  kind: "agent",
  id: name,
  name,
  unread: 0,
  working: false,
  lastMessage: null,
  sectionId: null,
  ...extra,
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
      {
        id: "agents",
        places: [place("Writer"), place("Reviewer"), place("Researcher")],
        sections: [],
      },
    ]
    expect(filterPlaces(sections, "re")[0]?.places.map((p) => p.name)).toEqual([
      "Reviewer",
      "Researcher",
    ])
    expect(filterPlaces(sections, "WRI")[0]?.places.map((p) => p.name)).toEqual(["Writer"])
    expect(filterPlaces(sections, "  ")[0]?.places).toHaveLength(3)
  })
})

/** Agents with no section: Ada, Bo. Section "Research": Eve (2 unread), Finn. Section "Ops": Gus. */
const sample = (): PlaceSection => ({
  id: "agents",
  places: [place("Ada", { unread: 1 }), place("Bo")],
  sections: [
    {
      id: "research",
      name: "Research",
      places: [
        place("Eve", { unread: 2, sectionId: "research" }),
        place("Finn", { sectionId: "research", working: true }),
      ],
    },
    { id: "ops", name: "Ops", places: [place("Gus", { sectionId: "ops" })] },
    { id: "empty", name: "Empty", places: [] },
  ],
})

describe("user sections in the place list", () => {
  test("a built-in section knows the kind of its places, and the other way round", () => {
    expect(sectionKind("agents")).toBe("agent")
    expect(sectionKind("channels")).toBe("channel")
    expect(builtInSection("agent")).toBe("agents")
    expect(builtInSection("channel")).toBe("channels")
  })

  test("all places of a built-in section include its user sections, in the order shown", () => {
    expect(allPlaces(sample()).map((p) => p.name)).toEqual(["Ada", "Bo", "Eve", "Finn", "Gus"])
  })

  test("the sum of unread counts and the working dot of a section", () => {
    const [none, research, ops, empty] = [
      sample().places,
      sample().sections[0]?.places ?? [],
      sample().sections[1]?.places ?? [],
      sample().sections[2]?.places ?? [],
    ]
    expect(summarize(research)).toEqual({ unread: 2, working: true })
    expect(summarize(ops)).toEqual({ unread: 0, working: false })
    expect(summarize(empty)).toEqual({ unread: 0, working: false })
    expect(summarize(none)).toEqual({ unread: 1, working: false })
  })

  test("the sum of a built-in section includes the places of its user sections", () => {
    expect(summarize(allPlaces(sample()))).toEqual({ unread: 3, working: true })
    // A built-in section where only a user section has unread messages still shows them.
    const only: PlaceSection = {
      id: "agents",
      places: [place("Ada")],
      sections: [{ id: "r", name: "R", places: [place("Eve", { unread: 4, sectionId: "r" })] }],
    }
    expect(summarize(allPlaces(only))).toEqual({ unread: 4, working: false })
  })

  test("search keeps the places that match inside user sections too", () => {
    const [found] = filterPlaces([sample()], "e")
    expect(found?.places.map((p) => p.name)).toEqual([])
    expect(found?.sections.map((s) => [s.name, s.places.map((p) => p.name)])).toEqual([
      ["Research", ["Eve"]],
    ])
  })

  test("a section with no match leaves the list, also an empty one", () => {
    const [found] = filterPlaces([sample()], "gus")
    expect(found?.places).toEqual([])
    expect(found?.sections.map((s) => s.name)).toEqual(["Ops"])
    const [none] = filterPlaces([sample()], "zzz")
    expect(allPlaces(none as PlaceSection)).toEqual([])
    expect(none?.sections).toEqual([])
  })

  test("search looks at the names of places only, not at the names of sections", () => {
    const [found] = filterPlaces([sample()], "research")
    expect(allPlaces(found as PlaceSection)).toEqual([])
  })

  test("the order of sections and places does not change", () => {
    const [found] = filterPlaces([sample()], "i")
    expect(found?.sections.map((s) => s.name)).toEqual(["Research"])
    const [all] = filterPlaces([sample()], "")
    expect(all?.sections.map((s) => s.name)).toEqual(["Research", "Ops", "Empty"])
  })
})
