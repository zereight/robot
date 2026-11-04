import { describe, expect, test } from "bun:test"
import {
  changeSummary,
  describeSettings,
  matchAccount,
  matchModels,
  PROTECTED_PLACES,
  planSettings,
  type SettingsAccount,
  type SettingsCurrent,
} from "./agentSettings.ts"

const accounts: SettingsAccount[] = [
  {
    id: "oa",
    name: "OpenAI",
    models: [
      { id: "gpt-5", label: "GPT-5", efforts: ["low", "medium", "high"] },
      { id: "gpt-5-mini", label: "GPT-5 mini", efforts: [] },
      { id: "o3-mini", label: "o3-mini", efforts: [] },
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

const current: SettingsCurrent = {
  name: "Ada",
  role: "Helper",
  instructions: "Be brief.",
  face: { shape: 0, hue: 2 },
  model: { accountId: "oa", model: "gpt-5", effort: "low" },
  app: {
    language: "system",
    theme: "dark",
    textSize: "default",
    compactPlaces: false,
    reduceMotion: "system",
  },
}

const effortsOf = (accountId: string, model: string) =>
  accounts.find((a) => a.id === accountId)?.models.find((m) => m.id === model)?.efforts ?? []
const plan = (args: Record<string, unknown>, taken: string[] = []) =>
  planSettings(args, current, accounts, (n) => taken.includes(n.toLowerCase()), effortsOf)

describe("loose model names (spec 002)", () => {
  test("one word that one model holds matches it", () => {
    expect(matchModels("Sonnet", accounts).map((m) => m.model.id)).toEqual(["claude-sonnet-4-5"])
    expect(matchModels("sonnet 4.5", accounts).map((m) => m.model.id)).toEqual([
      "claude-sonnet-4-5",
    ])
    expect(matchModels("the newest Sonnet model", accounts)).toHaveLength(1)
  })

  test("a name that equals the id or the label of a model wins over a longer one", () => {
    expect(matchModels("gpt-5", accounts).map((m) => m.model.id)).toEqual(["gpt-5"])
    expect(matchModels("GPT-5 mini", accounts).map((m) => m.model.id)).toEqual(["gpt-5-mini"])
  })

  test("several matches and no match come back as they are", () => {
    expect(matchModels("haiku", accounts)).toHaveLength(2)
    expect(matchModels("the newest GPT", accounts)).toHaveLength(2)
    expect(matchModels("gemini", accounts)).toHaveLength(0)
    expect(matchModels("the newest", accounts)).toHaveLength(0)
  })

  test("an account is found by its name, ignoring case", () => {
    expect(matchAccount("anthropic", accounts)?.id).toBe("an")
    expect(matchAccount("open", accounts)?.id).toBe("oa")
    expect(matchAccount("mistral", accounts)).toBeUndefined()
  })
})

describe("a call of the settings tool", () => {
  test("with no field it reads, and the text has the values and the choices", () => {
    expect(plan({})).toEqual({ kind: "read" })
    expect(plan({ name: null })).toEqual({ kind: "read" })
    const text = describeSettings(current, accounts)
    expect(text).toContain('- model: gpt-5 on the account "OpenAI", effort: low')
    expect(text).toContain("claude-sonnet-4-5 (Claude Sonnet 4.5), effort: low, high")
    expect(text).toContain("- theme: dark (system, dark, light)")
    expect(text).toContain("The permission level: the user changes it in the profile")
  })

  test("a loose model name changes the model, and keeps an effort only when the model takes it", () => {
    expect(plan({ model: "Sonnet" })).toEqual({
      kind: "changes",
      changes: [
        {
          field: "model",
          before: { accountId: "oa", model: "gpt-5", effort: "low" },
          after: { accountId: "an", model: "claude-sonnet-4-5", effort: "low" },
        },
      ],
    })
    const mini = plan({ model: "o3-mini" })
    expect(mini.kind === "changes" && mini.changes[0]?.after).toEqual({
      accountId: "oa",
      model: "o3-mini",
      effort: null,
    })
  })

  test("a model that lacks the level of the agent gets the nearest level, the lower one on a tie", () => {
    const medium = { ...current, model: { accountId: "oa", model: "gpt-5", effort: "medium" } }
    const sonnet = planSettings({ model: "Sonnet" }, medium, accounts, () => false, effortsOf)
    // Sonnet lists low and high: both are one step from medium, so the lower one is used.
    expect(sonnet.kind === "changes" && sonnet.changes[0]?.after).toEqual({
      accountId: "an",
      model: "claude-sonnet-4-5",
      effort: "low",
    })
  })

  test("several or no matching models change nothing, and the agent gets the list", () => {
    const several = plan({ model: "haiku" })
    expect(several.kind).toBe("refused")
    expect(several.kind === "refused" && several.reason).toContain("More than one model matches")
    expect(several.kind === "refused" && several.reason).toContain("claude-haiku-5-5")
    expect(several.kind === "refused" && several.reason).not.toContain("gpt-5")
    const none = plan({ model: "gemini" })
    expect(none.kind === "refused" && none.reason).toContain("No connected model matches")
    expect(none.kind === "refused" && none.reason).toContain("gpt-5-mini")
  })

  test("the Teams link is a thing the agent may not change, and the reason says where", () => {
    for (const name of ["teams", "teams_link", "link", "bridge"]) {
      const refused = plan({ [name]: false })
      expect(refused.kind).toBe("refused")
      expect(refused.kind === "refused" && refused.reason).toContain("Nothing changed")
      expect(refused.kind === "refused" && refused.reason).toContain("Settings → Teams")
    }
    // The text that the agent reads when it asks what it may not change names the link too.
    expect(PROTECTED_PLACES.teams).toContain("Settings → Teams")
  })

  test("the effort must be a level of the model", () => {
    expect(plan({ effort: "high" })).toMatchObject({
      kind: "changes",
      changes: [{ field: "model", after: { model: "gpt-5", effort: "high" } }],
    })
    expect(plan({ effort: "max" })).toMatchObject({ kind: "refused" })
    expect(plan({ model: "o3-mini", effort: "high" })).toMatchObject({ kind: "refused" })
  })

  test("only an account keeps the model when the account has it", () => {
    expect(plan({ account: "Anthropic" })).toMatchObject({ kind: "refused" })
    expect(plan({ account: "Anthropic", model: "haiku 5.5" })).toMatchObject({
      kind: "changes",
      changes: [{ field: "model", after: { accountId: "an", model: "claude-haiku-5-5" } }],
    })
    expect(plan({ account: "Mistral", model: "x" })).toMatchObject({ kind: "refused" })
  })

  test("the checks of the profile form apply to the name and the role", () => {
    expect(plan({ name: "" })).toMatchObject({ kind: "refused" })
    expect(plan({ name: "x".repeat(41) })).toMatchObject({ kind: "refused" })
    expect(plan({ name: "Bo" }, ["bo"])).toMatchObject({ kind: "refused" })
    expect(plan({ name: "  Ava  " })).toEqual({
      kind: "changes",
      changes: [{ field: "name", before: "Ada", after: "Ava" }],
    })
    expect(plan({ role: "x".repeat(121) })).toMatchObject({ kind: "refused" })
  })

  test("the face takes a shape from 1 to 6 and a hue from 1 to 10", () => {
    expect(plan({ face_shape: 6 })).toEqual({
      kind: "changes",
      changes: [{ field: "face", before: { shape: 0, hue: 2 }, after: { shape: 5, hue: 2 } }],
    })
    expect(plan({ face_shape: 7 })).toMatchObject({ kind: "refused" })
    expect(plan({ face_hue: 0 })).toMatchObject({ kind: "refused" })
  })

  test("the app settings change with their allowed values only", () => {
    expect(plan({ theme: "light", compact_place_list: true })).toEqual({
      kind: "changes",
      changes: [
        { field: "theme", before: "dark", after: "light" },
        { field: "compactPlaces", before: false, after: true },
      ],
    })
    expect(plan({ theme: "pink" })).toMatchObject({ kind: "refused" })
    expect(plan({ language: "ko", text_size: "large", reduce_motion: "on" })).toMatchObject({
      kind: "changes",
    })
    expect(plan({ theme: "dark" })).toEqual({ kind: "unchanged" })
  })

  test("a protected field refuses the whole call and says where the user changes it", () => {
    const level = plan({ permission: "full", name: "Ava" })
    expect(level.kind).toBe("refused")
    expect(level.kind === "refused" && level.reason).toContain("in the profile of the agent")
    const many = plan({ workspace: "/tmp", sync: true, skills: [] })
    expect(many.kind === "refused" && many.reason).toContain("workspace folder")
    expect(many.kind === "refused" && many.reason).toContain("Settings → Devices")
    expect(many.kind === "refused" && many.reason).toContain("Settings → Skills")
    expect(plan({ agent_id: "other", name: "x" })).toMatchObject({ kind: "refused" })
    expect(plan({ colour: "red" })).toMatchObject({ kind: "refused" })
  })

  test("the summary of a change names each field, and the new instructions", () => {
    expect(
      changeSummary([
        {
          field: "model",
          before: { accountId: "a", model: "m1", effort: null },
          after: { accountId: "a", model: "m2", effort: "high" },
        },
        { field: "instructions", before: "Old", after: "Answer in Korean." },
        { field: "compactPlaces", before: false, after: true },
      ]),
    ).toBe("model: m1 → m2 (high); instructions: Answer in Korean.; compactPlaces: off → on")
  })
})
