import { describe, expect, test } from "bun:test"
import {
  addMemberChange,
  memberLineConflict,
  moveMemberChanges,
  onOneLine,
  orgLineRefusal,
  orgsOnOneLine,
  parentLineConflict,
  parentLineReasons,
} from "./orgLine.ts"

const agent = (id: string, name = id) => ({ id, name })
const org = (
  id: string,
  name: string,
  parentId: string | null = null,
  memberIds: readonly string[] = [],
) => ({ id, name, parentId, memberIds })

const agents = [agent("a", "A"), agent("b", "B"), agent("c", "c")]

describe("onOneLine (spec 030, 'One line')", () => {
  // Product > Docs > Site, and Product > Press, and a top organization Ops.
  const tree = [
    org("product", "Product"),
    org("docs", "Docs", "product"),
    org("site", "Site", "docs"),
    org("press", "Press", "product"),
    org("ops", "Ops"),
  ]

  test("an organization and a higher organization are on one line, at any distance", () => {
    expect(onOneLine(tree, "docs", "product")).toBe(true)
    expect(onOneLine(tree, "site", "product")).toBe(true)
    expect(onOneLine(tree, "product", "site")).toBe(true)
  })

  test("an organization is on one line with itself", () => {
    expect(onOneLine(tree, "ops", "ops")).toBe(true)
  })

  test("two sub-organizations of one parent are not on one line", () => {
    expect(onOneLine(tree, "docs", "press")).toBe(false)
    expect(onOneLine(tree, "site", "press")).toBe(false)
  })

  test("a top organization is not on one line with another tree", () => {
    expect(onOneLine(tree, "docs", "ops")).toBe(false)
    expect(onOneLine(tree, "ops", "product")).toBe(false)
  })

  test("a list is on one line when each two of them are", () => {
    expect(orgsOnOneLine(tree, ["product", "docs", "site"])).toBe(true)
    expect(orgsOnOneLine(tree, ["docs", "site"])).toBe(true)
    expect(orgsOnOneLine(tree, ["product", "docs", "press"])).toBe(false)
    expect(orgsOnOneLine(tree, [])).toBe(true)
    expect(orgsOnOneLine(tree, ["ops"])).toBe(true)
  })
})

describe("add a member (030 'One line', check 1)", () => {
  // "Docs" is under "Product". "Ops" is a top organization. A is a member of "Docs".
  const state = [
    org("product", "Product"),
    org("docs", "Docs", "product", ["a"]),
    org("ops", "Ops"),
  ]

  test("adding A to the higher organization works", () => {
    expect(orgLineRefusal(state, agents, [addMemberChange(state, "product", "a")])).toBeUndefined()
  })

  test("adding A to Ops is refused: A is in Docs, which is not on one line with Ops", () => {
    expect(orgLineRefusal(state, agents, [addMemberChange(state, "ops", "a")])).toEqual({
      kind: "member",
      agentId: "a",
      orgId: "ops",
      otherId: "docs",
    })
  })

  test("the form of Ops shows A muted with 'In Docs.' and the list of A shows Ops muted with the same org", () => {
    expect(memberLineConflict(state, agents, "a", "ops")).toBe("docs")
    expect(memberLineConflict(state, agents, "a", "product")).toBeUndefined()
    expect(memberLineConflict(state, agents, "b", "ops")).toBeUndefined()
  })

  test("two sub-organizations of one parent: B cannot be in both, but can be in Docs and below Docs", () => {
    const two = [
      org("product", "Product"),
      org("docs", "Docs", "product", ["b"]),
      org("site", "Site", "product"),
      org("blog", "Blog", "docs"),
    ]
    expect(memberLineConflict(two, agents, "b", "site")).toBe("docs")
    expect(memberLineConflict(two, agents, "b", "blog")).toBeUndefined()
  })

  test("other is the first conflicting organization in the order of names, ignoring case", () => {
    const many = [
      org("top", "Top", null, []),
      org("z", "zeta", "top", ["a"]),
      org("b", "Beta", "top", ["a"]),
      org("n", "new", "top"),
    ]
    expect(memberLineConflict(many, agents, "a", "n")).toBe("b")
  })

  test("an agent that is archived still counts: the rule reads the members, not the state", () => {
    const archived = [{ ...agent("a", "A"), archived: true }]
    expect(orgLineRefusal(state, archived, [addMemberChange(state, "ops", "a")])?.kind).toBe(
      "member",
    )
  })

  test("a removal is always allowed, also from a state that is off the line", () => {
    const broken = [org("docs", "Docs", null, ["a"]), org("ops", "Ops", null, ["a"])]
    expect(
      orgLineRefusal(broken, agents, [
        { id: "ops", memberIds: [] },
        { id: "docs", memberIds: [] },
      ]),
    ).toBeUndefined()
  })

  test("an agent that is already a member needs no check when it stays", () => {
    const broken = [org("docs", "Docs", null, ["a"]), org("ops", "Ops", null, ["a"])]
    expect(orgLineRefusal(broken, agents, [{ id: "ops", memberIds: ["a", "b"] }])).toBeUndefined()
  })

  test("a new organization checks each member it starts with", () => {
    expect(
      orgLineRefusal(state, agents, [{ id: "new", name: "New", parentId: null, memberIds: ["a"] }]),
    ).toEqual({ kind: "member", agentId: "a", orgId: "new", otherId: "docs" })
    expect(
      orgLineRefusal(state, agents, [
        { id: "new", name: "New", parentId: "docs", memberIds: ["a"] },
      ]),
    ).toBeUndefined()
  })
})

describe("move a member (030 'One line', check 1)", () => {
  // A is a member of "Docs" and "Product". "Ops" is a sub-organization of "Product".
  const state = [
    org("product", "Product", null, ["a"]),
    org("docs", "Docs", "product", ["a"]),
    org("ops", "Ops", "product"),
  ]

  test("the check runs after A has left the source: Docs to Ops works", () => {
    expect(
      orgLineRefusal(state, agents, moveMemberChanges(state, "a", "docs", "ops")),
    ).toBeUndefined()
  })

  test("the same add without the leave is refused", () => {
    expect(orgLineRefusal(state, agents, [addMemberChange(state, "ops", "a")])).toEqual({
      kind: "member",
      agentId: "a",
      orgId: "ops",
      otherId: "docs",
    })
  })

  test("the list 'Move to organization…' reads the conflict after the leave", () => {
    expect(memberLineConflict(state, agents, "a", "ops", { leavingId: "docs" })).toBeUndefined()
    expect(memberLineConflict(state, agents, "a", "ops")).toBe("docs")
  })

  test("a move to an organization that is off the line of the other membership is refused", () => {
    const off = [
      org("product", "Product", null, ["a"]),
      org("docs", "Docs", "product", ["a"]),
      org("ops", "Ops"),
    ]
    expect(orgLineRefusal(off, agents, moveMemberChanges(off, "a", "docs", "ops"))).toEqual({
      kind: "member",
      agentId: "a",
      orgId: "ops",
      otherId: "product",
    })
  })
})

describe("a new parent organization (030 'One line', check 2)", () => {
  // A is a member of "Product" and "Docs" (on one line). "Ops" is a top organization.
  const state = [
    org("product", "Product", null, ["a"]),
    org("docs", "Docs", "product", ["a"]),
    org("ops", "Ops"),
  ]

  test("Docs under Ops is refused: A is in Docs and Product, which would not be on one line", () => {
    expect(orgLineRefusal(state, agents, [{ id: "docs", parentId: "ops" }])).toEqual({
      kind: "parent",
      agentId: "a",
      aId: "docs",
      bId: "product",
    })
  })

  test("'Move to the top' on Docs is refused in the same way", () => {
    expect(orgLineRefusal(state, agents, [{ id: "docs", parentId: null }])).toEqual({
      kind: "parent",
      agentId: "a",
      aId: "docs",
      bId: "product",
    })
  })

  test("the list 'Put under…' shows Ops muted with the agent, and the parent now works", () => {
    const reasons = parentLineReasons(state, agents, "docs")
    expect(reasons.get("ops")).toBe("a")
    expect(reasons.has("product")).toBe(false)
  })

  test("after A leaves Product the move works", () => {
    const left = [
      org("product", "Product"),
      org("docs", "Docs", "product", ["a"]),
      org("ops", "Ops"),
    ]
    expect(orgLineRefusal(left, agents, [{ id: "docs", parentId: "ops" }])).toBeUndefined()
    expect(parentLineConflict(left, agents, "docs", "ops")).toBeUndefined()
  })

  test("the same parent again is no change and needs no check", () => {
    expect(orgLineRefusal(state, agents, [{ id: "docs", parentId: "product" }])).toBeUndefined()
  })

  test("a move up never breaks a line", () => {
    const deep = [
      org("product", "Product", null, ["a"]),
      org("docs", "Docs", "product"),
      org("site", "Site", "docs", ["a"]),
    ]
    expect(orgLineRefusal(deep, agents, [{ id: "site", parentId: "product" }])).toBeUndefined()
  })

  test("a sub-organization moves with its lower organizations", () => {
    // A is in Product and in Site, which is below Docs. Docs goes under Ops: Site goes with it.
    const deep = [
      org("product", "Product", null, ["a"]),
      org("docs", "Docs", "product"),
      org("site", "Site", "docs", ["a"]),
      org("ops", "Ops"),
    ]
    expect(orgLineRefusal(deep, agents, [{ id: "docs", parentId: "ops" }])).toEqual({
      kind: "parent",
      agentId: "a",
      aId: "product",
      bId: "site",
    })
    // Without A in Product the move works.
    const alone = deep.map((o) => (o.id === "product" ? { ...o, memberIds: [] } : o))
    expect(orgLineRefusal(alone, agents, [{ id: "docs", parentId: "ops" }])).toBeUndefined()
  })

  test("the first agent and the first pair in the order of names are named", () => {
    const three = [
      org("top", "Top", null, ["b", "c"]),
      org("m", "Mid", "top", ["b", "c"]),
      org("q", "Quill", "m", ["b", "c"]),
      org("ops", "Ops"),
    ]
    // Mid under Ops: Top / Mid and Top / Quill do not hold; Mid / Quill still holds.
    const refusal = orgLineRefusal(
      three,
      [agent("c", "c"), agent("b", "B")],
      [{ id: "m", parentId: "ops" }],
    )
    expect(refusal).toEqual({ kind: "parent", agentId: "b", aId: "m", bId: "top" })
  })

  test("a pair that was off the line before the change is not named", () => {
    const broken = [
      org("product", "Product", null, ["a"]),
      org("docs", "Docs", null, ["a"]),
      org("ops", "Ops"),
    ]
    expect(orgLineRefusal(broken, agents, [{ id: "ops", parentId: "product" }])).toBeUndefined()
  })
})

describe("a save of the form is one change (030 'One line')", () => {
  // A is a member of "Docs", under "Product". "Site" is a top organization.
  const state = [
    org("product", "Product"),
    org("docs", "Docs", "product", ["a"]),
    org("site", "Site"),
  ]

  test("adding A and setting the parent together works when the new tree puts them on one line", () => {
    expect(
      orgLineRefusal(state, agents, [{ id: "site", parentId: "docs", memberIds: ["a"] }]),
    ).toBeUndefined()
  })

  test("the member alone would be refused", () => {
    expect(orgLineRefusal(state, agents, [addMemberChange(state, "site", "a")])?.kind).toBe(
      "member",
    )
  })

  test("a parent that splits the line of a member that the form adds is refused", () => {
    const refusal = orgLineRefusal(state, agents, [
      { id: "site", parentId: "product", memberIds: ["a"] },
    ])
    expect(refusal).toEqual({ kind: "member", agentId: "a", orgId: "site", otherId: "docs" })
  })

  test("the parent options of the form read the ticked members", () => {
    const reasons = parentLineReasons(state, agents, "site", ["a"])
    expect(reasons.get("product")).toBe("a")
    expect(reasons.has("docs")).toBe(false)
  })
})
