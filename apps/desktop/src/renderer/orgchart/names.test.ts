import { describe, expect, test } from "bun:test"
import {
  buildChart,
  type ChartAgent,
  catalogues,
  EMPTY_ORG_SNAPSHOT,
  type Locale,
  type MessageKey,
  type OrgAgent,
} from "@robot/shared"
import {
  agentLabel,
  countsLine,
  handoffTip,
  moreLabel,
  moreWord,
  orgLabel,
  orgTitle,
  outcomeLine,
  type Translate,
} from "./names.ts"

const tIn =
  (locale: Locale): Translate =>
  (key: MessageKey, params) =>
    catalogues[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
      params && name in params ? String(params[name]) : whole,
    )
const en = tIn("en")
const ko = tIn("ko")

const agent = (id: string, extra: Partial<OrgAgent> = {}): OrgAgent => ({
  id,
  name: id,
  role: `${id} role`,
  face: { shape: 0, hue: 0 },
  state: "idle",
  task: null,
  ...extra,
})

const model = buildChart({
  ...EMPTY_ORG_SNAPSHOT,
  agents: [
    agent("Ada", {
      state: "working",
      task: { label: "Draft the release notes", state: "running" },
    }),
    agent("Bob"),
    agent("Cy", { state: "waiting", task: { label: "Approve a step", state: "waiting" } }),
    agent("Di", { state: "offline" }),
    agent("Loose"),
  ],
  orgs: [
    {
      id: "docs",
      name: "Docs",
      createdAt: 1,
      leadId: "Ada",
      memberIds: ["Ada", "Bob", "Cy", "Di"],
      parentId: null,
    },
    { id: "ops", name: "Ops", createdAt: 2, leadId: null, memberIds: ["Bob"], parentId: null },
  ],
  handoffs: [
    { from: "Ada", to: "Bob", count: 3, newest: 5 },
    { from: "Bob", to: "Ada", count: 1, newest: 6 },
    { from: "Cy", to: "Ada", count: 2, newest: 7 },
  ],
})
const docs = model.orgs[0]
const none = model.orgs[2]
const adaInDocs = docs?.nodes[0]

describe("the counts of an organization node", () => {
  test("they follow the order working, waiting for you, idle, offline, and skip zeros", () => {
    expect(countsLine(en, docs?.counts as never)).toBe(
      "1 working · 1 waiting for you · 1 idle · 1 offline",
    )
    expect(countsLine(en, model.orgs[1]?.counts as never)).toBe("1 idle")
  })

  test("they are Korean in the Korean interface", () => {
    expect(countsLine(ko, docs?.counts as never)).toBe(
      "작업 중 1 · 확인 대기 1 · 대기 1 · 오프라인 1",
    )
  })
})

describe("the outcome line of an organization node", () => {
  const outcomeModel = buildChart({
    ...EMPTY_ORG_SNAPSHOT,
    agents: [agent("Ada"), agent("Bob")],
    orgs: [
      {
        id: "docs",
        name: "Docs",
        createdAt: 1,
        leadId: "Ada",
        memberIds: ["Ada", "Bob"],
        parentId: null,
      },
      { id: "ops", name: "Ops", createdAt: 2, leadId: null, memberIds: ["Bob"], parentId: null },
    ],
    outcomes: [
      { agentId: "Ada", done: 12, blocked: 2, met: 9, notMet: 1 },
      { agentId: "Bob", done: 0, blocked: 0, met: 0, notMet: 0 },
    ],
  })

  test("it gives done, blocked, met and not met, and skips a zero", () => {
    expect(outcomeLine(en, outcomeModel.orgs[0]?.outcome as never)).toBe(
      "12 done · 2 blocked · 9 met · 1 not met",
    )
  })

  test("a node with no task of the window shows no line", () => {
    expect(outcomeLine(en, outcomeModel.orgs[1]?.outcome as never)).toBe("")
  })

  test("it is Korean in the Korean interface", () => {
    expect(outcomeLine(ko, outcomeModel.orgs[0]?.outcome as never)).toBe(
      "완료 12 · 막힘 2 · 충족 9 · 미충족 1",
    )
  })

  test("the accessible name of the node holds the outcome", () => {
    expect(orgLabel(en, outcomeModel.orgs[0] as never)).toBe(
      "Docs. 2 members. 2 idle. 12 done, 2 blocked, 9 met, 1 not met",
    )
  })
})

describe("the accessible name of an agent node", () => {
  test("it gives the name, role line, state, Lead, task label and the other organizations", () => {
    expect(adaInDocs?.name).toBe("Ada")
    expect(agentLabel(en, adaInDocs as never)).toBe(
      "Ada. Ada role. Working. Lead. Draft the release notes. Handed work to 1 agent. Got work from 2 agents",
    )
  })

  test("a copy says where the other copies are", () => {
    const bobInDocs = docs?.nodes.find((n) => n.name === "Bob")
    expect(agentLabel(en, bobInDocs as never)).toBe(
      "Bob. Bob role. Idle. Also in Ops. Handed work to 1 agent. Got work from 1 agent",
    )
  })

  test("a waiting agent says that it waits for the user, with its label", () => {
    const cy = docs?.nodes.find((n) => n.name === "Cy")
    expect(agentLabel(en, cy as never)).toBe(
      "Cy. Cy role. Waiting for you. Approve a step. Handed work to 1 agent",
    )
  })

  test("an agent with no hand-off has no such words, and an empty role line is left out", () => {
    const loose = none?.nodes[0] as ChartAgent
    expect(agentLabel(en, { ...loose, role: "" })).toBe("Loose. Idle")
  })

  test("it is Korean in the Korean interface, and the names of the user stay", () => {
    const text = agentLabel(ko, adaInDocs as never)
    expect(text).toContain("Ada")
    expect(text).toContain("Draft the release notes")
    expect(text).toContain("리드")
    expect(text).toContain("작업 중")
    expect(text).toContain("1명에게 작업을 넘겼어요")
    expect(text).toContain("2명에게서 작업을 받았어요")
    expect(text).not.toMatch(/Lead|Working|Handed/)
  })
})

describe("the accessible name of an organization node", () => {
  test("it gives the name, the number of members and the counts", () => {
    expect(orgLabel(en, docs as never)).toBe(
      "Docs. 4 members. 1 working, 1 waiting for you, 1 idle, 1 offline",
    )
    expect(orgLabel(en, model.orgs[1] as never)).toBe("Ops. 1 member. 1 idle")
  })

  test("the node 'No organization' takes its name from the catalogue", () => {
    expect(orgTitle(en, none as never)).toBe("No organization")
    expect(orgTitle(ko, none as never)).toBe("조직 없음")
    expect(orgLabel(ko, none as never)).toContain("조직 없음")
  })

  test("an organization node with no member still has a name with the number 0", () => {
    const empty = buildChart({
      ...EMPTY_ORG_SNAPSHOT,
      orgs: [{ id: "e", name: "Empty", createdAt: 1, leadId: null, memberIds: [], parentId: null }],
    }).orgs[0]
    expect(orgLabel(en, empty as never)).toBe("Empty. 0 members")
    expect(en("orgchart.noMembers")).toBe("No members.")
    expect(ko("orgchart.noMembers")).toBe("멤버가 없어요.")
  })

  test("the tile '+<n> more' reads the number and the name of the organization node", () => {
    const wide = buildChart({
      ...EMPTY_ORG_SNAPSHOT,
      agents: Array.from({ length: 15 }, (_, i) => agent(`m${String(i).padStart(2, "0")}`)),
      orgs: [
        {
          id: "big",
          name: "Big",
          createdAt: 1,
          leadId: null,
          memberIds: Array.from({ length: 15 }, (_, i) => `m${String(i).padStart(2, "0")}`),
          parentId: null,
        },
      ],
    })
    const big = wide.orgs[0]
    expect(moreWord(en, big?.more.length ?? 0)).toBe("+3 more")
    expect(moreLabel(en, big as never)).toContain("3 more members of Big")
    expect(moreWord(ko, 3)).toBe("+3명 더")
  })
})

describe("the text on a hand-off line", () => {
  const line = (count: number) =>
    ({
      id: "h",
      kind: "handoff",
      from: "a",
      to: "b",
      count,
      fromName: "Ada",
      toName: "Bob",
    }) as const

  test("it names the sender, the number and the receiver", () => {
    expect(handoffTip(en, line(3))).toBe("Ada handed 3 tasks to Bob in the last 7 days.")
    expect(handoffTip(en, line(1))).toBe("Ada handed 1 task to Bob in the last 7 days.")
  })

  test("it is Korean in the Korean interface", () => {
    expect(handoffTip(ko, line(3))).toContain("Ada")
    expect(handoffTip(ko, line(3))).toContain("작업 3개")
  })
})

describe("the catalogue of the page", () => {
  test("the words that the chart avoids are not in the texts of the page", () => {
    const words = /\b(boss|manager|employee|hire|hired|report to|reports to)\b/i
    for (const [key, text] of Object.entries(catalogues.en)) {
      if (key.startsWith("orgchart.") || key === "page.orgchart")
        expect({ key, hit: words.test(text) }).toEqual({ key, hit: false })
    }
  })

  test("every key has a Korean text with the same placeholders", () => {
    for (const key of Object.keys(catalogues.en)) {
      if (!key.startsWith("orgchart.") && key !== "page.orgchart") continue
      const k = key as MessageKey
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      expect(names(catalogues.ko[k]), key).toEqual(names(catalogues.en[k]))
    }
  })
})
