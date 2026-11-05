import { describe, expect, test } from "bun:test"
import type { SettingsAccount } from "./agentSettings.ts"
import { faceFromName } from "./agents.ts"
import { describeAgent, MAKE_AGENT_ARGS, planMakeAgent } from "./manage.ts"

const accounts: SettingsAccount[] = [
  {
    id: "oa",
    name: "OpenAI",
    models: [
      { id: "gpt-5", label: "GPT-5", efforts: ["low", "medium", "high"] },
      { id: "gpt-5-mini", label: "GPT-5 mini", efforts: [] },
    ],
  },
  {
    id: "an",
    name: "Anthropic",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: ["low", "high"] },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", efforts: [] },
      { id: "claude-3-5-haiku-latest", label: "Claude Haiku 3.5", efforts: [] },
    ],
  },
]

const effortsOf = (accountId: string, model: string) =>
  accounts.find((a) => a.id === accountId)?.models.find((m) => m.id === model)?.efforts ?? []

const plan = (args: Record<string, unknown>, taken: string[] = []) =>
  planMakeAgent(args, accounts, (n) => taken.includes(n.toLowerCase()), effortsOf)

const request = (args: Record<string, unknown>) => {
  const result = plan(args)
  if (result.kind !== "request") throw new Error(`expected a request, got: ${result.reason}`)
  return result
}

const reason = (args: Record<string, unknown>, taken: string[] = []) => {
  const result = plan(args, taken)
  if (result.kind !== "refused") throw new Error("expected a refusal")
  return result.reason
}

describe("planMakeAgent (spec 037, Make an agent)", () => {
  test("a name, a role, instructions and a model make a request", () => {
    const { create } = request({
      name: "Rita",
      role: "Reviewer",
      instructions: "Read the diff.",
      model: "GPT-5",
    })
    expect(create).toEqual({
      name: "Rita",
      role: "Reviewer",
      instructions: "Read the diff.",
      face: faceFromName("Rita"),
      model: { accountId: "oa", model: "gpt-5", effort: "medium" },
    })
  })

  test("the effort starts at Medium when the model offers it, as in the form of a new agent", () => {
    expect(request({ name: "Rita", model: "gpt-5" }).create.model.effort).toBe("medium")
    expect(request({ name: "Rita", model: "Sonnet" }).create.model.effort).toBeNull()
    expect(request({ name: "Rita", model: "gpt-5", effort: "high" }).create.model.effort).toBe(
      "high",
    )
  })

  test("the face follows the name until the caller gives a shape or a hue", () => {
    expect(
      request({ name: "Rita", model: "gpt-5", face_shape: 2, face_hue: 3 }).create.face,
    ).toEqual({ shape: 1, hue: 2 })
    expect(request({ name: "Rita", model: "gpt-5", face_hue: 4 }).create.face).toEqual({
      shape: faceFromName("Rita").shape,
      hue: 3,
    })
  })

  test("the detail for the card holds every value in full, also a long text", () => {
    const instructions = `${"Check every line. ".repeat(500)}End.`
    const { detail } = request({ name: "Rita", role: "Reviewer", instructions, model: "gpt-5" })
    for (const part of ["Rita", "Reviewer", "OpenAI", "gpt-5", instructions])
      expect(detail).toContain(part)
  })

  test("a call without a name or without a model makes no request, and says what to give", () => {
    expect(reason({ model: "gpt-5" })).toContain("name")
    expect(reason({ name: "Rita" })).toContain("model")
    expect(reason({ name: "Rita" })).toContain("claude-sonnet-4-5")
  })

  test("the checks of the form hold: a taken name, a long role, a model in doubt", () => {
    expect(reason({ name: "Ada", model: "gpt-5" }, ["ada"])).toContain("Another agent")
    expect(reason({ name: "Rita", role: "x".repeat(121), model: "gpt-5" })).toContain("role")
    expect(reason({ name: "Rita", model: "haiku" })).toContain("More than one model")
  })

  test("a refusal says that nothing was made", () => {
    expect(reason({ name: "Rita", model: "gemini" })).toStartWith("Nothing made.")
  })

  test("a field that the tool does not have makes no request", () => {
    for (const field of ["permission", "workspace", "language", "memory", "nonsense"])
      expect(reason({ name: "Rita", model: "gpt-5", [field]: "x" })).toContain(field)
    expect(MAKE_AGENT_ARGS).not.toContain("permission")
  })
})

describe("describeAgent (spec 037, Read an agent)", () => {
  test("it gives the fields in full and nothing else of the agent", () => {
    const text = describeAgent(
      {
        name: "Bo",
        role: "Tester",
        instructions: "Run the tests. ".repeat(100),
        face: { shape: 1, hue: 2 },
        model: { accountId: "oa", model: "gpt-5", effort: "low" },
      },
      accounts,
    )
    for (const part of ["Bo", "Tester", "gpt-5", "OpenAI", "effort: low", "shape 2, hue 3"])
      expect(text).toContain(part)
    expect(text).toContain("Run the tests. ".repeat(100))
    expect(text).not.toContain("workspace")
    expect(text).not.toContain("permission")
  })

  test("an agent with no model and no role reads as such", () => {
    const text = describeAgent(
      { name: "Bo", role: "", instructions: "", face: { shape: 0, hue: 0 }, model: null },
      accounts,
    )
    expect(text).toContain("- role: (none)")
    expect(text).toContain("- model: none")
  })
})
