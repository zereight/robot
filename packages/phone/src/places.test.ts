import { expect, test } from "bun:test"
import { allPlaces, loosePlacesFirst } from "./places.ts"

const place = (name: string, sectionId: string | null) => ({
  kind: "agent" as const,
  id: name,
  name,
  unread: 0,
  working: false,
  lastMessage: null,
  sectionId,
})

test("agents with no section come after the user sections", () => {
  expect(loosePlacesFirst("agents")).toBe(false)
  expect(loosePlacesFirst("channels")).toBe(true)
  const names = allPlaces({
    id: "agents",
    places: [place("Ada", null), place("Bo", null)],
    sections: [{ id: "r", name: "Research", places: [place("Eve", "r")] }],
  }).map((p) => p.name)
  expect(names).toEqual(["Eve", "Ada", "Bo"])
})

test("channels with no section stay before the user sections", () => {
  const names = allPlaces({
    id: "channels",
    places: [place("Launch", null)],
    sections: [{ id: "r", name: "Research", places: [place("Chat", "r")] }],
  }).map((p) => p.name)
  expect(names).toEqual(["Launch", "Chat"])
})
