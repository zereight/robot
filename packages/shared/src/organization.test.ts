import { describe, expect, test } from "bun:test"
import {
  allowedSends,
  checkHandOff,
  firstOnPath,
  type HandOffAgent,
  type HandOffModel,
  type HandOffOrg,
  handOffAllowed,
  handOffLink,
  handOffRange,
  handOffRangeNow,
  handOffRangeUnder,
  handOffRefusalText,
  isHandOffRule,
  MAIN_AGENT_HAND_OFF_RULE,
} from "./organization.ts"
import type { HandOffRange } from "./organizations.ts"

// Spec 030, "Who can send to whom" and "Hand-off range": the six allow rules, the range of an
// organization, the agent that a refused sender is told to use, and the list of agents that a
// sender may send to. Channels give no right to send, so the model holds no channel.

const agent = (id: string, archived = false): HandOffAgent => ({ id, name: id, archived })
const unit = (
  id: string,
  options: {
    lead?: string | null
    members?: string[]
    parent?: string | null
    range?: HandOffRange | undefined
  } = {},
): HandOffOrg => ({
  id,
  name: id,
  parentId: options.parent ?? null,
  leadId: options.lead ?? null,
  memberIds: options.members ?? [],
  handOffRange: options.range ?? "inherit",
})

// The acceptance setup: main agent M; "Product" with lead P; "Docs" under "Product" with lead D and
// member A; X in no organization.
const setup = (options: Partial<HandOffModel> = {}): HandOffModel => ({
  agents: ["M", "P", "D", "A", "X"].map((id) => agent(id)),
  orgs: [
    unit("Product", { lead: "P", members: ["P"] }),
    unit("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
  ],
  mainAgentId: "M",
  ...options,
})

const refusal = (model: HandOffModel, from: string, to: string) => checkHandOff(model, from, to)
const ids = (model: HandOffModel, from: string) => allowedSends(model, from).map((t) => t.agentId)

// "Product" > "Docs" > "Site"; Product has lead P, Docs has lead D and member A, Site has lead S
// and member Q. M is the main agent and X is in no organization.
const deep = (ranges: Partial<Record<"Product" | "Docs" | "Site", HandOffRange>> = {}) =>
  setup({
    agents: ["M", "P", "D", "A", "S", "Q", "X"].map((id) => agent(id)),
    orgs: [
      unit("Product", { lead: "P", members: ["P"], range: ranges.Product }),
      unit("Docs", { lead: "D", members: ["D", "A"], parent: "Product", range: ranges.Docs }),
      unit("Site", { lead: "S", members: ["S", "Q"], parent: "Docs", range: ranges.Site }),
    ],
  })

describe("the allow rules 1 to 4", () => {
  test("rule 1: members of one organization", () => {
    expect(handOffAllowed(setup(), "A", "D")).toBe(true)
    expect(handOffAllowed(setup(), "D", "A")).toBe(true)
  })

  test("rule 2: every agent may send to the main agent", () => {
    for (const from of ["A", "D", "P", "X"]) expect(handOffAllowed(setup(), from, "M")).toBe(true)
  })

  test("rule 3: the main agent may send to every agent", () => {
    for (const to of ["A", "D", "P", "X"]) expect(handOffAllowed(setup(), "M", to)).toBe(true)
  })

  test("rule 4: a lead sends to the lead of the parent organization and to the lead of a sub-organization", () => {
    expect(handOffAllowed(setup(), "D", "P")).toBe(true)
    expect(handOffAllowed(setup(), "P", "D")).toBe(true)
  })

  test("a member who is not a lead cannot send to the lead of the parent organization", () => {
    expect(handOffAllowed(setup(), "A", "P")).toBe(false)
  })

  test("rule 4 reaches one level only: the lead two levels up or down is not allowed", () => {
    const model = deep()
    expect(handOffAllowed(model, "S", "D")).toBe(true)
    expect(handOffAllowed(model, "S", "P")).toBe(false)
    expect(handOffAllowed(model, "P", "S")).toBe(false)
  })

  test("a lead of two organizations sends to the leads that either one reaches", () => {
    const model = setup({
      agents: ["M", "P", "D", "E", "A"].map((id) => agent(id)),
      orgs: [
        unit("Product", { lead: "P", members: ["P"] }),
        unit("Docs", { lead: "D", members: ["D"], parent: "Product" }),
        unit("Help", { lead: "E", members: ["E"], parent: "Docs" }),
      ],
    })
    // D leads Docs: the parent lead P and the sub-organization lead E.
    expect(ids(model, "D")).toEqual(["E", "M", "P"])
  })

  test("an agent in no organization can send only to the main agent", () => {
    expect(ids(setup(), "X")).toEqual(["M"])
    expect(handOffAllowed(setup(), "X", "A")).toBe(false)
  })

  test("with no main agent, an agent in no organization can send to no agent", () => {
    expect(allowedSends(setup({ mainAgentId: null }), "X")).toEqual([])
    expect(handOffAllowed(setup({ mainAgentId: null }), "X", "A")).toBe(false)
  })

  test("an archived main agent counts as none", () => {
    const model = setup({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "M")) })
    expect(handOffAllowed(model, "X", "M")).toBe(false)
    expect(allowedSends(model, "X")).toEqual([])
  })

  test("an archived receiver is never allowed", () => {
    const model = setup({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "D")) })
    expect(handOffAllowed(model, "A", "D")).toBe(false)
    expect(handOffAllowed(model, "M", "D")).toBe(false)
  })

  test("an archived lead counts as no lead", () => {
    const model = setup({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "P")) })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
    const gone = setup({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "D")) })
    expect(handOffAllowed(gone, "A", "P")).toBe(false)
  })

  test("a lead that is not a member counts as no lead", () => {
    const model = setup({
      orgs: [
        unit("Product", { lead: "P", members: ["P"] }),
        unit("Docs", { lead: "D", members: ["A"], parent: "Product" }),
      ],
    })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
  })

  test("an organization with no lead gives rule 1 only", () => {
    const model = setup({
      orgs: [
        unit("Product", { lead: null, members: ["P"] }),
        unit("Docs", { lead: null, members: ["D", "A"], parent: "Product" }),
      ],
    })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
    expect(handOffAllowed(model, "A", "D")).toBe(true)
  })

  test("an archived member is not reached by rule 1", () => {
    const model = setup({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "A")) })
    expect(handOffAllowed(model, "D", "A")).toBe(false)
    expect(handOffAllowed(model, "M", "A")).toBe(false)
  })

  test("a broken tree counts as top organizations (a loop gives no rule 4)", () => {
    const model = setup({
      orgs: [
        unit("Product", { lead: "P", members: ["P"], parent: "Docs" }),
        unit("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
      ],
    })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
  })

  test("an organization that is gone as a parent counts as no parent", () => {
    const model = setup({
      orgs: [unit("Docs", { lead: "D", members: ["D", "A"], parent: "Gone" })],
    })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
    expect(handOffAllowed(model, "A", "D")).toBe(true)
  })
})

describe("the range of an organization", () => {
  test("its own value, else the value of the parent up the tree, else 'Own organization'", () => {
    const model = deep({ Product: "own_lower" })
    expect(handOffRange(model.orgs, "Product")).toEqual({ value: "own_lower", from: "Product" })
    expect(handOffRange(model.orgs, "Docs")).toEqual({ value: "own_lower", from: "Product" })
    expect(handOffRange(model.orgs, "Site")).toEqual({ value: "own_lower", from: "Product" })
    const own = deep({ Product: "own_lower", Docs: "all" })
    expect(handOffRange(own.orgs, "Site")).toEqual({ value: "all", from: "Docs" })
    expect(handOffRange(own.orgs, "Product")).toEqual({ value: "own_lower", from: "Product" })
    const none = deep()
    expect(handOffRange(none.orgs, "Site")).toEqual({ value: "own", from: null })
  })

  test("the line 'Now' under 'Inherit' shows what the higher organizations give", () => {
    const model = deep({ Product: "own_lower" })
    expect(handOffRangeNow(model.orgs, "Docs")).toEqual({ value: "own_lower", from: "Product" })
    expect(handOffRangeNow(model.orgs, "Product")).toEqual({ value: "own", from: null })
    // The own value of the organization does not count: the line shows under 'Inherit' only.
    const set = deep({ Product: "own_lower", Docs: "all" })
    expect(handOffRangeNow(set.orgs, "Site")).toEqual({ value: "all", from: "Docs" })
    expect(handOffRangeNow(set.orgs, "Docs")).toEqual({ value: "own_lower", from: "Product" })
  })
})

describe("the range under a parent", () => {
  test("the line 'Now' of a form reads the range that a chosen parent gives", () => {
    const model = deep({ Product: "own_lower", Docs: "all" })
    expect(handOffRangeUnder(model.orgs, "Product")).toEqual({
      value: "own_lower",
      from: "Product",
    })
    expect(handOffRangeUnder(model.orgs, "Docs")).toEqual({ value: "all", from: "Docs" })
    expect(handOffRangeUnder(model.orgs, "Site")).toEqual({ value: "all", from: "Docs" })
    // No parent: a top organization with "Inherit" has "Own organization".
    expect(handOffRangeUnder(model.orgs, null)).toEqual({ value: "own", from: null })
  })
})

describe("rule 5 and rule 6: the range", () => {
  test("rule 5: 'Own and lower organizations' reaches the members of the organization and of the lower ones", () => {
    const model = deep({ Product: "own_lower" })
    // The range of Docs is "Inherit": it takes the value of Product.
    expect(handOffAllowed(model, "P", "A")).toBe(true)
    expect(handOffAllowed(model, "P", "Q")).toBe(true)
    expect(handOffAllowed(model, "A", "Q")).toBe(true)
    expect(handOffAllowed(model, "A", "S")).toBe(true)
  })

  test("'Own and lower organizations' has no way up or to the side", () => {
    const model = deep({ Product: "own_lower" })
    expect(handOffAllowed(model, "A", "P")).toBe(false)
    expect(handOffAllowed(model, "Q", "A")).toBe(false)
    expect(handOffAllowed(model, "A", "X")).toBe(false)
  })

  test("'Own organization' adds no right", () => {
    const model = deep({ Product: "own" })
    expect(handOffAllowed(model, "P", "A")).toBe(false)
    expect(ids(model, "P")).toEqual(["D", "M"])
    expect(ids(deep(), "P")).toEqual(ids(model, "P"))
  })

  test("rule 6: 'All agents' on Site lets a member of Site send to X, a member of Docs still cannot", () => {
    const model = deep({ Site: "all" })
    expect(handOffAllowed(model, "Q", "X")).toBe(true)
    expect(handOffAllowed(model, "Q", "P")).toBe(true)
    expect(handOffAllowed(model, "A", "X")).toBe(false)
  })

  test("'All agents' goes down: a lower organization with 'Inherit' takes it", () => {
    const model = deep({ Docs: "all" })
    expect(handOffAllowed(model, "Q", "X")).toBe(true)
    expect(handOffAllowed(model, "A", "X")).toBe(true)
    expect(handOffAllowed(model, "P", "X")).toBe(false)
  })

  test("a lower organization can set a narrower value than its parent", () => {
    const model = deep({ Product: "all", Docs: "own" })
    expect(handOffAllowed(model, "A", "X")).toBe(false)
    expect(handOffAllowed(model, "P", "X")).toBe(true)
  })

  test("the widest range of the organizations of the agent holds", () => {
    const model = setup({
      agents: ["M", "P", "D", "A", "X", "Y"].map((id) => agent(id)),
      orgs: [
        unit("Docs", { lead: "D", members: ["D", "A"], range: "own" }),
        unit("Ops", { lead: null, members: ["A", "Y"], range: "all" }),
      ],
    })
    expect(handOffAllowed(model, "A", "X")).toBe(true)
    // D is in Docs only, with the range "Own organization".
    expect(handOffAllowed(model, "D", "X")).toBe(false)
  })

  test("an archived receiver is not reached by a range", () => {
    const model = deep({ Site: "all" })
    const archived = { ...model, agents: model.agents.map((a) => agent(a.id, a.id === "X")) }
    expect(handOffAllowed(archived, "Q", "X")).toBe(false)
  })

  test("a range of an archived member does not count: the member is skipped", () => {
    const model = deep({ Product: "own_lower" })
    const archived = { ...model, agents: model.agents.map((a) => agent(a.id, a.id === "Q")) }
    expect(handOffAllowed(archived, "A", "Q")).toBe(false)
  })
})

describe("the refusal and the first agent on the path", () => {
  test("X in no organization to A: send it to M", () => {
    const r = refusal(setup(), "X", "A")
    expect(r?.next).toEqual({ id: "M", name: "M" })
    expect(handOffRefusalText("A", "M")).toBe("A is not on your path. Send it to M.")
  })

  test("no main agent: no agent can pass it on", () => {
    const r = refusal(setup({ mainAgentId: null }), "X", "A")
    expect(r?.next).toBeNull()
    expect(handOffRefusalText("A", null)).toBe(
      "A is not on your path, and no agent can pass it on. Tell the user.",
    )
  })

  test("an allowed send has no refusal", () => {
    expect(refusal(setup(), "A", "D")).toBeUndefined()
    expect(refusal(setup(), "M", "A")).toBeUndefined()
  })

  test("A to P: send it to D (the lead of an organization of A comes before the main agent)", () => {
    const r = refusal(setup(), "A", "P")
    expect(r?.next).toEqual({ id: "D", name: "D" })
    expect(handOffRefusalText("P", r?.next?.name ?? null)).toBe(
      "P is not on your path. Send it to D.",
    )
  })

  test("a range gives a chain too: with 'Own and lower organizations' on Product, P reaches Q", () => {
    expect(firstOnPath(deep(), "P", "Q")?.id).toBe("M")
    expect(refusal(deep({ Product: "own_lower" }), "P", "Q")).toBeUndefined()
  })

  test("an archived receiver: no chain, so no agent can pass it on", () => {
    const model = setup({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "P")) })
    expect(firstOnPath(model, "A", "P")).toBeNull()
    expect(refusal(model, "A", "P")?.next).toBeNull()
  })
})

// Spec 030, "A chain", "Equal chains" and "No chain": <A> is the second agent of the shortest chain.
// Names are the ids here, so a name that sorts late or early is easy to set.
describe("the first agent on the path is the second of the shortest chain", () => {
  const named = (names: string[], rest: Omit<HandOffModel, "agents">): HandOffModel => ({
    agents: names.map((id) => agent(id)),
    ...rest,
  })

  test("a tie of the lead and the main agent: the lead comes first, also when its name is later", () => {
    // Bo (member of Docs, lead Zed) to Cy (member of Site, lead Zed): by Zed or by the main agent
    // Ada. Zed leads an organization of Bo, so Zed comes before Ada, though "Ada" is first by name.
    const model = named(["Ada", "Zed", "Bo", "Cy"], {
      orgs: [
        unit("Docs", { lead: "Zed", members: ["Zed", "Bo"] }),
        unit("Site", { lead: null, members: ["Zed", "Cy"] }),
      ],
      mainAgentId: "Ada",
    })
    expect(firstOnPath(model, "Bo", "Cy")?.id).toBe("Zed")
  })

  test("a tie of the main agent and a plain member: the main agent comes first, not the name", () => {
    const model = named(["Zoe", "Abe", "Bo", "Cy"], {
      orgs: [
        unit("Docs", { lead: null, members: ["Abe", "Bo"] }),
        unit("Site", { lead: null, members: ["Abe", "Cy"] }),
      ],
      mainAgentId: "Zoe",
    })
    expect(firstOnPath(model, "Bo", "Cy")?.id).toBe("Zoe")
  })

  test("a tie of two plain members: the order of the names, ignoring case", () => {
    // By case, "Bob" < "alice"; ignoring case, alice first.
    const model = named(["Sam", "Bob", "alice", "Zed"], {
      orgs: [
        unit("One", { lead: null, members: ["Sam", "Bob", "alice"] }),
        unit("Two", { lead: null, members: ["Bob", "alice", "Zed"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "Sam", "Zed")?.id).toBe("alice")
  })

  test("a tie of a lead of an organization of the sender and plain members: the lead, though it sorts last", () => {
    const model = named(["Sam", "Ann", "Bea", "Zoe", "Zed"], {
      orgs: [
        unit("One", { lead: "Zoe", members: ["Zoe", "Sam", "Ann", "Bea"] }),
        unit("Two", { lead: null, members: ["Ann", "Bea", "Zoe", "Zed"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "Sam", "Zed")?.id).toBe("Zoe")
  })

  test("a lead reached only by rule 4 is in the last group, after the main agent and by name", () => {
    // Pat leads Product; Dan leads Docs under Product; Ann is a plain member of Docs. Ann to Pat:
    // by Dan (leads Docs, an organization of Ann), or by the main agent Max. Dan comes first.
    // Dan to Rex (a member of Product, lead Pat): Pat is reached by rule 4 only, Max is the main agent.
    const model = named(["Max", "Pat", "Dan", "Ann", "Rex"], {
      orgs: [
        unit("Product", { lead: "Pat", members: ["Pat", "Rex"] }),
        unit("Docs", { lead: "Dan", members: ["Dan", "Ann"], parent: "Product" }),
      ],
      mainAgentId: "Max",
    })
    expect(firstOnPath(model, "Ann", "Pat")?.id).toBe("Dan")
    expect(firstOnPath(model, "Dan", "Rex")?.id).toBe("Max")
    // No main agent: Pat is the only way for Dan.
    expect(firstOnPath({ ...model, mainAgentId: null }, "Dan", "Rex")?.id).toBe("Pat")
  })

  test("a lead reached by rule 4 that also leads an organization of the sender is in the first group", () => {
    // Ann leads Docs under Product; Pat leads Product and also leads Ops, where Ann is a member.
    // Ann reaches Rex (a member of Product) by Pat or by the main agent Max. Pat leads Ops, an
    // organization of Ann, so Pat comes first. Without Ops, Pat is reached by rule 4 only, and
    // Max comes first.
    const docs = unit("Docs", { lead: "Ann", members: ["Ann"], parent: "Product" })
    const product = unit("Product", { lead: "Pat", members: ["Pat", "Rex"] })
    const model = named(["Max", "Pat", "Ann", "Rex"], {
      orgs: [product, docs, unit("Ops", { lead: "Pat", members: ["Pat", "Ann"] })],
      mainAgentId: "Max",
    })
    expect(firstOnPath(model, "Ann", "Rex")?.id).toBe("Pat")
    expect(firstOnPath({ ...model, orgs: [product, docs] }, "Ann", "Rex")?.id).toBe("Max")
  })

  test("a chain through a fellow member only: no main agent, no lead", () => {
    const model = named(["A", "B", "Z"], {
      orgs: [
        unit("Docs", { lead: null, members: ["A", "B"] }),
        unit("Other", { lead: null, members: ["B", "Z"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "A", "Z")).toEqual({ id: "B", name: "B" })
    expect(refusal(model, "A", "Z")?.next).toEqual({ id: "B", name: "B" })
  })

  test("a chain of more than 3 agents goes along the organizations, by the lead of the organization of the sender", () => {
    // A, D, P, E: A and D share Docs; D leads Docs under Product; P leads Product; E is in Product.
    const model = named(["A", "D", "P", "E"], {
      orgs: [
        unit("Product", { lead: "P", members: ["P", "E"] }),
        unit("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "A", "E")?.id).toBe("D")
  })

  test("the shortest chain wins, whatever the names", () => {
    const model = named(["Sam", "Bob", "Carl", "Y", "Z"], {
      orgs: [
        unit("One", { lead: null, members: ["Sam", "Bob", "Carl"] }),
        unit("Two", { lead: null, members: ["Bob", "Y"] }),
        unit("Three", { lead: null, members: ["Y", "Z"] }),
        unit("Four", { lead: null, members: ["Carl", "Z"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "Sam", "Z")?.id).toBe("Carl")
  })

  test("no chain: no main agent and no organization links the two", () => {
    const model = named(["A", "B", "Y", "Z"], {
      orgs: [
        unit("Docs", { lead: null, members: ["A", "B"] }),
        unit("Other", { lead: null, members: ["Y", "Z"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "A", "Z")).toBeNull()
    const r = refusal(model, "A", "Z")
    expect(r?.next).toBeNull()
    expect(handOffRefusalText("Z", r?.next?.name ?? null)).toBe(
      "Z is not on your path, and no agent can pass it on. Tell the user.",
    )
    // An agent in no organization has no chain either.
    expect(firstOnPath(setup({ mainAgentId: null }), "X", "A")).toBeNull()
  })

  test("an archived main agent leaves no chain", () => {
    const model = setup({
      agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "M" || id === "D")),
    })
    expect(firstOnPath(model, "A", "P")).toBeNull()
  })

  test("an unrelated organization: the chain passes the main agent", () => {
    const model = setup({
      agents: ["M", "P", "D", "A", "Z", "O"].map((id) => agent(id)),
      orgs: [
        unit("Product", { lead: "P", members: ["P"] }),
        unit("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
        unit("Other", { lead: "O", members: ["O", "Z"] }),
      ],
    })
    expect(firstOnPath(model, "A", "Z")?.id).toBe("M")
  })
})

describe("the list of agents that a sender may send to", () => {
  test("A sees D and M only, with the organization and the main agent", () => {
    const list = allowedSends(setup(), "A")
    expect(list.map((t) => [t.agentId, handOffLink(t)])).toEqual([
      ["D", "organization: Docs"],
      ["M", "main agent"],
    ])
  })

  test("D sees A, P and M", () => {
    expect(ids(setup(), "D")).toEqual(["A", "M", "P"])
  })

  test("the row of a lead reached by rule 4 names the organization that the sender leads", () => {
    const list = allowedSends(setup(), "D")
    expect(handOffLink(list.find((t) => t.agentId === "P") as never)).toBe("organization: Docs")
    const up = allowedSends(setup(), "P")
    expect(handOffLink(up.find((t) => t.agentId === "D") as never)).toBe("organization: Product")
  })

  test("the row of a range names the organization that holds the range", () => {
    const list = allowedSends(deep({ Product: "own_lower" }), "A")
    expect(handOffLink(list.find((t) => t.agentId === "Q") as never)).toBe("organization: Docs")
    const all = allowedSends(deep({ Site: "all" }), "Q")
    expect(handOffLink(all.find((t) => t.agentId === "X") as never)).toBe("organization: Site")
  })

  test("the main agent sees every other agent", () => {
    const list = allowedSends(setup(), "M")
    expect(list.map((t) => t.agentId)).toEqual(["A", "D", "P", "X"])
    // X is in no organization: the link is the main agent.
    expect(handOffLink(list.find((t) => t.agentId === "X") as never)).toBe("main agent")
  })

  test("a row names every organization that links the two, in order of name", () => {
    const model = setup({
      orgs: [
        unit("Zeta", { lead: null, members: ["A", "D"] }),
        unit("alpha", { lead: null, members: ["A", "D"] }),
      ],
    })
    expect(handOffLink(allowedSends(model, "A").find((t) => t.agentId === "D") as never)).toBe(
      "organization: alpha, Zeta",
    )
  })

  test("a send to an agent that is not on the list is refused", () => {
    for (const model of [setup(), deep({ Product: "own_lower" }), deep({ Site: "all" })]) {
      for (const from of model.agents.map((a) => a.id)) {
        const listed = new Set(ids(model, from))
        for (const to of model.agents.map((a) => a.id))
          expect(handOffAllowed(model, from, to)).toBe(listed.has(to))
      }
    }
  })

  test("a sender is never on its own list", () => {
    for (const from of ["M", "P", "A", "X"])
      expect(ids(deep({ Product: "all" }), from)).not.toContain(from)
  })
})

describe("the rule value and the words for the agent", () => {
  test("two values: 'any' and 'organizations'", () => {
    expect(isHandOffRule("any")).toBe(true)
    expect(isHandOffRule("organizations")).toBe(true)
    expect(isHandOffRule("channels")).toBe(false)
    expect(isHandOffRule("both")).toBe(false)
    expect(isHandOffRule(undefined)).toBe(false)
  })

  test("the main agent is told to pass work on along the organizations", () => {
    expect(MAIN_AGENT_HAND_OFF_RULE).toContain("along the organizations")
    expect(MAIN_AGENT_HAND_OFF_RULE).toContain("lead of an organization")
    expect(MAIN_AGENT_HAND_OFF_RULE).not.toContain("channel")
  })
})
