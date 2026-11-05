import { describe, expect, test } from "bun:test"
import { orgsOnOneLine } from "./orgLine.ts"
import { type LineRepairOrg, orgRepairLines } from "./orgLineRepair.ts"

const org = (
  id: string,
  name: string,
  parentId: string | null,
  memberIds: readonly string[],
  extra: Partial<LineRepairOrg> = {},
): LineRepairOrg => ({ id, name, parentId, memberIds, createdAt: 1, ...extra })

const at = (l: number, c = 0) => ({ l, c, n: "x" })

/** What is left after the removals. */
const after = (orgs: readonly LineRepairOrg[], removals: ReturnType<typeof orgRepairLines>) =>
  orgs.map((o) => ({
    ...o,
    memberIds: o.memberIds.filter(
      (a) => !removals.some((r) => r.orgId === o.id && r.agentId === a),
    ),
  }))

describe("orgRepairLines (spec 030, 'One line', 'Repair')", () => {
  test("nothing for members that are on one line", () => {
    const orgs = [
      org("product", "Product", null, ["a"]),
      org("docs", "Docs", "product", ["a", "b"]),
      org("site", "Site", "docs", ["a"]),
      org("ops", "Ops", null, ["c"]),
    ]
    expect(orgRepairLines(orgs)).toEqual([])
  })

  test("two computers add the same agent to Docs and Ops: the later change leaves", () => {
    const orgs = [
      org("docs", "Docs", null, ["a"], { membersChanged: at(5) }),
      org("ops", "Ops", null, ["a"], { membersChanged: at(7) }),
    ]
    expect(orgRepairLines(orgs)).toEqual([{ agentId: "a", orgId: "ops", otherId: "docs" }])
    const earlier = [
      org("docs", "Docs", null, ["a"], { membersChanged: at(9) }),
      org("ops", "Ops", null, ["a"], { membersChanged: at(7) }),
    ]
    expect(orgRepairLines(earlier)).toEqual([{ agentId: "a", orgId: "docs", otherId: "ops" }])
  })

  test("the counter of a time decides when the logical times are equal", () => {
    const orgs = [
      org("docs", "Docs", null, ["a"], { membersChanged: at(5, 2) }),
      org("ops", "Ops", null, ["a"], { membersChanged: at(5, 1) }),
    ]
    expect(orgRepairLines(orgs).map((r) => r.orgId)).toEqual(["docs"])
  })

  test("the computer name does not make a change later", () => {
    const orgs = [
      org("docs", "Docs", null, ["a"], { membersChanged: { l: 5, c: 0, n: "z" }, createdAt: 2 }),
      org("ops", "Ops", null, ["a"], { membersChanged: { l: 5, c: 0, n: "a" }, createdAt: 1 }),
    ]
    // Equal times: the organization that was made later.
    expect(orgRepairLines(orgs).map((r) => r.orgId)).toEqual(["docs"])
  })

  test("equal times: the organization that was made later, then the later id", () => {
    const made = [
      org("docs", "Docs", null, ["a"], { createdAt: 10, membersChanged: at(5) }),
      org("ops", "Ops", null, ["a"], { createdAt: 20, membersChanged: at(5) }),
    ]
    expect(orgRepairLines(made).map((r) => r.orgId)).toEqual(["ops"])
    const sameMoment = [
      org("docs", "Docs", null, ["a"], { createdAt: 10 }),
      org("ops", "Ops", null, ["a"], { createdAt: 10 }),
    ]
    expect(orgRepairLines(sameMoment).map((r) => r.orgId)).toEqual(["ops"])
    expect(orgRepairLines([...sameMoment].reverse()).map((r) => r.orgId)).toEqual(["ops"])
  })

  test("an unknown time (an import) counts as the oldest: the tie order decides", () => {
    const orgs = [
      org("docs", "Docs", null, ["a"], { createdAt: 10 }),
      org("ops", "Ops", null, ["a"], { createdAt: 20, membersChanged: at(1) }),
    ]
    // The known time of Ops is later than the unknown time of Docs.
    expect(orgRepairLines(orgs).map((r) => r.orgId)).toEqual(["ops"])
    const flipped = [
      org("docs", "Docs", null, ["a"], { createdAt: 30 }),
      org("ops", "Ops", null, ["a"], { createdAt: 20 }),
    ]
    expect(orgRepairLines(flipped).map((r) => r.orgId)).toEqual(["docs"])
  })

  test("an agent in Product, Docs and a new unrelated Ops: only Ops goes", () => {
    const orgs = [
      org("product", "Product", null, ["a"], { createdAt: 1 }),
      org("docs", "Docs", "product", ["a"], { createdAt: 2 }),
      org("ops", "Ops", null, ["a"], { createdAt: 3 }),
    ]
    const removals = orgRepairLines(orgs)
    expect(removals).toEqual([{ agentId: "a", orgId: "ops", otherId: "docs" }])
    expect(orgsOnOneLine(orgs, ["product", "docs"])).toBe(true)
  })

  test("the other organization is the first of the conflicting ones in the order of names", () => {
    const orgs = [
      org("product", "Product", null, ["a"], { createdAt: 1 }),
      org("docs", "docs", "product", ["a"], { createdAt: 2 }),
      org("ops", "Ops", null, ["a"], { createdAt: 3 }),
    ]
    expect(orgRepairLines(orgs)[0]?.otherId).toBe("docs")
  })

  test("a parent change that splits a line: the membership joined later goes", () => {
    // Docs was under Product; now Docs sits under Ops, so Product and Docs are apart.
    const orgs = [
      org("product", "Product", null, ["a"], { membersChanged: at(2) }),
      org("ops", "Ops", null, []),
      org("docs", "Docs", "ops", ["a"], { membersChanged: at(4) }),
    ]
    expect(orgRepairLines(orgs)).toEqual([{ agentId: "a", orgId: "docs", otherId: "product" }])
  })

  test("it goes on until the organizations of the agent are on one line", () => {
    const orgs = [
      org("x", "X", null, ["a"], { membersChanged: at(1) }),
      org("y", "Y", null, ["a"], { membersChanged: at(2) }),
      org("z", "Z", null, ["a"], { membersChanged: at(3) }),
    ]
    const removals = orgRepairLines(orgs)
    expect(removals.map((r) => r.orgId)).toEqual(["z", "y"])
    expect(removals.map((r) => r.otherId)).toEqual(["x", "x"])
  })

  test("the member that is in no pair apart is never removed", () => {
    // Product, Docs (under Product), Site (under Docs) and Ops: the agent is in Product, Site, Ops.
    const orgs = [
      org("product", "Product", null, ["a"], { membersChanged: at(1) }),
      org("docs", "Docs", "product", []),
      org("site", "Site", "docs", ["a"], { membersChanged: at(2) }),
      org("ops", "Ops", null, ["a"], { membersChanged: at(3) }),
    ]
    // Product and Site are on one line, Ops is apart from both: the later one goes.
    expect(orgRepairLines(orgs).map((r) => r.orgId)).toEqual(["ops"])
  })

  test("several agents are repaired by themselves", () => {
    const orgs = [
      org("docs", "Docs", null, ["a", "b", "c"], { membersChanged: at(2) }),
      org("ops", "Ops", null, ["a", "c"], { membersChanged: at(1) }),
      org("press", "Press", null, ["b"], { membersChanged: at(3) }),
    ]
    const removals = orgRepairLines(orgs)
    expect(removals).toEqual(
      expect.arrayContaining([
        { agentId: "a", orgId: "docs", otherId: "ops" },
        { agentId: "c", orgId: "docs", otherId: "ops" },
        { agentId: "b", orgId: "press", otherId: "docs" },
      ]),
    )
    expect(removals).toHaveLength(3)
  })

  test("the result is the same for any order of the input", () => {
    const orgs = [
      org("docs", "Docs", null, ["a", "b"], { membersChanged: at(2), createdAt: 5 }),
      org("ops", "Ops", null, ["a", "b"], { membersChanged: at(2), createdAt: 5 }),
      org("press", "Press", null, ["b"], { membersChanged: at(2), createdAt: 5 }),
    ]
    const key = (list: readonly LineRepairOrg[]) =>
      JSON.stringify(
        orgRepairLines(list)
          .map((r) => `${r.agentId}/${r.orgId}/${r.otherId}`)
          .sort(),
      )
    const base = key(orgs)
    expect(key([...orgs].reverse())).toBe(base)
    expect(
      key([orgs[1] as LineRepairOrg, orgs[2] as LineRepairOrg, orgs[0] as LineRepairOrg]),
    ).toBe(base)
  })

  test("running it again on the result changes nothing", () => {
    const orgs = [
      org("x", "X", null, ["a", "b"], { membersChanged: at(1) }),
      org("y", "Y", null, ["a"], { membersChanged: at(2) }),
      org("z", "Z", "x", ["b", "a"], { membersChanged: at(3) }),
    ]
    const removals = orgRepairLines(orgs)
    expect(removals.length).toBeGreaterThan(0)
    expect(orgRepairLines(after(orgs, removals))).toEqual([])
  })

  test("an organization with a broken parent is read as the tree reads it", () => {
    // The parent is not an organization here: Docs counts as a top organization.
    const orgs = [
      org("docs", "Docs", "gone", ["a"], { membersChanged: at(1) }),
      org("ops", "Ops", null, ["a"], { membersChanged: at(2) }),
    ]
    expect(orgRepairLines(orgs).map((r) => r.orgId)).toEqual(["ops"])
  })
})
