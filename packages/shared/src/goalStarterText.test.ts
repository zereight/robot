import { describe, expect, test } from "bun:test"
import { AGENT_NAME_MAX, AGENT_ROLE_MAX, charLength } from "./agents.ts"
import { CHANNEL_NAME_MAX, CHANNEL_TOPIC_MAX } from "./channels.ts"
import { GOAL_STARTERS } from "./goalStarters.ts"
import { agentStarterOf, channelPlan, goalRow, isChannelStarter } from "./goalStarterText.ts"

describe("goal starter text", () => {
  test("the Product starter has PM as lead and five members, in both languages", () => {
    for (const locale of ["en", "ko"] as const) {
      const plan = channelPlan(locale, "product")
      expect(plan.lead).toBe(0)
      expect(plan.agents).toHaveLength(6)
      expect(plan.agents.map((a) => a.name)[0]).toBe("PM")
    }
    expect(channelPlan("en", "product").agents.map((a) => a.name)).toEqual([
      "PM",
      "Planner",
      "Designer",
      "Developer",
      "QA",
      "Reviewer",
    ])
  })
  test("the Reviewer of Product is the Reviewer agent starter", () => {
    const reviewer = channelPlan("en", "product").agents[5]
    expect(reviewer?.role).toBe("Reads code changes and reports problems.")
  })
  test("every channel starter is within the limits of a channel and an agent", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const id of GOAL_STARTERS.filter(isChannelStarter)) {
        const plan = channelPlan(locale, id)
        expect(charLength(plan.name)).toBeLessThanOrEqual(CHANNEL_NAME_MAX)
        expect(charLength(plan.topic)).toBeLessThanOrEqual(CHANNEL_TOPIC_MAX)
        expect(plan.agents.length).toBeGreaterThanOrEqual(2)
        expect(plan.agents.length).toBeLessThanOrEqual(6)
        for (const a of plan.agents) {
          expect(charLength(a.name)).toBeLessThanOrEqual(AGENT_NAME_MAX)
          expect(charLength(a.role)).toBeLessThanOrEqual(AGENT_ROLE_MAX)
          expect(a.instructions.length).toBeGreaterThan(0)
        }
      }
    }
  })
  test("rows say how many agents a channel makes", () => {
    expect(goalRow("en", "files").muted).toBe("2 agents")
    expect(goalRow("ko", "product").muted).toBe("에이전트 6명")
    expect(agentStarterOf("files")).toBeNull()
    expect(agentStarterOf("briefer")).toBe("briefer")
  })
})
