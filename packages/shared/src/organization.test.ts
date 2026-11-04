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
    // A (member of Docs) to Q (member of Site): the chain A, M, Q has 3 agents. The chain along the
    // channels, A, D, S, Q, has 4, so the main agent is the first agent.
    expect(firstOnPath(model, "A", "Q")?.id).toBe("M")
    // With no main agent, the chain goes along the channels: D leads a channel of A.
    const noMain = { ...model, mainAgentId: null }
    expect(firstOnPath(noMain, "A", "Q")?.id).toBe("D")
    // Up the tree: Q to A goes by S, the lead of a channel of Q, when there is no main agent
    // (Q, S, D, A). With the main agent, the chain Q, M, A has 3 agents, so M is first.
    expect(firstOnPath(noMain, "Q", "A")?.id).toBe("S")
    expect(firstOnPath(model, "Q", "A")?.id).toBe("M")
    // D (lead of Docs) to Q: S (lead of the sub-channel) and the main agent give a chain of the same
    // length. S leads no channel of D, so the main agent comes first.
    expect(firstOnPath(model, "D", "Q")?.id).toBe("M")
    expect(firstOnPath(noMain, "D", "Q")?.id).toBe("S")
  })

  test("an archived receiver: no chain, so no agent can pass it on", () => {
    const model = org({ agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "P")) })
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

  test("a lead on the path: A of Docs to P of Product gives D", () => {
    // A to D (rule 1), D to P (rule 4). The chain A, M, P has the same length, and D leads Docs.
    const r = refusal(org(), "A", "P")
    expect(r?.next).toEqual({ id: "D", name: "D" })
    expect(handOffRefusalText("P", r?.next?.name ?? null)).toBe(
      "P is not on your path. Send it to D.",
    )
  })

  test("a tie of the lead and the main agent: the lead comes first, also when its name is later", () => {
    // Bo (member of Docs, lead Zed) to Cy (member of Site, lead Zed): by Zed or by the main agent
    // Ada. Zed leads a channel of Bo, so Zed comes before Ada, though "Ada" is first by name.
    const model = named(["Ada", "Zed", "Bo", "Cy"], {
      channels: [
        channel("Docs", { lead: "Zed", members: ["Zed", "Bo"] }),
        channel("Site", { lead: null, members: ["Zed", "Cy"] }),
      ],
      mainAgentId: "Ada",
    })
    expect(firstOnPath(model, "Bo", "Cy")?.id).toBe("Zed")
  })

  test("a tie of the main agent and a plain member: the main agent comes first, not the name", () => {
    // Same setup, but Zed leads no channel. Zoe is the main agent; Abe is a plain member of Docs
    // and of Site. Abe comes first by name, but the main agent comes before the other agents.
    const model = named(["Zoe", "Abe", "Bo", "Cy"], {
      channels: [
        channel("Docs", { lead: null, members: ["Abe", "Bo"] }),
        channel("Site", { lead: null, members: ["Abe", "Cy"] }),
      ],
      mainAgentId: "Zoe",
    })
    expect(firstOnPath(model, "Bo", "Cy")?.id).toBe("Zoe")
  })

  test("a tie of two plain members: the order of the names, ignoring case", () => {
    // Bob and alice are plain members of a channel of the sender, and both are in a channel with
    // the receiver. There is no main agent. By case, "Bob" < "alice"; ignoring case, alice first.
    const model = named(["Sam", "Bob", "alice", "Zed"], {
      channels: [
        channel("One", { lead: null, members: ["Sam", "Bob", "alice"] }),
        channel("Two", { lead: null, members: ["Bob", "alice", "Zed"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "Sam", "Zed")?.id).toBe("alice")
  })

  test("a tie of a lead of a channel of the sender and plain members: the lead, though it sorts last", () => {
    const model = named(["Sam", "Ann", "Bea", "Zoe", "Zed"], {
      channels: [
        channel("One", { lead: "Zoe", members: ["Zoe", "Sam", "Ann", "Bea"] }),
        channel("Two", { lead: null, members: ["Ann", "Bea", "Zoe", "Zed"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "Sam", "Zed")?.id).toBe("Zoe")
  })

  test("a chain through a fellow member only: no main agent, no lead", () => {
    // A and B share Docs; B and Z share Other. B is the only way, and not a lead.
    const model = named(["A", "B", "Z"], {
      channels: [
        channel("Docs", { lead: null, members: ["A", "B"] }),
        channel("Other", { lead: null, members: ["B", "Z"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "A", "Z")).toEqual({ id: "B", name: "B" })
    expect(refusal(model, "A", "Z")?.next).toEqual({ id: "B", name: "B" })
  })

  test("a chain of more than 3 agents goes along the channels, by the lead of the channel of the sender", () => {
    // A, D, P, E: A and D share Docs; D leads Docs under Product; P leads Product; E is in Product.
    const model = named(["A", "D", "P", "E"], {
      channels: [
        channel("Product", { lead: "P", members: ["P", "E"] }),
        channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product" }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "A", "E")?.id).toBe("D")
  })

  test("the shortest chain wins, whatever the names", () => {
    // Bob has a longer way to Z (by Y); Carl has a shorter one. By name Bob is first.
    const model = named(["Sam", "Bob", "Carl", "Y", "Z"], {
      channels: [
        channel("One", { lead: null, members: ["Sam", "Bob", "Carl"] }),
        channel("Two", { lead: null, members: ["Bob", "Y"] }),
        channel("Three", { lead: null, members: ["Y", "Z"] }),
        channel("Four", { lead: null, members: ["Carl", "Z"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "Sam", "Z")?.id).toBe("Carl")
  })

  test("no chain: no main agent and no channel links the two", () => {
    const model = named(["A", "B", "Y", "Z"], {
      channels: [
        channel("Docs", { lead: null, members: ["A", "B"] }),
        channel("Other", { lead: null, members: ["Y", "Z"] }),
      ],
      mainAgentId: null,
    })
    expect(firstOnPath(model, "A", "Z")).toBeNull()
    const r = refusal(model, "A", "Z")
    expect(r?.next).toBeNull()
    expect(handOffRefusalText("Z", r?.next?.name ?? null)).toBe(
      "Z is not on your path, and no agent can pass it on. Tell the user.",
    )
    // An agent in no channel has no chain either.
    expect(firstOnPath(org({ mainAgentId: null }), "X", "A")).toBeNull()
  })

  test("an archived channel and an archived main agent leave no chain", () => {
    const model = org({
      agents: ["M", "P", "D", "A", "X"].map((id) => agent(id, id === "M")),
      channels: [
        channel("Product", { lead: "P", members: ["P"] }),
        channel("Docs", { lead: "D", members: ["D", "A"], parent: "Product", archived: true }),
      ],
    })
    expect(firstOnPath(model, "A", "P")).toBeNull()
  })

  test("an unrelated channel: the chain passes the main agent", () => {
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
