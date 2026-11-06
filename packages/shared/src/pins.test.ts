import { describe, expect, test } from "bun:test"
import {
  canMovePlace,
  dropInList,
  listOfPlace,
  moveInList,
  orderByPosition,
  PINNED_MAX,
  pinnedPlaces,
  pinsFull,
  withoutPinned,
} from "./pins.ts"
import type { Place, PlaceSection } from "./ui.ts"

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

const sections = (): PlaceSection[] => [
  {
    id: "agents",
    places: [place("a1"), place("a2", { pinRank: 0 })],
    sections: [
      {
        id: "s",
        name: "S",
        places: [place("a3", { sectionId: "s" }), place("a4", { sectionId: "s" })],
      },
    ],
  },
]

describe("pins", () => {
  test("the group holds 10 places", () => {
    expect(PINNED_MAX).toBe(10)
    expect(pinsFull(9)).toBe(false)
    expect(pinsFull(10)).toBe(true)
  })

  test("the pinned places come from every section, by rank", () => {
    expect(pinnedPlaces(sections()).map((p) => p.id)).toEqual(["a2"])
  })

  test("a pinned place leaves its section", () => {
    const rest = withoutPinned(sections())
    expect(rest[0]?.places.map((p) => p.id)).toEqual(["a1"])
    expect(rest[0]?.sections[0]?.places.map((p) => p.id)).toEqual(["a3", "a4"])
  })

  test("a part with no pinned place stays the same object", () => {
    const all = sections()
    const rest = withoutPinned(all)
    expect(rest[0]?.sections[0]).toBe(all[0]?.sections[0])
    const none = [{ ...(all[0] as PlaceSection), places: [place("c9")] }]
    expect(withoutPinned(none)[0]).toBe(none[0])
  })
})

describe("order of places", () => {
  test("ordered places come first, the others keep their order", () => {
    const items = [
      { id: "a", position: null },
      { id: "b", position: 1 },
      { id: "c", position: null },
      { id: "d", position: 0 },
    ]
    expect(orderByPosition(items, (i) => i.position).map((i) => i.id)).toEqual(["d", "b", "a", "c"])
  })

  test("the list of a place is its section, or the group when it is pinned", () => {
    const all = sections()
    expect(listOfPlace(all, { kind: "agent", id: "a4" }).map((p) => p.id)).toEqual(["a3", "a4"])
    expect(listOfPlace(all, { kind: "agent", id: "a1" }).map((p) => p.id)).toEqual(["a1"])
    expect(listOfPlace(all, { kind: "agent", id: "a2" }).map((p) => p.id)).toEqual(["a2"])
    expect(listOfPlace(all, { kind: "agent", id: "none" })).toEqual([])
  })

  test("a step up or down stops at the ends", () => {
    const list = [place("x"), place("y"), place("z")]
    expect(canMovePlace(list, { kind: "agent", id: "x" }, "up")).toBe(false)
    expect(canMovePlace(list, { kind: "agent", id: "z" }, "down")).toBe(false)
    expect(canMovePlace(list, { kind: "agent", id: "y" }, "up")).toBe(true)
    expect(moveInList(list, { kind: "agent", id: "y" }, "up").map((r) => r.id)).toEqual([
      "y",
      "x",
      "z",
    ])
    expect(moveInList(list, { kind: "agent", id: "z" }, "down").map((r) => r.id)).toEqual([
      "x",
      "y",
      "z",
    ])
  })

  test("a drop puts the place before another place, or last", () => {
    const list = [place("x"), place("y"), place("z")]
    const z = { kind: "agent", id: "z" } as const
    const x = { kind: "agent", id: "x" } as const
    expect(dropInList(list, z, x).map((r) => r.id)).toEqual(["z", "x", "y"])
    expect(dropInList(list, x, null).map((r) => r.id)).toEqual(["y", "z", "x"])
    expect(dropInList(list, x, x).map((r) => r.id)).toEqual(["x", "y", "z"])
  })
})
