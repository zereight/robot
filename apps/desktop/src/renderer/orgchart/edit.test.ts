import { describe, expect, test } from "bun:test"
import {
  agentsFor,
  dropEdit,
  EDGE_PX,
  EDGE_SPEED,
  type EditOrg,
  edgeStep,
  NOTICE_MS,
  noticeMs,
  orgDropEdit,
  orgsFor,
  parentChoices,
  planEdit,
  UNDONE_MS,
  undoSteps,
} from "./edit.ts"

// Spec 029, "Edit on the chart": the lists of the menus, where a drop is allowed, the patches of
// each change, and Undo.

const docs: EditOrg = { id: "docs", name: "Docs", leadId: "a", memberIds: ["a", "b", "c"] }
const ops: EditOrg = { id: "ops", name: "ops", leadId: null, memberIds: ["d"] }
const art: EditOrg = { id: "art", name: "Art", leadId: null, memberIds: [] }
const all = [docs, ops, art]

/** The organizations after the steps, as the server would store them. */
const after = (
  orgs: readonly EditOrg[],
  steps: readonly {
    orgId: string
    patch: { memberIds?: readonly string[]; leadId?: string | null; parentId?: string | null }
  }[],
) =>
  orgs.map((o) => {
    let now: EditOrg = o
    for (const s of steps) {
      if (s.orgId !== o.id) continue
      now = {
        ...now,
        memberIds: s.patch.memberIds ?? now.memberIds,
        leadId: s.patch.leadId !== undefined ? s.patch.leadId : now.leadId,
        parentId: s.patch.parentId !== undefined ? s.patch.parentId : (now.parentId ?? null),
      }
    }
    return now
  })

describe("the lists of the menus", () => {
  test("Add to organization and Move to organization list the organizations where the agent is no member, by name", () => {
    expect(orgsFor("b", all).map((o) => o.id)).toEqual(["art", "ops"])
    expect(orgsFor("x", all).map((o) => o.name)).toEqual(["Art", "Docs", "ops"])
  })

  test("Add member lists the agents that are not members, by name", () => {
    const agents = [
      { id: "d", name: "dee" },
      { id: "a", name: "Ada" },
      { id: "e", name: "Eve" },
      { id: "b", name: "Bo" },
    ]
    expect(agentsFor(docs, agents, all).map((a) => a.name)).toEqual(["dee", "Eve"])
  })
})

describe("a drop", () => {
  test("on another organization node moves the agent; with Option it adds the agent", () => {
    expect(dropEdit({ agentId: "b", from: "docs", to: "ops", add: false }, all)).toEqual({
      kind: "move",
      agentId: "b",
      from: "docs",
      to: "ops",
    })
    // With Option the agent stays in Docs, so Ops must be on one line with Docs (spec 029
    // acceptance: "Drag with Option from Docs onto Ops: no ring shows"). Here it is not.
    expect(dropEdit({ agentId: "b", from: "docs", to: "ops", add: true }, all)).toBeUndefined()
    const opsInDocs = all.map((o) => (o.id === "ops" ? { ...o, parentId: "docs" } : o))
    expect(dropEdit({ agentId: "b", from: "docs", to: "ops", add: true }, opsInDocs)).toEqual({
      kind: "add",
      agentId: "b",
      to: "ops",
    })
  })

  test("from No organization onto an organization node adds the agent", () => {
    expect(dropEdit({ agentId: "x", from: null, to: "art", add: false }, all)).toEqual({
      kind: "add",
      agentId: "x",
      to: "art",
    })
  })

  test("on No organization removes the agent from the organization it came from", () => {
    expect(dropEdit({ agentId: "b", from: "docs", to: null, add: false }, all)).toEqual({
      kind: "remove",
      agentId: "b",
      from: "docs",
    })
  })

  test("is not allowed on its own organization, on one where it is a member, or from No organization to No organization", () => {
    expect(dropEdit({ agentId: "b", from: "docs", to: "docs", add: false }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "d", from: "docs", to: "ops", add: true }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "x", from: null, to: null, add: false }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "b", from: "docs", to: null, add: true }, all)).toBeUndefined()
    expect(dropEdit({ agentId: "b", from: "docs", to: "gone", add: false }, all)).toBeUndefined()
  })

  test("an agent that works can still move: membership holds no running work (spec 029)", () => {
    // The chart does not know which agent works: a move is planned for every member.
    expect(dropEdit({ agentId: "b", from: "docs", to: "ops", add: false }, all)).toBeDefined()
    expect(planEdit({ kind: "move", agentId: "b", from: "docs", to: "ops" }, all)).toBeDefined()
  })
})

describe("the patches of a change", () => {
  test("a move takes the agent out first, then adds it", () => {
    const plan = planEdit({ kind: "move", agentId: "b", from: "docs", to: "ops" }, all)
    expect(plan?.steps).toEqual([
      { orgId: "docs", patch: { memberIds: ["a", "c"] } },
      { orgId: "ops", patch: { memberIds: ["d", "b"] } },
    ])
  })

  test("a move of the lead leaves its organization with no lead", () => {
    const plan = planEdit({ kind: "move", agentId: "a", from: "docs", to: "ops" }, all)
    expect(plan?.steps[0]).toEqual({
      orgId: "docs",
      patch: { memberIds: ["b", "c"], leadId: null },
    })
  })

  test("make lead and remove as lead change the lead only", () => {
    expect(planEdit({ kind: "lead", agentId: "b", orgId: "docs" }, all)?.steps).toEqual([
      { orgId: "docs", patch: { leadId: "b" } },
    ])
    expect(planEdit({ kind: "unlead", agentId: "a", orgId: "docs" }, all)?.steps).toEqual([
      { orgId: "docs", patch: { leadId: null } },
    ])
  })

  test("a change that names an organization that is gone makes no patch", () => {
    expect(planEdit({ kind: "add", agentId: "b", to: "gone" }, all)).toBeUndefined()
  })
})

describe("undo", () => {
  test("puts back the members and the lead", () => {
    const plan = planEdit({ kind: "move", agentId: "a", from: "docs", to: "ops" }, all)
    if (!plan) throw new Error("no plan")
    const now = after(all, plan.steps)
    const undo = undoSteps(plan.before, now)
    if (!("steps" in undo)) throw new Error("refused")
    expect(undo.steps.map((s) => s.orgId).sort()).toEqual(["docs", "ops"])
    const back = after(now, undo.steps)
    expect(back.find((o) => o.id === "docs")).toMatchObject({
      leadId: docs.leadId,
      memberIds: docs.memberIds,
    })
    expect(back.find((o) => o.id === "ops")).toMatchObject({
      leadId: ops.leadId,
      memberIds: ops.memberIds,
    })
  })

  test("is refused with the name of an organization that was deleted in the meantime", () => {
    const plan = planEdit({ kind: "add", agentId: "b", to: "ops" }, all)
    if (!plan) throw new Error("no plan")
    expect(undoSteps(plan.before, [docs])).toEqual({ gone: "ops" })
  })
})

describe("the drop area No organization during a drag", () => {
  test("takes the drop: the agent leaves the organization it came from", () => {
    expect(dropEdit({ agentId: "a", from: "docs", to: null, add: false }, all)).toEqual({
      kind: "remove",
      agentId: "a",
      from: "docs",
    })
  })

  test("with Option there is nothing to add: no ring", () => {
    expect(dropEdit({ agentId: "a", from: "docs", to: null, add: true }, all)).toBeUndefined()
  })
})

describe("edge scroll during a drag", () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 }
  const at = (x: number, y: number, ms = 1000) => edgeStep({ x, y }, rect, ms)

  test("the view does not move when the pointer is away from the edges or off the canvas", () => {
    expect(at(500, 350)).toEqual({ dx: 0, dy: 0 })
    expect(at(100 + EDGE_PX, 350)).toEqual({ dx: 0, dy: 0 })
    expect(at(50, 350)).toEqual({ dx: 0, dy: 0 })
    expect(at(500, 700)).toEqual({ dx: 0, dy: 0 })
  })

  test('the view does not move when the pointer is on the drop area "No organization"', () => {
    // The drop area is at the bottom left: within the strip of the bottom and the left edge.
    expect(edgeStep({ x: 110, y: 640 }, rect, 1000, true)).toEqual({ dx: 0, dy: 0 })
    expect(edgeStep({ x: 110, y: 640 }, rect, 1000, false).dy).toBeLessThan(0)
  })

  test("the view moves toward the edge that the pointer is near", () => {
    // Left and top: the chart moves right and down, so the view shows more of the left and top.
    expect(at(100, 350).dx).toBe(EDGE_SPEED)
    expect(at(500, 50).dy).toBe(EDGE_SPEED)
    expect(at(900, 350).dx).toBe(-EDGE_SPEED)
    expect(at(500, 650).dy).toBe(-EDGE_SPEED)
    // A corner moves both ways.
    const corner = at(101, 51)
    expect(corner.dx).toBeGreaterThan(0)
    expect(corner.dy).toBeGreaterThan(0)
  })

  test("nearer the edge is faster, and the step grows with the time", () => {
    expect(at(110, 350).dx).toBeGreaterThan(at(130, 350).dx)
    expect(at(100 + EDGE_PX - 1, 350).dx).toBeGreaterThan(0)
    expect(at(110, 350, 16).dx).toBeCloseTo(at(110, 350, 1000).dx * 0.016)
  })
})

describe("the lines at the bottom of the canvas", () => {
  test("a change and a refusal show for 10 seconds, Undone. for 3 seconds", () => {
    expect(NOTICE_MS).toBe(10_000)
    expect(UNDONE_MS).toBe(3_000)
    expect(noticeMs("done")).toBe(10_000)
    expect(noticeMs("refused")).toBe(10_000)
    expect(noticeMs("undone")).toBe(3_000)
  })
})

describe("the lines at the bottom of the canvas", () => {
  test("a change and a refusal show for 10 seconds, Undone. for 3 seconds", () => {
    expect(NOTICE_MS).toBe(10_000)
    expect(UNDONE_MS).toBe(3_000)
    expect(noticeMs("done")).toBe(10_000)
    expect(noticeMs("refused")).toBe(10_000)
    expect(noticeMs("undone")).toBe(3_000)
  })
})

describe("the tree on the chart (spec 029, 030)", () => {
  // Product > Docs > Site, and Ops and Art at the top.
  const product: EditOrg = { id: "product", name: "Product", leadId: null, memberIds: [] }
  const docsIn: EditOrg = { ...docs, parentId: "product" }
  const site: EditOrg = {
    id: "site",
    name: "Site",
    leadId: null,
    memberIds: [],
    parentId: "docs",
  }
  const tree = [product, docsIn, site, ops, art]

  test('"Put under…" lists every other organization by name, the parent now left out, with the reason of 030 for a refused one', () => {
    // Product takes 3 levels: no organization can hold it.
    expect(parentChoices("product", tree).map((c) => [c.id, c.refusal])).toEqual([
      ["art", "levels"],
      ["docs", "loop"],
      ["ops", "levels"],
      ["site", "loop"],
    ])
    // Docs (with Site) takes 2 levels: Product is its parent now and is left out; Site is its own
    // sub-organization.
    expect(parentChoices("docs", tree).map((c) => [c.id, c.refusal])).toEqual([
      ["art", undefined],
      ["ops", undefined],
      ["site", "loop"],
    ])
    // Ops can go under Art, Docs or Product, not under Site (a fourth level).
    expect(parentChoices("ops", tree).map((c) => [c.id, c.refusal])).toEqual([
      ["art", undefined],
      ["docs", undefined],
      ["product", undefined],
      ["site", "levels"],
    ])
  })

  test("a drop of an organization node: on an allowed one it goes under it, on the root to the top", () => {
    expect(orgDropEdit("ops", "docs", tree)).toEqual({
      kind: "parent",
      orgId: "ops",
      parentId: "docs",
    })
    // Its own sub-organization, itself, its parent now, and a fourth level: no ring, no change.
    expect(orgDropEdit("product", "docs", tree)).toBeUndefined()
    expect(orgDropEdit("ops", "ops", tree)).toBeUndefined()
    expect(orgDropEdit("site", "docs", tree)).toBeUndefined()
    expect(orgDropEdit("ops", "site", tree)).toBeUndefined()
    // The root: only a sub-organization moves to the top.
    expect(orgDropEdit("site", null, tree)).toEqual({
      kind: "parent",
      orgId: "site",
      parentId: null,
    })
    expect(orgDropEdit("ops", null, tree)).toBeUndefined()
  })

  test("a change of the parent has one patch, and Undo puts the parent back", () => {
    const plan = planEdit({ kind: "parent", orgId: "site", parentId: null }, tree)
    expect(plan?.steps).toEqual([{ orgId: "site", patch: { parentId: null } }])
    expect(plan?.before).toEqual([
      { kind: "parent", orgId: "site", name: "Site", parentId: "docs", parentName: "Docs" },
    ])
    const moved = tree.map((o) => (o.id === "site" ? { ...o, parentId: null } : o))
    expect(undoSteps(plan?.before ?? [], moved)).toEqual({
      steps: [{ orgId: "site", patch: { parentId: "docs" } }],
    })
  })

  test("Undo of a parent change is refused when the organization or its old parent was deleted", () => {
    const plan = planEdit({ kind: "parent", orgId: "site", parentId: null }, tree)
    const moved = tree.map((o) => (o.id === "site" ? { ...o, parentId: null } : o))
    expect(
      undoSteps(
        plan?.before ?? [],
        moved.filter((o) => o.id !== "site"),
      ),
    ).toEqual({ gone: "Site" })
    expect(
      undoSteps(
        plan?.before ?? [],
        moved.filter((o) => o.id !== "docs"),
      ),
    ).toEqual({ gone: "Docs" })
  })

  test("Put docs under product, delete docs, then Undo: refused with the name (spec 029 acceptance)", () => {
    const plan = planEdit({ kind: "parent", orgId: "docs", parentId: "product" }, [
      product,
      docs,
      art,
    ])
    expect(undoSteps(plan?.before ?? [], [product, art])).toEqual({ gone: "Docs" })
  })
})

describe("one line on the chart (spec 029, 030 'One line')", () => {
  // Product > Docs, and Ops at the top. A is in Docs. B is in Docs and Product.
  const product: EditOrg = { id: "product", name: "Product", leadId: null, memberIds: ["b"] }
  const docsIn: EditOrg = {
    id: "docs",
    name: "Docs",
    leadId: null,
    memberIds: ["a", "b"],
    parentId: "product",
  }
  const opsTop: EditOrg = { id: "ops", name: "Ops", leadId: null, memberIds: [] }
  const world = [product, docsIn, opsTop]
  const people = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]

  test("'Add to organization…' shows Ops muted with the organization A is in", () => {
    const choices = orgsFor("a", world)
    expect(choices.map((c) => [c.id, c.conflict])).toEqual([
      ["ops", "Docs"],
      ["product", undefined],
    ])
  })

  test("'Move to organization…' reads the line after A has left Docs", () => {
    // A leaves Docs: it is in no other organization, so Ops is allowed.
    expect(orgsFor("a", world, "docs").find((c) => c.id === "ops")?.conflict).toBeUndefined()
    // B leaves Docs but stays in Product: Ops is still off the line of Product.
    expect(orgsFor("b", world, "docs").find((c) => c.id === "ops")?.conflict).toBe("Product")
  })

  test("'Add member…' shows A muted with 'In Docs.' in the form of Ops", () => {
    const choices = agentsFor(opsTop, people, world)
    expect(choices.map((c) => [c.id, c.conflict])).toEqual([
      ["a", "Docs"],
      ["b", "Docs"],
    ])
    // The first conflicting organization in the order of names, ignoring case.
    expect(agentsFor(product, people, world).map((c) => c.id)).toEqual(["a"])
    expect(agentsFor(product, people, world)[0]?.conflict).toBeUndefined()
  })

  test("'Put under…' shows Ops muted with 'Would split the line of B.' (B is in Docs and Product)", () => {
    const choices = parentChoices("docs", world, people)
    expect(choices.map((c) => [c.id, c.refusal, c.split])).toEqual([["ops", undefined, "B"]])
  })

  test("after B leaves Product, Ops is allowed as the parent of Docs", () => {
    const left = world.map((o) => (o.id === "product" ? { ...o, memberIds: [] } : o))
    expect(parentChoices("docs", left, people).map((c) => c.split)).toEqual([undefined])
  })

  test("the tree reason comes before the line reason", () => {
    const deep: EditOrg = {
      id: "site",
      name: "Site",
      leadId: null,
      memberIds: [],
      parentId: "docs",
    }
    const choices = parentChoices("ops", [...world, deep], people)
    expect(choices.find((c) => c.id === "site")?.refusal).toBe("levels")
    expect(choices.find((c) => c.id === "site")?.split).toBeUndefined()
  })

  test("a drag: a drop on Ops shows no ring for A in Docs (Option or not), a drop on Product does", () => {
    expect(dropEdit({ agentId: "a", from: "docs", to: "ops", add: true }, world)).toBeUndefined()
    expect(dropEdit({ agentId: "a", from: "docs", to: "product", add: true }, world)).toEqual({
      kind: "add",
      agentId: "a",
      to: "product",
    })
    // A moves from Docs to Ops: A leaves Docs, so the move is allowed.
    expect(dropEdit({ agentId: "a", from: "docs", to: "ops", add: false }, world)).toEqual({
      kind: "move",
      agentId: "a",
      from: "docs",
      to: "ops",
    })
    // B stays in Product, so a move to Ops is refused.
    expect(dropEdit({ agentId: "b", from: "docs", to: "ops", add: false }, world)).toBeUndefined()
  })

  test("a drag of Docs onto Ops or the root shows no ring while B is in Docs and Product", () => {
    expect(orgDropEdit("docs", "ops", world)).toBeUndefined()
    expect(orgDropEdit("docs", null, world)).toBeUndefined()
    const left = world.map((o) => (o.id === "product" ? { ...o, memberIds: [] } : o))
    expect(orgDropEdit("docs", "ops", left)).toEqual({
      kind: "parent",
      orgId: "docs",
      parentId: "ops",
    })
    expect(orgDropEdit("docs", null, left)).toEqual({
      kind: "parent",
      orgId: "docs",
      parentId: null,
    })
  })
})
