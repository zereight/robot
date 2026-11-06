import { describe, expect, test } from "bun:test"
import {
  clipGoal,
  GOAL_STARTERS,
  GOAL_TEXT_MAX,
  recommend,
  SAVED_STARTER_MAX,
  savedStarterProblems,
} from "./goalStarters.ts"

const agent = (name: string) => ({ name, role: "Does a job.", instructions: "" })

describe("recommend", () => {
  test("lists nine starters in the fixed order", () => {
    expect([...GOAL_STARTERS]).toEqual([
      "assistant",
      "briefer",
      "researcher",
      "reviewer",
      "organizer",
      "research",
      "codeReview",
      "files",
      "product",
    ])
  })
  test.each([
    ["compare sources for my report", ["researcher:2", "research:1"]],
    ["review my code changes", ["reviewer:2", "codeReview:1"]],
    ["폴더 정리해줘", ["organizer:2", "files:2"]],
    ["다운로드 폴더 정리", ["files:3", "organizer:2"]],
    ["encode a video", []],
    ["   ", []],
    ["ship the new feature next sprint", ["product:3"]],
    ["기능 출시 일정 기획", ["product:3"]],
    ["review code file folder compare sources", ["researcher:2", "reviewer:2", "organizer:2"]],
    ["plan a trip to Japan", []],
    ["여행 계획 짜줘", []],
  ])("%s", (goal, want) => {
    expect(recommend(goal).map((r) => `${r.id}:${r.score}`)).toEqual(want)
  })
})

describe("goal text", () => {
  test("is cut at 300 characters", () => {
    expect([...clipGoal("a".repeat(320))].length).toBe(GOAL_TEXT_MAX)
  })
})

describe("saved starter", () => {
  const ok = {
    name: "Mobile squad",
    topic: "Ship the app",
    lead: 0,
    agents: [agent("PM"), agent("QA")],
  }
  test("accepts a good one", () => {
    expect(savedStarterProblems(ok)).toEqual([])
  })
  test("refuses a blank name, one agent, a bad lead and a long field", () => {
    expect(savedStarterProblems({ ...ok, name: "  " })).toContain("name")
    expect(savedStarterProblems({ ...ok, agents: [agent("PM")] })).toContain("agents")
    expect(savedStarterProblems({ ...ok, lead: 2 })).toContain("lead")
    expect(savedStarterProblems({ ...ok, topic: "t".repeat(201) })).toContain("topic")
    expect(savedStarterProblems({ ...ok, agents: [agent("x".repeat(41)), agent("QA")] })).toContain(
      "agentName",
    )
    expect(
      savedStarterProblems({
        ...ok,
        agents: [{ ...agent("PM"), role: "r".repeat(121) }, agent("QA")],
      }),
    ).toContain("agentRole")
  })
  test("refuses more than nine agents", () => {
    const many = Array.from({ length: 10 }, (_, i) => agent(`A${i}`))
    expect(savedStarterProblems({ ...ok, agents: many })).toContain("agents")
  })
  test("keeps at most 20", () => {
    expect(SAVED_STARTER_MAX).toBe(20)
  })
})
