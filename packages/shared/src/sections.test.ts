import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  canMoveSection,
  checkSectionName,
  moveInOrder,
  SECTION_NAME_MAX,
  SECTIONS_MAX,
  SectionCreate,
  sectionsFull,
} from "./sections.ts"

describe("section names", () => {
  test("a name has 1 to 40 characters after the spaces at both ends are removed", () => {
    expect(checkSectionName("", [])).toBe("empty")
    expect(checkSectionName("   ", [])).toBe("empty")
    expect(checkSectionName("R", [])).toBeNull()
    expect(checkSectionName("a".repeat(SECTION_NAME_MAX), [])).toBeNull()
    expect(checkSectionName("a".repeat(SECTION_NAME_MAX + 1), [])).toBe("long")
    // Spaces at the ends do not count.
    expect(checkSectionName(`  ${"a".repeat(SECTION_NAME_MAX)}  `, [])).toBeNull()
  })

  test("it counts characters that the user sees, not code units", () => {
    expect(checkSectionName("🙂".repeat(SECTION_NAME_MAX), [])).toBeNull()
    expect(checkSectionName("🙂".repeat(SECTION_NAME_MAX + 1), [])).toBe("long")
    expect(checkSectionName("연구".repeat(20), [])).toBeNull()
  })

  test("no two names in one list are the same, ignoring case and the spaces at the ends", () => {
    expect(checkSectionName("research", ["Research"])).toBe("taken")
    expect(checkSectionName("  RESEARCH ", ["Research"])).toBe("taken")
    expect(checkSectionName("Research 2", ["Research"])).toBeNull()
    expect(checkSectionName("Café", ["CAFÉ"])).toBe("taken")
    // Another list may use the name: the caller passes only the names of its own kind.
    expect(checkSectionName("Research", [])).toBeNull()
  })

  test("a bad length is told before a taken name", () => {
    expect(checkSectionName(" ", [" "])).toBe("empty")
  })
})

describe("the limit", () => {
  test("one built-in section holds at most 20 user sections", () => {
    expect(SECTIONS_MAX).toBe(20)
    expect(sectionsFull(19)).toBe(false)
    expect(sectionsFull(20)).toBe(true)
  })
})

describe("order", () => {
  const ids = ["a", "b", "c"]

  test("move up and move down are off at the ends", () => {
    expect(canMoveSection(ids, "a", "up")).toBe(false)
    expect(canMoveSection(ids, "a", "down")).toBe(true)
    expect(canMoveSection(ids, "c", "down")).toBe(false)
    expect(canMoveSection(ids, "c", "up")).toBe(true)
    expect(canMoveSection(ids, "b", "up")).toBe(true)
    expect(canMoveSection(ids, "b", "down")).toBe(true)
    expect(canMoveSection(ids, "zzz", "up")).toBe(false)
    expect(canMoveSection(["only"], "only", "up")).toBe(false)
    expect(canMoveSection(["only"], "only", "down")).toBe(false)
  })

  test("a step swaps a section with its neighbour and changes nothing else", () => {
    expect(moveInOrder(ids, "b", "up")).toEqual(["b", "a", "c"])
    expect(moveInOrder(ids, "b", "down")).toEqual(["a", "c", "b"])
    expect(moveInOrder(ids, "a", "down")).toEqual(["b", "a", "c"])
    expect(ids).toEqual(["a", "b", "c"])
  })

  test("at an end the order stays as it is", () => {
    expect(moveInOrder(ids, "a", "up")).toBe(ids)
    expect(moveInOrder(ids, "c", "down")).toBe(ids)
    expect(moveInOrder(ids, "zzz", "down")).toBe(ids)
  })

  test("many steps down bring a section to the end, in order", () => {
    let order: readonly string[] = ["a", "b", "c", "d"]
    for (let i = 0; i < 5; i++) order = moveInOrder(order, "a", "down")
    expect(order).toEqual(["b", "c", "d", "a"])
  })
})

describe("create input", () => {
  test("a kind is agent or channel", () => {
    const is = Schema.is(SectionCreate)
    expect(is({ serverId: "s", kind: "agent", name: "Research" })).toBe(true)
    expect(is({ serverId: "s", kind: "channel", name: "Research" })).toBe(true)
    expect(is({ serverId: "s", kind: "workflow", name: "Research" })).toBe(false)
  })
})
