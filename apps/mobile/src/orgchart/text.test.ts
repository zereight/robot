import { describe, expect, test } from "bun:test"
import { type Locale, translate } from "../i18n/index.ts"
import type { OrgAgentRow, OrgBlock } from "./list.ts"
import {
  agentLabel,
  agentStateText,
  blockLabel,
  blockLine,
  blockName,
  countsText,
  handoffLabel,
  membersText,
  moreLabel,
  type Translate,
} from "./text.ts"

const tr =
  (locale: Locale): Translate =>
  (key, params) =>
    translate(locale, key, params)
const en = tr("en")
const ko = tr("ko")

const row = (extra: Partial<OrgAgentRow> = {}): OrgAgentRow => ({
  key: "c:x/a",
  agentId: "a",
  name: "Ada",
  role: "Writer",
  face: { shape: 0, hue: 0 },
  state: "idle",
  label: null,
  isLead: false,
  ...extra,
})
const block = (extra: Partial<OrgBlock> = {}): OrgBlock => ({
  key: "c:x",
  channelId: "x",
  name: "Docs",
  memberCount: 5,
  counts: [
    { state: "working", count: 2 },
    { state: "idle", count: 3 },
  ],
  rows: [],
  more: [],
  level: 1,
  ...extra,
})

describe("the words of the screen Org chart", () => {
  test("the line under a block: the members and the counts by state", () => {
    expect(countsText(en, block().counts)).toBe("2 working · 3 idle")
    expect(blockLine(en, block())).toBe("5 members · 2 working · 3 idle")
    expect(blockLine(ko, block())).toBe("멤버 5명 · 작업 중 2 · 대기 3")
    expect(membersText(en, 1)).toBe("1 member")
    expect(blockLine(en, block({ memberCount: 1, counts: [{ state: "waiting", count: 1 }] }))).toBe(
      "1 member · 1 waiting for you",
    )
  })

  test('the block "No channel" takes its name from the catalogue', () => {
    expect(blockName(en, block({ channelId: null, name: "" }))).toBe("No channel")
    expect(blockName(ko, block({ channelId: null, name: "" }))).toBe("채널 없음")
    expect(blockName(en, block())).toBe("Docs")
  })

  test("the accessible name of an agent row: name, role, state, mark, task", () => {
    expect(
      agentLabel(en, row({ state: "working", isLead: true, label: "Draft the release notes" })),
    ).toBe("Ada, Writer, Working, Lead, Draft the release notes")
    expect(agentLabel(en, row({ role: "" }))).toBe("Ada, Idle")
    expect(agentLabel(en, row({ state: "waiting", label: "Delete it" }), "main")).toBe(
      "Ada, Writer, Waiting for you, Main agent, Delete it",
    )
    expect(agentLabel(ko, row({ state: "offline" }))).toBe("Ada, Writer, 오프라인")
  })

  test("the states have words in both languages", () => {
    for (const state of ["working", "waiting", "idle", "offline"] as const) {
      expect(agentStateText(en, state)).not.toBe(agentStateText(ko, state))
    }
  })

  test('the accessible name of a block header and of the row "+n more"', () => {
    expect(blockLabel(en, block())).toBe("Docs, 5 members · 2 working · 3 idle")
    expect(moreLabel(en, block({ more: [{} as never, {} as never, {} as never] }))).toBe(
      "3 more members of Docs",
    )
    expect(moreLabel(ko, block({ channelId: null, name: "", more: [{} as never] }))).toBe(
      "채널 없음의 다른 멤버 1명",
    )
  })

  test("the accessible name of a hand-off row", () => {
    const h = { key: "h:1", from: "Ada", to: "Bo", count: 3 }
    expect(handoffLabel(en, h)).toBe("Ada handed 3 tasks to Bo in the last 7 days.")
    expect(handoffLabel(en, { ...h, count: 1 })).toBe("Ada handed 1 task to Bo in the last 7 days.")
    expect(handoffLabel(ko, { ...h, count: 1 })).toBe(
      "Ada가 최근 7일간 Bo에게 작업 1개를 넘겼어요.",
    )
  })
})
