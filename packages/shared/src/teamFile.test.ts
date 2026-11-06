import { describe, expect, test } from "bun:test"
import {
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
})

describe("planTeam", () => {
  const skills = [{ agents: [0, 1] }, { agents: [2] }, { agents: [1] }]
  const plan = (made: number[], over: Partial<Parameters<typeof planTeam>[0]> = {}) =>
    planTeam({
      skills,
      made: (i) => made.includes(i),
      skillPicks: [0, 1, 2],
      skillRoom: 100,
      ...over,
    })

  test("makes every part when every agent is made", () => {
    const result = plan([0, 1, 2])
    expect(result.skills.map((s) => s.agents)).toEqual([[0, 1], [2], [1]])
    expect(result.skipped).toEqual([])
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
    const result = plan([0, 1, 2], { skillPicks: [] })
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
    skills: [{ name: "Summarise" }, { name: "Review" }],
  } as unknown as Parameters<typeof skippedNotImported>[1]

  test("names the skill and the reason", () => {
    expect(
      skippedNotImported(
        [
          { kind: "skill", index: 0, reason: "skill_no_agent" },
          { kind: "skill", index: 1, reason: "skills_full" },
        ],
        preview,
      ),
    ).toEqual([
      { reason: "skill_no_agent", owner: "Summarise" },
      { reason: "skills_full", owner: "Review" },
    ])
  })
})

describe("ticks", () => {
  test("skills start ticked, the handbook does not; a hidden secret is not ticked", () => {
    const ticks = startTeamTicks({
      skills: [{ secretRemoved: false }, { secretRemoved: true }],
    } as unknown as Parameters<typeof startTeamTicks>[0])
    expect(ticks).toEqual({ skills: [true, false], handbook: false })
    expect(tickedPlaces(ticks.skills)).toEqual([0])
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
