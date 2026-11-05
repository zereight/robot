import { describe, expect, test } from "bun:test"
import { deepestOrgIndex } from "./orgPrefix.ts"
import { NO_ORG_SECTION_ID, organizationSections, orgSectionKey } from "./orgSections.ts"
import type { Place } from "./ui.ts"

const agent = (id: string, name = id): Place => ({
  kind: "agent",
  id,
  name,
  unread: 0,
  working: false,
  lastMessage: null,
  sectionId: null,
})

const org = (id: string, name: string, memberIds: string[], parentId: string | null = null) => ({
  id,
  name,
  memberIds,
  parentId,
})

const group = (agents: Place[], orgs: ReturnType<typeof org>[]) => {
  const index = deepestOrgIndex(orgs)
  return organizationSections(agents, (id) => index.get(id))
}

const shape = (result: ReturnType<typeof group>) => ({
  sections: result.sections.map((s) => [s.name, s.places.map((p) => p.id)]),
  none: result.none.map((p) => p.id),
})

describe("agents by organization (spec 001, Agents by organization)", () => {
  test("Ada in Docs, Bob in Docs and its sub-organization API, Cy in none", () => {
    const orgs = [org("d", "Docs", ["ada", "bob"]), org("a", "API", ["bob"], "d")]
    expect(shape(group([agent("ada"), agent("bob"), agent("cy")], orgs))).toEqual({
      sections: [
        ["API", ["bob"]],
        ["Docs", ["ada"]],
      ],
      none: ["cy"],
    })
  })

  test("an agent shows once, and the sections are flat", () => {
    const orgs = [org("d", "Docs", ["bob"]), org("a", "API", ["bob"], "d")]
    const result = group([agent("bob")], orgs)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]?.id).toBe(orgSectionKey("a"))
  })

  test("an organization that is the deepest of no agent has no section", () => {
    const orgs = [org("d", "Docs", ["ada"]), org("e", "Empty", []), org("o", "Other", ["gone"])]
    expect(shape(group([agent("ada")], orgs)).sections).toEqual([["Docs", ["ada"]]])
  })

  test("the sections follow the names, ignoring case, and then the id", () => {
    const orgs = [
      org("3", "docs", ["c"]),
      org("1", "beta", ["a"]),
      org("2", "Alpha", ["b"]),
      org("5", "Same", ["e"]),
      org("4", "same", ["d"]),
    ]
    const result = group(
      ["a", "b", "c", "d", "e"].map((id) => agent(id)),
      orgs,
    )
    expect(result.sections.map((s) => s.name)).toEqual(["Alpha", "beta", "docs", "same", "Same"])
  })

  test("the agents of a section and of no organization keep the order they came in", () => {
    const orgs = [org("d", "Docs", ["z", "a", "m"])]
    const result = group([agent("z"), agent("x"), agent("a"), agent("y"), agent("m")], orgs)
    expect(shape(result)).toEqual({ sections: [["Docs", ["z", "a", "m"]]], none: ["x", "y"] })
  })

  test("with no agent there is nothing", () => {
    expect(shape(group([], [org("d", "Docs", ["ada"])]))).toEqual({ sections: [], none: [] })
  })

  test("the collapse keys of the sections are different from each other and from user sections", () => {
    expect(orgSectionKey("d")).not.toBe(orgSectionKey("e"))
    expect(orgSectionKey("d")).not.toBe(NO_ORG_SECTION_ID)
    expect(orgSectionKey("d")).not.toBe("unassigned:agents")
  })
})
