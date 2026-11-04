import { describe, expect, test } from "bun:test"
import {
  allowedSends,
  checkHandOff,
  firstOnPath,
  type HandOffAgent,
  type HandOffChannel,
  type HandOffModel,
  handOffAllowed,
  handOffLink,
  handOffRefusalText,
  isHandOffRule,
} from "./organization.ts"

// Spec 030, "Who can send to whom": the four allow rules, the agent that a refused sender is told
// to use, and the list of agents that a sender may send to.

const agent = (id: string, archived = false): HandOffAgent => ({ id, name: id, archived })
const channel = (
  id: string,
  options: {
    lead?: string | null
    members?: string[]
    parent?: string | null
    archived?: boolean
  } = {},
): HandOffChannel => ({
  id,
  name: id,
  archived: options.archived ?? false,
  parentId: options.parent ?? null,
  leadId: options.lead ?? null,
  memberIds: options.members ?? [],
})

// The acceptance setup: main agent M; "Product" with lead P; "Docs" under "Product" with lead D and
// member A; X in no channel.
const org = (options: Partial<HandOffModel> = {}): HandOffModel => ({
  agents: ["M", "P", "D", "A", "X"].map((id) => agent(id)),
  channels: [
    channel("Product", { lead: "P", members: ["P"] }),
    channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
  ],
  mainAgentId: "M",
  ...options,
})

const refusal = (model: HandOffModel, from: string, to: string) => checkHandOff(model, from, to)

describe("the four allow rules", () => {
  test("rule 1: members of one channel", () => {
    expect(handOffAllowed(org(), "A", "D")).toBe(true)
    expect(handOffAllowed(org(), "D", "A")).toBe(true)
  })

  test("rule 2: every agent may send to the main agent", () => {
    for (const from of ["A", "D", "P", "X"]) expect(handOffAllowed(org(), from, "M")).toBe(true)
  })

  test("rule 3: the main agent may send to every agent", () => {
    for (const to of ["A", "D", "P", "X"]) expect(handOffAllowed(org(), "M", to)).toBe(true)
  })

  test("rule 4: a lead sends to the lead of the parent channel and to the lead of a sub-channel", () => {
    expect(handOffAllowed(org(), "D", "P")).toBe(true)
    expect(handOffAllowed(org(), "P", "D")).toBe(true)
  })

  test("a member who is not a lead cannot send to the lead of the parent channel", () => {
    expect(handOffAllowed(org(), "A", "P")).toBe(false)
  })

  test("rule 4 reaches one level only: the lead of a channel two levels up is not allowed", () => {
    const model = org({
      agents: ["M", "P", "D", "S", "A"].map((id) => agent(id)),
      channels: [
        channel("Product", { lead: "P", members: ["P"] }),
        channel("Docs", { lead: "D", members: ["D"], parent: "Product" }),
        channel("Site", { lead: "S", members: ["S", "A"], parent: "Docs" }),
      ],
    })
    expect(handOffAllowed(model, "S", "D")).toBe(true)
    expect(handOffAllowed(model, "S", "P")).toBe(false)
    expect(handOffAllowed(model, "P", "S")).toBe(false)
  })

  test("an agent in no channel can send only to the main agent", () => {
    expect(allowedSends(org(), "X").map((t) => t.agentId)).toEqual(["M"])
    expect(handOffAllowed(org(), "X", "A")).toBe(false)
  })

  test("with no main agent, an agent in no channel can send to no agent", () => {
    expect(allowedSends(org({ mainAgentId: null }), "X")).toEqual([])
    expect(handOffAllowed(org({ mainAgentId: null }), "X", "A")).toBe(false)
  })

  test("an archived main agent counts as none", () => {
    const model = org({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "M")) })
    expect(handOffAllowed(model, "X", "M")).toBe(false)
    // With no main agent, an agent in no channel can send to no agent.
    expect(allowedSends(model, "X")).toEqual([])
  })

  test("an archived receiver is never allowed", () => {
    const model = org({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "D")) })
    expect(handOffAllowed(model, "A", "D")).toBe(false)
    expect(handOffAllowed(model, "M", "D")).toBe(false)
  })

  test("an archived channel gives no right", () => {
    const model = org({
      channels: [
        channel("Product", { lead: "P", members: ["P"] }),
        channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product", archived: true }),
      ],
    })
    expect(handOffAllowed(model, "A", "D")).toBe(false)
    expect(handOffAllowed(model, "D", "P")).toBe(false)
  })

  test("an archived parent channel counts as none: the sub-channel is a top channel", () => {
    const model = org({
      channels: [
        channel("Product", { lead: "P", members: ["P"], archived: true }),
        channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
      ],
    })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
    expect(handOffAllowed(model, "A", "D")).toBe(true)
  })

  test("an archived lead counts as no lead", () => {
    const model = org({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "P")) })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
    const gone = org({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "D")) })
    expect(handOffAllowed(gone, "A", "P")).toBe(false)
  })

  test("a channel with no lead gives rule 1 only", () => {
    const model = org({
      channels: [
        channel("Product", { lead: null, members: ["P"] }),
        channel("Docs", { lead: null, members: ["D", "A"], parent: "Product" }),
      ],
    })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
    expect(handOffAllowed(model, "A", "D")).toBe(true)
  })

  test("a broken tree counts as top channels (a loop gives no rule 4)", () => {
    const model = org({
      channels: [
        channel("Product", { lead: "P", members: ["P"], parent: "Docs" }),
        channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
      ],
    })
    expect(handOffAllowed(model, "D", "P")).toBe(false)
  })
})

describe("the refusal and the first agent on the path", () => {
  test("A to P: send it to D", () => {
    const r = refusal(org(), "A", "P")
    expect(r?.next).toEqual({ id: "D", name: "D" })
    expect(handOffRefusalText("P", r?.next?.name ?? null)).toBe(
      "P is not on your path. Send it to D.",
    )
  })

  test("X in no channel to A: send it to M", () => {
    const r = refusal(org(), "X", "A")
    expect(r?.next).toEqual({ id: "M", name: "M" })
    expect(handOffRefusalText("A", "M")).toBe("A is not on your path. Send it to M.")
  })

  test("no main agent: no agent can pass it on", () => {
    const r = refusal(org({ mainAgentId: null }), "X", "A")
    expect(r?.next).toBeNull()
    expect(handOffRefusalText("A", null)).toBe(
      "A is not on your path, and no agent can pass it on. Tell the user.",
    )
  })

  test("an allowed send has no refusal", () => {
    expect(refusal(org(), "A", "D")).toBeUndefined()
    expect(refusal(org(), "M", "A")).toBeUndefined()
  })

  test("the path goes along the channels: down to a member of a sub-channel by its lead", () => {
    const model = org({
      agents: ["M", "P", "D", "S", "A", "Q"].map((id) => agent(id)),
      channels: [
        channel("Product", { lead: "P", members: ["P"] }),
        channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
        channel("Site", { lead: "S", members: ["S", "Q"], parent: "Docs" }),
      ],
    })
    // A (member of Docs) to Q (member of Site): D is the lead of a channel of A, and it is on the
    // path, so it comes before the main agent, which is also a way.
    expect(firstOnPath(model, "A", "Q")?.id).toBe("D")
    // D (lead of Docs) to Q: the lead of the sub-channel is on the path.
    expect(firstOnPath(model, "D", "Q")?.id).toBe("S")
    // Up the tree: Q to A goes by S, then D.
    expect(firstOnPath(model, "Q", "A")?.id).toBe("S")
  })

  test("a member of a channel of the sender can be first on the path", () => {
    // B is in Docs and in Other (Z too). A to Z goes by B.
    const model: HandOffModel = {
      agents: ["M", "A", "B", "Z"].map((id) => agent(id)),
      channels: [
        channel("Docs", { lead: null, members: ["A", "B"] }),
        channel("Other", { lead: null, members: ["B", "Z"] }),
      ],
      mainAgentId: "M",
    }
    expect(firstOnPath(model, "A", "Z")?.id).toBe("B")
  })

  test("an unrelated channel: the path ends at the main agent", () => {
    const model = org({
      agents: ["M", "P", "D", "A", "Z", "O"].map((id) => agent(id)),
      channels: [
        channel("Product", { lead: "P", members: ["P"] }),
        channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
        channel("Other", { lead: "O", members: ["O", "Z"] }),
      ],
    })
    expect(firstOnPath(model, "A", "Z")?.id).toBe("M")
  })

  test("two ways of the same length: the lead of a channel of the sender first, then by name", () => {
    const model: HandOffModel = {
      agents: ["M", "A", "L", "B", "Z"].map((id) => agent(id)),
      channels: [
        channel("One", { lead: "L", members: ["L", "A"] }),
        channel("Two", { lead: null, members: ["A", "B"] }),
        channel("Three", { lead: null, members: ["L", "Z"] }),
        channel("Four", { lead: null, members: ["B", "Z"] }),
      ],
      mainAgentId: "M",
    }
    // A reaches Z by L (lead of One) or by B (a member of Two): the lead comes first.
    expect(firstOnPath(model, "A", "Z")?.id).toBe("L")
  })
})

describe("the list of agents that a sender may send to", () => {
  test("A sees D and M only, with the channel and the main agent", () => {
    const list = allowedSends(org(), "A")
    expect(list.map((t) => [t.agentId, handOffLink(t)])).toEqual([
      ["D", "channel: Docs"],
      ["M", "main agent"],
    ])
  })

  test("D sees A, P and M", () => {
    expect(allowedSends(org(), "D").map((t) => t.agentId)).toEqual(["A", "M", "P"])
  })

  test("the main agent sees every other agent", () => {
    const list = allowedSends(org(), "M")
    expect(list.map((t) => t.agentId)).toEqual(["A", "D", "P", "X"])
    // X is in no channel: the link is the main agent.
    expect(handOffLink(list.find((t) => t.agentId === "X") as never)).toBe("main agent")
  })

  test("a row names every channel that links the two", () => {
    const model = org({
      channels: [
        channel("Zeta", { lead: null, members: ["A", "D"] }),
        channel("alpha", { lead: null, members: ["A", "D"] }),
      ],
    })
    expect(handOffLink(allowedSends(model, "A").find((t) => t.agentId === "D") as never)).toBe(
      "channel: alpha, Zeta",
    )
  })

  test("a send to an agent that is not on the list is refused", () => {
    const model = org()
    const listed = new Set(allowedSends(model, "A").map((t) => t.agentId))
    for (const to of ["D", "M", "P", "X"])
      expect(handOffAllowed(model, "A", to)).toBe(listed.has(to))
  })
})

describe("the rule value", () => {
  test("two values", () => {
    expect(isHandOffRule("any")).toBe(true)
    expect(isHandOffRule("channels")).toBe(true)
    expect(isHandOffRule("both")).toBe(false)
    expect(isHandOffRule(undefined)).toBe(false)
  })
})
