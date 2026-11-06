import { expect, test } from "bun:test"
import { allPlaces, serverUnread, shownSections } from "./places.ts"

const place = (name: string, sectionId: string | null, unread = 0) => ({
  kind: "agent" as const,
  id: name,
  name,
  unread,
  working: false,
  lastMessage: null,
  sectionId,
})

test("agents with no section come after the user sections", () => {
  const names = allPlaces({
    id: "agents",
    places: [place("Ada", null), place("Bo", null)],
    sections: [{ id: "r", name: "Research", places: [place("Eve", "r")] }],
  }).map((p) => p.name)
  expect(names).toEqual(["Eve", "Ada", "Bo"])
})

test("the Channels section of an older server does not show and does not count (spec 011)", () => {
  const sections = [
    { id: "channels" as const, places: [place("Launch", null, 4)], sections: [] },
    { id: "agents" as const, places: [place("Ada", null, 2)], sections: [] },
  ]
  expect(shownSections(sections).map((s) => s.id)).toEqual(["agents"])
  expect(serverUnread(sections)).toBe(2)
  expect(shownSections(null)).toEqual([])
})
