import { describe, expect, test } from "bun:test"
import {
  channelsForFile,
  HANDBOOK_PREVIEW_CHARS,
  HANDBOOK_PREVIEW_LINES,
  handbookPreview,
  planTeam,
  skillsForFile,
  skippedNotImported,
  startTeamTicks,
  tickedPlaces,
} from "./teamFile.ts"

const picked = (...ids: string[]) => new Set(ids)

describe("channelsForFile", () => {
  const all = [
    { id: "c1", memberIds: ["a", "b"] },
    { id: "c2", memberIds: ["a", "b", "c"] },
    { id: "c3", memberIds: ["b"] },
    { id: "c4", memberIds: [] },
  ]

  test("holds the channels whose members are all among the picked agents", () => {
    expect(channelsForFile(all, picked("a", "b")).map((c) => c.id)).toEqual(["c1", "c3"])
    expect(channelsForFile(all, picked("a", "b", "c")).map((c) => c.id)).toEqual(["c1", "c2", "c3"])
  })

  test("holds no channel for no picked agent, and none that has no member", () => {
    expect(channelsForFile(all, picked())).toEqual([])
    expect(channelsForFile(all, picked("a", "b", "c")).some((c) => c.id === "c4")).toBe(false)
  })
})

describe("skillsForFile", () => {
  const all = [
    { id: "everyone", agentIds: null },
    { id: "ada", agentIds: ["a"] },
    { id: "bob-cy", agentIds: ["b", "c"] },
    { id: "gone", agentIds: ["z"] },
  ]

  test("holds each skill that a picked agent may use, and the skills for all agents", () => {
    expect(skillsForFile(all, picked("a")).map((s) => s.id)).toEqual(["everyone", "ada"])
    expect(skillsForFile(all, picked("c")).map((s) => s.id)).toEqual(["everyone", "bob-cy"])
  })

  test("holds nothing when no agent is picked", () => {
    expect(skillsForFile(all, picked())).toEqual([])
  })

  test("holds a skill that a picked agent may use only through a channel", () => {
    const channelSkill = { id: "notes", agentIds: [] as string[], channelIds: ["product"] }
    const giving = new Map<string, readonly string[]>([["a", ["docs", "product"]]])
    expect(skillsForFile([...all, channelSkill], picked("a"), giving).map((s) => s.id)).toEqual([
      "everyone",
      "ada",
      "notes",
    ])
    expect(skillsForFile([...all, channelSkill], picked("b"), giving).map((s) => s.id)).toEqual([
      "everyone",
      "bob-cy",
    ])
  })
})

describe("planTeam", () => {
  const channels = [
    { members: [0, 1], lead: 1 },
    { members: [2], lead: 2 },
    { members: [0, 2], lead: 2 },
  ]
  const skills = [{ agents: [0, 1] }, { agents: [2] }, { agents: [1] }]
  const plan = (made: number[], over: Partial<Parameters<typeof planTeam>[0]> = {}) =>
    planTeam({
      channels,
      skills,
      made: (i) => made.includes(i),
      channelPicks: [0, 1, 2],
      skillPicks: [0, 1, 2],
      skillRoom: 100,
      ...over,
    })

  test("makes every part when every agent is made", () => {
    const result = plan([0, 1, 2])
    expect(result.channels.map((c) => c.index)).toEqual([0, 1, 2])
    expect(result.channels[0]).toEqual({ index: 0, members: [0, 1], lead: 1 })
    expect(result.skills.map((s) => s.agents)).toEqual([[0, 1], [2], [1]])
    expect(result.skipped).toEqual([])
  })

  test("a channel is made without a member that is not made; a lead that is not made leaves none", () => {
    const result = plan([0])
    expect(result.channels).toEqual([
      { index: 0, members: [0], lead: null },
      { index: 2, members: [0], lead: null },
    ])
  })

  test("a channel with no member left is not made", () => {
    expect(plan([0]).skipped).toContainEqual({ kind: "channel", index: 1 })
  })

  test("a skill is made for the agents that are made; with none it is not made", () => {
    const result = plan([1])
    expect(result.skills).toEqual([
      { index: 0, agents: [1] },
      { index: 2, agents: [1] },
    ])
    expect(result.skipped).toContainEqual({ kind: "skill", index: 1, reason: "skill_no_agent" })
  })

  test("a part that is not ticked is not looked at", () => {
    const result = plan([0, 1, 2], { channelPicks: [1], skillPicks: [] })
    expect(result.channels.map((c) => c.index)).toEqual([1])
    expect(result.skills).toEqual([])
    expect(result.skipped).toEqual([])
  })

  test("the skills over the room are not made; the first ones in the file are", () => {
    const result = plan([0, 1, 2], { skillRoom: 2 })
    expect(result.skills.map((s) => s.index)).toEqual([0, 1])
    expect(result.skipped).toEqual([{ kind: "skill", index: 2, reason: "skills_full" }])
    expect(plan([0, 1, 2], { skillRoom: 0 }).skills).toEqual([])
  })

  test("a skill with no agent made does not use the room", () => {
    const result = plan([1], { skillRoom: 2 })
    expect(result.skills.map((s) => s.index)).toEqual([0, 2])
  })
})

describe("skippedNotImported", () => {
  const preview = {
    channels: [{ name: "Launch" }],
    skills: [{ name: "Summarise" }, { name: "Review" }],
  } as unknown as Parameters<typeof skippedNotImported>[1]

  test("names the channel or the skill and the reason", () => {
    expect(
      skippedNotImported(
        [
          { kind: "channel", index: 0 },
          { kind: "skill", index: 0, reason: "skill_no_agent" },
          { kind: "skill", index: 1, reason: "skills_full" },
        ],
        preview,
      ),
    ).toEqual([
      { reason: "channel_no_member", owner: "Launch" },
      { reason: "skill_no_agent", owner: "Summarise" },
      { reason: "skills_full", owner: "Review" },
    ])
  })
})

describe("ticks", () => {
  test("channels and skills start ticked, the handbook does not; a hidden secret is not ticked", () => {
    const ticks = startTeamTicks({
      channels: [{ secretRemoved: false }, { secretRemoved: true }],
      skills: [{ secretRemoved: false }],
    } as unknown as Parameters<typeof startTeamTicks>[0])
    expect(ticks).toEqual({ channels: [true, false], skills: [true], handbook: false })
    expect(tickedPlaces(ticks.channels)).toEqual([0])
  })
})

describe("handbookPreview", () => {
  test("a short handbook is shown whole", () => {
    expect(handbookPreview("Answer in Korean.\n")).toEqual({
      text: "Answer in Korean.",
      more: false,
    })
  })

  test("a long handbook shows its first lines only", () => {
    const text = Array.from({ length: HANDBOOK_PREVIEW_LINES + 3 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    )
    const result = handbookPreview(text)
    expect(result.more).toBe(true)
    expect(result.text.split("\n")).toHaveLength(HANDBOOK_PREVIEW_LINES)
    expect(result.text.startsWith("Line 1\nLine 2")).toBe(true)
  })

  test("one very long line is cut", () => {
    const result = handbookPreview("x".repeat(HANDBOOK_PREVIEW_CHARS + 50))
    expect(result.more).toBe(true)
    expect([...result.text]).toHaveLength(HANDBOOK_PREVIEW_CHARS)
  })
})
