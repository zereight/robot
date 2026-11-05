import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  allPlaces,
  builtInSection,
  clampPlaceListWidth,
  clampWorkflowSideWidth,
  defaultUiState,
  filterPlaces,
  listPage,
  type Place,
  type PlaceSection,
  placeMatches,
  sectionKind,
  summarize,
  UiState,
  WORKFLOW_CANVAS_MIN,
  WORKFLOW_HANDLE_WIDTH,
  WORKFLOW_SIDE_DEFAULT,
  WORKFLOW_SIDE_MAX,
  WORKFLOW_SIDE_MIN,
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

describe("When the user opens a list", () => {
  describe("with a routine", () => {
    test("should open the routines page", () => {
      expect(listPage("routine")).toBe("routines")
    })
  })

  describe("with a workflow", () => {
    test("should open the workflows page", () => {
      expect(listPage("workflow")).toBe("workflows")
    })
  })
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

  test("the workflow side column keeps its default and stays between its limits", () => {
    expect(defaultUiState.workflowSideWidth).toBe(WORKFLOW_SIDE_DEFAULT)
    expect(
      Schema.is(UiState)({ ...defaultUiState, workflowSideWidth: WORKFLOW_SIDE_MIN - 1 }),
    ).toBe(false)
    expect(
      Schema.is(UiState)({ ...defaultUiState, workflowSideWidth: WORKFLOW_SIDE_MAX + 1 }),
    ).toBe(false)
  })

  test("a width of the workflow side column is clamped to the limits, and rounded", () => {
    expect(clampWorkflowSideWidth(100)).toBe(WORKFLOW_SIDE_MIN)
    expect(clampWorkflowSideWidth(5000)).toBe(WORKFLOW_SIDE_MAX)
    expect(clampWorkflowSideWidth(401.4)).toBe(401)
  })

  test("a small workspace leaves room for the canvas, and never goes under the lowest width", () => {
    expect(clampWorkflowSideWidth(WORKFLOW_SIDE_MAX, 700)).toBe(
      700 - WORKFLOW_CANVAS_MIN - WORKFLOW_HANDLE_WIDTH,
    )
    expect(clampWorkflowSideWidth(WORKFLOW_SIDE_MAX, 300)).toBe(WORKFLOW_SIDE_MIN)
    expect(clampWorkflowSideWidth(0, 300)).toBe(WORKFLOW_SIDE_MIN)
    // A wide workspace does not raise the highest width.
    expect(clampWorkflowSideWidth(WORKFLOW_SIDE_MAX + 200, 3000)).toBe(WORKFLOW_SIDE_MAX)
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
    // Agents: user sections first, then the agents that are in no section.
    expect(allPlaces(sample()).map((p) => p.name)).toEqual(["Eve", "Finn", "Gus", "Ada", "Bo"])
    const channels: PlaceSection = {
      id: "channels",
      places: [place("Launch", { kind: "channel" })],
      sections: [
        {
          id: "r",
          name: "Research",
          places: [place("Chat", { kind: "channel", sectionId: "r" })],
        },
      ],
    }
    // Channels: a place with no section stays first.
    expect(allPlaces(channels).map((p) => p.name)).toEqual(["Launch", "Chat"])
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

describe("the filter of places by role line", () => {
  const withRoles = (): PlaceSection[] => [
    {
      id: "channels",
      places: [place("launch", { kind: "channel" }), place("design", { kind: "channel" })],
      sections: [],
    },
    {
      id: "agents",
      places: [place("Ada", { role: "Designer" }), place("Bo", { role: "Writer" }), place("Cy")],
      sections: [
        {
          id: "team",
          name: "Team",
          places: [place("Dee", { sectionId: "team", role: "Researcher" })],
        },
        { id: "ops", name: "Ops", places: [place("Eli", { sectionId: "ops", role: "Qa tester" })] },
      ],
    },
  ]
  const names = (sections: readonly PlaceSection[], id: "channels" | "agents") =>
    allPlaces(sections.find((s) => s.id === id) as PlaceSection).map((p) => p.name)

  test("an agent matches on part of its role line, ignoring case", () => {
    expect(names(filterPlaces(withRoles(), "design"), "agents")).toEqual(["Ada"])
    expect(names(filterPlaces(withRoles(), "DESIGN"), "agents")).toEqual(["Ada"])
    expect(names(filterPlaces(withRoles(), "writ"), "agents")).toEqual(["Bo"])
    expect(names(filterPlaces(withRoles(), " qa TEST "), "agents")).toEqual(["Eli"])
  })

  test("an agent still matches on its name, with or without a role line", () => {
    expect(names(filterPlaces(withRoles(), "bo"), "agents")).toEqual(["Bo"])
    expect(names(filterPlaces(withRoles(), "cy"), "agents")).toEqual(["Cy"])
  })

  test("a text that is in the name of one agent and in the role line of another gives both", () => {
    const list: PlaceSection[] = [
      { id: "agents", places: [place("Writer"), place("Ada", { role: "Writer" })], sections: [] },
    ]
    expect(names(filterPlaces(list, "writer"), "agents")).toEqual(["Writer", "Ada"])
  })

  test("a channel matches by its name only, also when a member has a role that matches", () => {
    // The word "design" is in the name of the channel "design" and in the role of Ada.
    expect(names(filterPlaces(withRoles(), "design"), "channels")).toEqual(["design"])
    // The role "Researcher" is in no channel name, so no channel shows.
    expect(names(filterPlaces(withRoles(), "researcher"), "channels")).toEqual([])
    // A channel with a stray role field still matches by name only.
    const stray: PlaceSection[] = [
      {
        id: "channels",
        places: [place("launch", { kind: "channel", role: "Designer" })],
        sections: [],
      },
    ]
    expect(names(filterPlaces(stray, "designer"), "channels")).toEqual([])
  })

  test("a user section opens on a role match, and one with no match leaves", () => {
    const [, agents] = filterPlaces(withRoles(), "researcher")
    expect(agents?.places).toEqual([])
    expect(agents?.sections.map((s) => [s.name, s.places.map((p) => p.name)])).toEqual([
      ["Team", ["Dee"]],
    ])
  })

  test("the order of places and sections does not change", () => {
    const [, agents] = filterPlaces(withRoles(), "e")
    expect(agents?.places.map((p) => p.name)).toEqual(["Ada", "Bo"])
    expect(agents?.sections.map((s) => s.name)).toEqual(["Team", "Ops"])
  })

  test("an empty text, or spaces, keeps every place; a role that is absent matches nothing", () => {
    expect(filterPlaces(withRoles(), "")).toHaveLength(2)
    expect(names(filterPlaces(withRoles(), "   "), "agents")).toHaveLength(5)
    expect(placeMatches(place("Cy"), "designer")).toBe(false)
    expect(placeMatches(place("Cy", { role: "" }), "x")).toBe(false)
  })
})
